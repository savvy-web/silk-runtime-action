// src/services/turbo-cache/handler.ts
import { BlobStore } from "@savvy-web/github-action-effects";
import { Effect, Option } from "effect";
import { decodeArtifact, encodeArtifact } from "./codec.js";

/** A normalized inbound request to the turbo cache server. */
export interface TurboRequest {
	readonly method: string;
	readonly path: string;
	readonly authorization: string | undefined;
	readonly artifactTag: string | undefined;
	readonly body: Uint8Array;
}

/** A response to write back. */
export interface TurboResponse {
	readonly status: number;
	readonly headers: Record<string, string>;
	readonly body?: Uint8Array;
}

const json = (status: number, obj: unknown): TurboResponse => ({
	status,
	headers: { "content-type": "application/json" },
	body: new TextEncoder().encode(JSON.stringify(obj)),
});

/**
 * Build a handler implementing Turbo's remote-cache contract over a BlobStore.
 * Artifacts are stored under `${prefix}${hash}`; the artifact signature tag is
 * framed alongside the body via the codec and echoed on GET.
 */
export const makeTurboHandler =
	(opts: { prefix: string; expectedToken: string }) =>
	(req: TurboRequest): Effect.Effect<TurboResponse, never, BlobStore> =>
		Effect.gen(function* () {
			const pathname = req.path.split("?")[0] ?? req.path;
			if (pathname === "/v8/artifacts/status") return json(200, { status: "enabled" });
			if (pathname === "/v8/artifacts/events") return json(200, []);

			const match = pathname.match(/^\/v8\/artifacts\/([^/]+)$/);
			if (!match) return { status: 404, headers: {} };

			const bearer = req.authorization?.replace(/^Bearer\s+/i, "");
			if (opts.expectedToken !== "" && bearer !== opts.expectedToken) return { status: 401, headers: {} };

			const key = `${opts.prefix}${match[1]}`;
			const store = yield* BlobStore;

			if (req.method === "PUT") {
				yield* store.put(key, encodeArtifact(req.artifactTag ?? null, req.body));
				return { status: 202, headers: {} };
			}
			if (req.method === "HEAD") {
				return { status: (yield* store.has(key)) ? 200 : 404, headers: {} };
			}
			if (req.method === "GET") {
				const blob = yield* store.get(key);
				if (Option.isNone(blob)) return { status: 404, headers: {} };
				const { tag, body } = decodeArtifact(blob.value);
				const headers: Record<string, string> = { "content-type": "application/octet-stream" };
				if (tag) headers["x-artifact-tag"] = tag;
				return { status: 200, headers, body };
			}
			return { status: 405, headers: {} };
		}).pipe(Effect.catchAll(() => Effect.succeed<TurboResponse>({ status: 500, headers: {} })));
