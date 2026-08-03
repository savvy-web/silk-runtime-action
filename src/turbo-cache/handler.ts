import type { BlobEnvelopeError, BlobStoreError } from "@effected/github-actions";
import { BlobStore } from "@effected/github-actions";
import { Effect, Option } from "effect";

import { TurboArtifactMeta, clampDurationMs } from "./meta.js";

/** A normalized inbound request to the turbo cache server. */
export interface TurboRequest {
	readonly method: string;
	readonly path: string;
	readonly authorization: string | undefined;
	readonly artifactTag: string | undefined;
	/** Turbo's `x-artifact-duration` (artifact generation time in ms). */
	readonly artifactDuration: number;
	readonly body: Uint8Array;
}

/** A response to write back. */
export interface TurboResponse {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly body?: Uint8Array;
}

/** How the handler is configured for the life of a server. */
export interface TurboHandlerOptions {
	/** Key namespace, so one backend can hold several caches. */
	readonly prefix: string;
	/**
	 * The bearer token every authenticated route requires. **Empty disables
	 * authentication** — see {@link makeTurboHandler}.
	 */
	readonly expectedToken: string;
	/**
	 * Called with a store failure on its way to becoming a 500.
	 *
	 * @remarks
	 * Ruling 70's seam. The GitHub backend captures `ACTIONS_RUNTIME_TOKEN` when
	 * the server starts, and on a long job that token can expire before the last
	 * cache write — which surfaces as a `refused` with a 401 and, without this,
	 * as nothing but a silent 500 in turbo's own output. The handler has no
	 * logger and does not know which backend it is over, so it hands the typed
	 * failure to the worker, which does.
	 *
	 * An unreadable envelope never arrives here: that is a miss (see the GET
	 * route), not a backend problem, and reporting it would make the worker's
	 * warning fire on a stale cache entry.
	 */
	readonly onStoreFailure?: (error: BlobStoreError | BlobEnvelopeError) => void;
}

/** The readiness probe, and the one route that is never authenticated. */
const STATUS_PATH = "/v8/artifacts/status";

/** Turbo's telemetry sink, which this server accepts and discards. */
const EVENTS_PATH = "/v8/artifacts/events";

/** Everything after this is the artifact hash. */
const ARTIFACT_PATH = "/v8/artifacts/";

const NOT_FOUND: TurboResponse = { status: 404, headers: {} };

const json = (status: number, value: unknown): TurboResponse => ({
	status,
	headers: { "content-type": "application/json" },
	body: new TextEncoder().encode(JSON.stringify(value)),
});

/**
 * The path with turbo's query string removed.
 *
 * @remarks
 * Every request carries `?teamId=…&slug=…` (oracle 17); routing is on the path
 * alone and no route reads a parameter.
 */
const pathnameOf = (path: string): string => {
	const query = path.indexOf("?");
	return query === -1 ? path : path.slice(0, query);
};

/**
 * The artifact hash a path names, or `null` when it names something else.
 *
 * @remarks
 * v1's `^\/v8\/artifacts\/([^/]+)$` spelled out: the segment must be present
 * and must not contain a separator, so `/v8/artifacts/` and
 * `/v8/artifacts/a/b` are both unroutable.
 */
const artifactHash = (pathname: string): string | null => {
	if (!pathname.startsWith(ARTIFACT_PATH)) return null;
	const hash = pathname.slice(ARTIFACT_PATH.length);
	return hash === "" || hash.includes("/") ? null : hash;
};

/**
 * Whether a request carries the expected bearer token.
 *
 * @remarks
 * The prefix is optional and case-insensitive, matching v1's
 * `replace(/^Bearer\s+/i, "")` — a client that sends the bare token is
 * accepted. An empty `expectedToken` authorizes everything (quirk 72).
 */
const authorized = (req: TurboRequest, expectedToken: string): boolean =>
	expectedToken === "" || req.authorization?.replace(/^Bearer\s+/i, "") === expectedToken;

/**
 * The key an artifact is stored under.
 *
 * @remarks
 * Ruling 79 normalizes the separator v1 left out: v1 concatenated the prefix
 * onto the hash, so prefix `p` wrote `phash…` and two namespaces whose prefixes
 * were substrings of one another shared entries. A prefix that already ends in
 * `/` is left alone.
 *
 * There is no `v2/` version segment any more — the envelope carries the format
 * version in-band (oracle 65), so keys stay stable across format changes and a
 * blob written by an older layout reads back as a typed decode failure rather
 * than as a mis-sliced artifact.
 */
const artifactKey = (prefix: string, hash: string): string =>
	prefix === "" || prefix.endsWith("/") ? `${prefix}${hash}` : `${prefix}/${hash}`;

/**
 * Builds a handler implementing Turbo's remote-cache contract over a
 * `BlobStore`.
 *
 * @remarks
 * Routes, in order (oracle 18), with ruling 73's one change:
 *
 * | path | methods | answer |
 * | --- | --- | --- |
 * | `/v8/artifacts/status` | any | `200 {"status":"enabled"}`, **open** |
 * | `/v8/artifacts/events` | any | `200 []`, authenticated |
 * | `/v8/artifacts/:hash` | `PUT` | `202` |
 * | | `HEAD` | `200` / `404` |
 * | | `GET` | `200` + body / `404` |
 * | | other | `405` |
 * | anything else | any | `404` |
 *
 * `/status` stays open because it is the readiness probe the spawning action
 * polls before it has anything to authenticate with; `/events` is turbo-client
 * traffic and is authed, where v1 left it open. Authentication happens **after**
 * the route match, so an unroutable path is a 404 rather than a 401 — v1's
 * order, kept because it tells a misconfigured client which of the two things
 * is wrong.
 *
 * A GET answers 404 for a miss **and** for a blob whose envelope will not
 * decode into {@link TurboArtifactMeta} — a pre-envelope blob, a newer
 * revision, a truncated frame. Corrupt is a miss (ruling 65): turbo rebuilds,
 * where a decoded-anyway artifact would be served as if it were real. Every
 * other failure collapses to a bare 500 (oracle 25), because there is nothing
 * turbo does with a message.
 */
export const makeTurboHandler =
	(opts: TurboHandlerOptions) =>
	(req: TurboRequest): Effect.Effect<TurboResponse, never, BlobStore> =>
		Effect.gen(function* () {
			const pathname = pathnameOf(req.path);
			if (pathname === STATUS_PATH) return json(200, { status: "enabled" });

			const unauthorized: TurboResponse = { status: 401, headers: {} };
			if (pathname === EVENTS_PATH) {
				return authorized(req, opts.expectedToken) ? json(200, []) : unauthorized;
			}

			const hash = artifactHash(pathname);
			if (hash === null) return NOT_FOUND;
			if (!authorized(req, opts.expectedToken)) return unauthorized;

			const key = artifactKey(opts.prefix, hash);
			const store = yield* BlobStore;

			if (req.method === "PUT") {
				const metadata = TurboArtifactMeta.make({
					tag: req.artifactTag ?? null,
					durationMs: clampDurationMs(req.artifactDuration),
				});
				yield* store.put(key, { metadata, body: req.body }, TurboArtifactMeta);
				return { status: 202, headers: {} };
			}
			if (req.method === "HEAD") {
				return { status: (yield* store.has(key)) ? 200 : 404, headers: {} };
			}
			if (req.method === "GET") {
				const blob = yield* store
					.get(key, TurboArtifactMeta)
					.pipe(Effect.catchTag("BlobEnvelopeError", () => Effect.succeedNone));
				if (Option.isNone(blob)) return NOT_FOUND;

				const { tag, durationMs } = blob.value.metadata;
				const headers: Record<string, string> = {
					"content-type": "application/octet-stream",
					"x-artifact-duration": String(durationMs),
				};
				// Quirk 80: an empty tag is dropped rather than echoed back empty.
				if (tag) headers["x-artifact-tag"] = tag;
				return { status: 200, headers, body: blob.value.body };
			}
			return { status: 405, headers: {} };
		}).pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					opts.onStoreFailure?.(error);
					return { status: 500, headers: {} } satisfies TurboResponse;
				}),
			),
		);
