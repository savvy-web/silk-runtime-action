import { describe, expect, it } from "@effect/vitest";
import type { BlobEnvelopeError, BlobStoreShape } from "@effected/github-actions";
import { BlobStore, BlobStoreError } from "@effected/github-actions";
import type { Layer } from "effect";
import { Effect, Schema } from "effect";

import type { TurboRequest, TurboResponse } from "../../../src/turbo-cache/handler.js";
import { makeTurboHandler } from "../../../src/turbo-cache/handler.js";
import { TurboArtifactMeta } from "../../../src/turbo-cache/meta.js";

/** The token every authed case presents. */
const TOKEN = "run-token";

/** A request with only what a case cares about spelled out. */
const request = (overrides: Partial<TurboRequest>): TurboRequest => ({
	method: "GET",
	path: "/v8/artifacts/hash1",
	authorization: `Bearer ${TOKEN}`,
	artifactTag: undefined,
	artifactDuration: 0,
	body: new Uint8Array(0),
	...overrides,
});

/**
 * Runs one request through a handler over the real in-memory store.
 *
 * @remarks
 * `layerMemory` is not a double: it runs the real `BlobEnvelope` encode and
 * decode, so a PUT/GET pair here proves the metadata survives storage the same
 * way it does over S3 or the Actions cache.
 */
const overMemory = (
	requests: ReadonlyArray<TurboRequest>,
	opts: { prefix?: string; expectedToken?: string } = {},
): Promise<ReadonlyArray<TurboResponse>> => {
	const handler = makeTurboHandler({ prefix: opts.prefix ?? "", expectedToken: opts.expectedToken ?? TOKEN });
	return Effect.forEach(requests, handler).pipe(Effect.provide(BlobStore.layerMemory), Effect.runPromise);
};

/** One request through a handler over a supplied store. */
const overStore = (
	store: Layer.Layer<BlobStore>,
	req: TurboRequest,
	opts: { prefix?: string; expectedToken?: string; onStoreFailure?: (error: unknown) => void } = {},
): Promise<TurboResponse> =>
	makeTurboHandler({
		prefix: opts.prefix ?? "",
		expectedToken: opts.expectedToken ?? TOKEN,
		...(opts.onStoreFailure ? { onStoreFailure: opts.onStoreFailure } : {}),
	})(req).pipe(Effect.provide(store), Effect.runPromise);

/** A store that records the keys it is asked for and answers as a miss. */
const recordingStore = (keys: Array<string>): Layer.Layer<BlobStore> =>
	BlobStore.layerTest({
		put: ((key: string) => Effect.sync(() => void keys.push(key))) as BlobStoreShape["put"],
		has: (key: string) =>
			Effect.sync(() => {
				keys.push(key);
				return false;
			}),
	});

describe("makeTurboHandler routes", () => {
	it("answers the status probe without authentication", async () => {
		const [status] = await overMemory([request({ path: "/v8/artifacts/status", authorization: undefined })]);

		expect(status?.status).toBe(200);
		expect(status?.headers).toEqual({ "content-type": "application/json" });
		expect(new TextDecoder().decode(status?.body)).toBe(JSON.stringify({ status: "enabled" }));
	});

	it("strips the query string turbo appends", async () => {
		// Turbo appends `?teamId=…&slug=…` to every request (oracle 17).
		const [status] = await overMemory([
			request({ path: "/v8/artifacts/status?teamId=team_x&slug=x", authorization: undefined }),
		]);

		expect(status?.status).toBe(200);
	});

	it("answers events with an empty array when authenticated", async () => {
		const [events] = await overMemory([request({ path: "/v8/artifacts/events", method: "POST" })]);

		expect(events?.status).toBe(200);
		expect(new TextDecoder().decode(events?.body)).toBe("[]");
	});

	it("refuses events without the token", async () => {
		// Ruling 73: `/events` is turbo-client-only, so it is authed — unlike
		// `/status`, which is the readiness probe and stays open.
		const [events] = await overMemory([request({ path: "/v8/artifacts/events", authorization: undefined })]);

		expect(events?.status).toBe(401);
	});

	it("is a 404 for an unknown path", async () => {
		const [unknown] = await overMemory([request({ path: "/v9/artifacts/hash1" })]);

		expect(unknown).toEqual({ status: 404, headers: {} });
	});

	it("is a 404 for an unknown path before it checks the token", async () => {
		// Auth comes *after* the route match (oracle 20): an unroutable path is a
		// 404 whether or not the caller could have authenticated.
		const [unknown] = await overMemory([request({ path: "/", authorization: undefined })]);

		expect(unknown?.status).toBe(404);
	});

	it("is a 404 for an artifact path with no hash", async () => {
		const [empty] = await overMemory([request({ path: "/v8/artifacts/" })]);

		expect(empty?.status).toBe(404);
	});

	it("is a 404 for an artifact path with a nested hash", async () => {
		const [nested] = await overMemory([request({ path: "/v8/artifacts/a/b" })]);

		expect(nested?.status).toBe(404);
	});

	it("is a 404 for a relative-segment hash", async () => {
		// A hash is a digest; `.` and `..` would otherwise reach the backend key
		// as `<prefix>/..`.
		const [dot, dotdot] = await overMemory([
			request({ path: "/v8/artifacts/." }),
			request({ path: "/v8/artifacts/.." }),
		]);

		expect(dot?.status).toBe(404);
		expect(dotdot?.status).toBe(404);
	});

	it("is a 405 for a method it does not implement", async () => {
		const [other] = await overMemory([request({ method: "DELETE" })]);

		expect(other).toEqual({ status: 405, headers: {} });
	});
});

describe("makeTurboHandler authentication", () => {
	it("refuses a mismatched token", async () => {
		const [get] = await overMemory([request({ authorization: "Bearer wrong" })]);

		expect(get).toEqual({ status: 401, headers: {} });
	});

	it("refuses a missing authorization header", async () => {
		const [get] = await overMemory([request({ authorization: undefined })]);

		expect(get?.status).toBe(401);
	});

	it("accepts the bearer prefix in any case", async () => {
		const [get] = await overMemory([request({ authorization: `bearer ${TOKEN}` })]);

		expect(get?.status).toBe(404);
	});

	it("accepts a bare token with no bearer prefix", async () => {
		const [get] = await overMemory([request({ authorization: TOKEN })]);

		expect(get?.status).toBe(404);
	});

	it("accepts anything when no token is expected", async () => {
		// Quirk 72 kept at this boundary: an empty `expectedToken` disables
		// authentication. Ruling 72 moves the posture fix to the worker, which
		// refuses to boot without a token, so this branch is unreachable in a real
		// run — the handler stays permissive so a test can exercise it.
		const [get] = await overMemory([request({ authorization: undefined })], { expectedToken: "" });

		expect(get?.status).toBe(404);
	});
});

describe("makeTurboHandler artifacts", () => {
	it("stores a PUT and answers 202", async () => {
		const [put] = await overMemory([request({ method: "PUT", body: new Uint8Array([1, 2, 3]) })]);

		expect(put).toEqual({ status: 202, headers: {} });
	});

	it("serves back what a PUT stored", async () => {
		const body = new Uint8Array([9, 8, 7]);
		const [, get] = await overMemory([
			request({ method: "PUT", body, artifactTag: "signature", artifactDuration: 1250 }),
			request({ method: "GET" }),
		]);

		expect(get?.status).toBe(200);
		expect(get?.body).toEqual(body);
		expect(get?.headers).toEqual({
			"content-type": "application/octet-stream",
			"x-artifact-duration": "1250",
			"x-artifact-tag": "signature",
		});
	});

	it("always sends a duration header", async () => {
		const [, get] = await overMemory([request({ method: "PUT" }), request({ method: "GET" })]);

		expect(get?.headers["x-artifact-duration"]).toBe("0");
	});

	it("omits the tag header when no tag was sent", async () => {
		const [, get] = await overMemory([request({ method: "PUT" }), request({ method: "GET" })]);

		expect(get?.headers["x-artifact-tag"]).toBeUndefined();
	});

	it("omits the tag header when the tag was empty", async () => {
		// Quirk 80, kept: an empty tag is dropped by truthiness rather than echoed
		// back as `x-artifact-tag: `.
		const [, get] = await overMemory([request({ method: "PUT", artifactTag: "" }), request({ method: "GET" })]);

		expect(get?.headers["x-artifact-tag"]).toBeUndefined();
	});

	it("clamps the stored duration", async () => {
		const [, get] = await overMemory([
			request({ method: "PUT", artifactDuration: -1250.9 }),
			request({ method: "GET" }),
		]);

		expect(get?.headers["x-artifact-duration"]).toBe("0");
	});

	it("answers HEAD from presence", async () => {
		const [head1, , head2] = await overMemory([
			request({ method: "HEAD" }),
			request({ method: "PUT" }),
			request({ method: "HEAD" }),
		]);

		expect(head1?.status).toBe(404);
		expect(head2).toEqual({ status: 200, headers: {} });
	});

	it("is a 404 on a miss", async () => {
		const [get] = await overMemory([request({ method: "GET" })]);

		expect(get).toEqual({ status: 404, headers: {} });
	});

	it("is a 404 on a blob it cannot read as its own metadata", async () => {
		// Corrupt is a miss (ruling 65): a `BlobEnvelopeError` — a pre-envelope
		// blob, a newer revision, a truncated frame, or metadata from another
		// schema, as here — must never reach turbo as a decoded artifact.
		const foreign = Schema.Struct({ unrelated: Schema.String });
		const store = BlobStore.layerMemory;
		const seeded = Effect.gen(function* () {
			const blobs = yield* BlobStore;
			yield* blobs.put("hash1", { metadata: { unrelated: "x" }, body: new Uint8Array([1]) }, foreign);
			return yield* makeTurboHandler({ prefix: "", expectedToken: TOKEN })(request({ method: "GET" }));
		});

		expect(await Effect.runPromise(seeded.pipe(Effect.provide(store)))).toEqual({ status: 404, headers: {} });
	});
});

describe("makeTurboHandler keys", () => {
	it("stores under the bare hash when there is no prefix", async () => {
		const keys: Array<string> = [];
		await overStore(recordingStore(keys), request({ method: "PUT" }));

		expect(keys).toEqual(["hash1"]);
	});

	it("separates a prefix from the hash with a slash", async () => {
		// Ruling 79, a deviation from v1's naive concat: `p` + `hash1` was
		// `phash1`, which silently merged two namespaces whose prefixes were
		// substrings of one another.
		const keys: Array<string> = [];
		await overStore(recordingStore(keys), request({ method: "PUT" }), { prefix: "p" });

		expect(keys).toEqual(["p/hash1"]);
	});

	it("leaves a prefix that already ends in a slash alone", async () => {
		const keys: Array<string> = [];
		await overStore(recordingStore(keys), request({ method: "HEAD" }), { prefix: "p/" });

		expect(keys).toEqual(["p/hash1"]);
	});

	it("reads back what the same prefix wrote", async () => {
		const [, get] = await overMemory([request({ method: "PUT" }), request({ method: "GET" })], { prefix: "team-a" });

		expect(get?.status).toBe(200);
	});

	it("does not read across prefixes", async () => {
		const handlerA = makeTurboHandler({ prefix: "team-a", expectedToken: TOKEN });
		const handlerB = makeTurboHandler({ prefix: "team-b", expectedToken: TOKEN });
		const crossed = Effect.gen(function* () {
			yield* handlerA(request({ method: "PUT" }));
			return yield* handlerB(request({ method: "GET" }));
		});

		expect(await Effect.runPromise(crossed.pipe(Effect.provide(BlobStore.layerMemory)))).toEqual({
			status: 404,
			headers: {},
		});
	});
});

describe("makeTurboHandler failures", () => {
	/** A store whose every read fails the way an expired runtime token does. */
	const refusing = BlobStore.layerTest({
		get: () => Effect.fail(new BlobStoreError({ reason: "refused", status: 401 })),
	});

	it("collapses a store failure to a bare 500", async () => {
		expect(await overStore(refusing, request({ method: "GET" }))).toEqual({ status: 500, headers: {} });
	});

	it("hands the store failure to its caller", async () => {
		// Ruling 70's seam: the handler cannot log (it has no logger and no
		// backend identity), so the worker gets the typed failure and decides
		// whether it looks like the runtime token expiring mid-job.
		const seen: Array<unknown> = [];
		await overStore(refusing, request({ method: "GET" }), { onStoreFailure: (error) => void seen.push(error) });

		expect(seen).toHaveLength(1);
		expect((seen[0] as BlobStoreError).reason).toBe("refused");
		expect((seen[0] as BlobStoreError).status).toBe(401);
	});

	it("collapses a failing PUT to a 500", async () => {
		const failing = BlobStore.layerTest({
			put: () => Effect.fail(new BlobStoreError({ reason: "unreachable" })),
		});

		expect(await overStore(failing, request({ method: "PUT" }))).toEqual({ status: 500, headers: {} });
	});

	it("collapses a failing HEAD to a 500", async () => {
		const failing = BlobStore.layerTest({
			has: () => Effect.fail(new BlobStoreError({ reason: "unreachable" })),
		});

		expect(await overStore(failing, request({ method: "HEAD" }))).toEqual({ status: 500, headers: {} });
	});

	it("keeps the envelope failure off the caller's hands", async () => {
		const seen: Array<BlobEnvelopeError | BlobStoreError> = [];
		const foreign = Schema.Struct({ unrelated: Schema.String });
		const program = Effect.gen(function* () {
			const blobs = yield* BlobStore;
			yield* blobs.put("hash1", { metadata: { unrelated: "x" }, body: new Uint8Array([1]) }, foreign);
			return yield* makeTurboHandler({
				prefix: "",
				expectedToken: TOKEN,
				onStoreFailure: (error) => void seen.push(error),
			})(request({ method: "GET" }));
		});
		const response = await Effect.runPromise(program.pipe(Effect.provide(BlobStore.layerMemory)));

		expect(response.status).toBe(404);
		expect(seen).toEqual([]);
	});
});

describe("makeTurboHandler metadata", () => {
	it("stores the tag and duration as its own metadata schema", async () => {
		const stored: Array<unknown> = [];
		const store = BlobStore.layerTest({
			put: ((_key: string, blob: { metadata: unknown }) =>
				Effect.sync(() => void stored.push(blob.metadata))) as BlobStoreShape["put"],
		});
		await overStore(store, request({ method: "PUT", artifactTag: "sig", artifactDuration: 12.9 }));

		expect(stored).toEqual([TurboArtifactMeta.make({ tag: "sig", durationMs: 12 })]);
	});

	it("stores an absent tag as null", async () => {
		const stored: Array<unknown> = [];
		const store = BlobStore.layerTest({
			put: ((_key: string, blob: { metadata: unknown }) =>
				Effect.sync(() => void stored.push(blob.metadata))) as BlobStoreShape["put"],
		});
		await overStore(store, request({ method: "PUT" }));

		expect(stored).toEqual([TurboArtifactMeta.make({ tag: null, durationMs: 0 })]);
	});
});
