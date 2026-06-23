import { BlobStoreTest } from "@savvy-web/github-action-effects/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { TurboRequest } from "./handler.js";
import { makeTurboHandler } from "./handler.js";

const run = (state: ReturnType<typeof BlobStoreTest.empty>, req: TurboRequest) =>
	Effect.runPromise(
		makeTurboHandler({ prefix: "p/", expectedToken: "tok" })(req).pipe(Effect.provide(BlobStoreTest.layer(state))),
	);

const req = (over: Partial<TurboRequest>): TurboRequest => ({
	method: "GET",
	path: "/",
	authorization: "Bearer tok",
	artifactTag: undefined,
	artifactDuration: 0,
	body: new Uint8Array(),
	...over,
});

describe("makeTurboHandler", () => {
	it("reports status enabled", async () => {
		const r = await run(BlobStoreTest.empty(), req({ method: "GET", path: "/v8/artifacts/status" }));
		expect(r.status).toBe(200);
		expect(JSON.parse(new TextDecoder().decode(r.body))).toEqual({ status: "enabled" });
	});

	it("accepts events with 200", async () => {
		const r = await run(BlobStoreTest.empty(), req({ method: "POST", path: "/v8/artifacts/events" }));
		expect(r.status).toBe(200);
	});

	it("401s on a bad bearer token", async () => {
		const r = await run(BlobStoreTest.empty(), req({ path: "/v8/artifacts/abc", authorization: "Bearer wrong" }));
		expect(r.status).toBe(401);
	});

	it("PUT then GET round-trips body, tag, and duration under the versioned prefixed key", async () => {
		const state = BlobStoreTest.empty();
		const put = await run(
			state,
			req({
				method: "PUT",
				path: "/v8/artifacts/h1",
				artifactTag: "sig",
				artifactDuration: 1980,
				body: new Uint8Array([7, 8, 9]),
			}),
		);
		expect(put.status).toBe(202);
		// key is namespaced by the artifact frame version (avoids reading old-format blobs)
		expect(state.entries.has("p/v2/h1")).toBe(true);

		const get = await run(state, req({ method: "GET", path: "/v8/artifacts/h1" }));
		expect(get.status).toBe(200);
		expect(get.headers["x-artifact-tag"]).toBe("sig");
		// x-artifact-duration must round-trip so Turbo computes a real timeSaved on remote hits
		expect(get.headers["x-artifact-duration"]).toBe("1980");
		expect(get.body).toEqual(new Uint8Array([7, 8, 9]));
	});

	it("GET 404s on a miss", async () => {
		const r = await run(BlobStoreTest.empty(), req({ method: "GET", path: "/v8/artifacts/missing" }));
		expect(r.status).toBe(404);
	});

	it("HEAD reflects existence", async () => {
		const state = BlobStoreTest.empty();
		await run(state, req({ method: "PUT", path: "/v8/artifacts/h2", body: new Uint8Array([1]) }));
		const head = await run(state, req({ method: "HEAD", path: "/v8/artifacts/h2" }));
		expect(head.status).toBe(200);
		const miss = await run(state, req({ method: "HEAD", path: "/v8/artifacts/none" }));
		expect(miss.status).toBe(404);
	});
});
