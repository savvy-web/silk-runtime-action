import { assert, describe, it } from "@effect/vitest";

import {
	SERVER_LOG_PREFIX,
	accessLine,
	accessOutcome,
	formatAccessTally,
	tallyAccessLog,
} from "../../../src/turbo-cache/access-log.js";
import type { TurboRequest, TurboResponse } from "../../../src/turbo-cache/handler.js";

const request = (method: string, path: string, body: Uint8Array = new Uint8Array()): TurboRequest => ({
	method,
	path,
	authorization: "Bearer secret-token",
	artifactTag: undefined,
	artifactDuration: 0,
	body,
});

const response = (status: number, body?: Uint8Array): TurboResponse =>
	body === undefined ? { status, headers: {} } : { status, headers: {}, body };

describe("accessOutcome", () => {
	it("names a restore, a miss and an upload", () => {
		assert.strictEqual(accessOutcome("GET", 200), "hit");
		assert.strictEqual(accessOutcome("GET", 404), "miss");
		assert.strictEqual(accessOutcome("PUT", 202), "stored");
	});

	it("keeps an existence check apart from a restore", () => {
		// A HEAD is turbo asking before it uploads; counting it as a hit would
		// overstate what the cache served.
		assert.strictEqual(accessOutcome("HEAD", 200), "exists");
		assert.strictEqual(accessOutcome("HEAD", 404), "absent");
	});

	it("names a refused credential and a backend failure whatever the method", () => {
		for (const method of ["GET", "HEAD", "PUT"]) {
			assert.strictEqual(accessOutcome(method, 401), "unauthorized");
			assert.strictEqual(accessOutcome(method, 500), "error");
		}
	});

	it("calls everything else rejected", () => {
		assert.strictEqual(accessOutcome("DELETE", 405), "rejected");
		assert.strictEqual(accessOutcome("PUT", 200), "rejected");
	});
});

describe("accessLine", () => {
	it("reports a hit with the artifact's size and the time it took", () => {
		const line = accessLine(
			request("GET", "/v8/artifacts/abc123?teamId=t&slug=s"),
			response(200, new Uint8Array(2048)),
			12.4,
		);
		assert.strictEqual(line, "GET abc123 200 hit 2.0 kB 12ms");
	});

	it("reports an upload with the size of what was sent", () => {
		const line = accessLine(request("PUT", "/v8/artifacts/abc123", new Uint8Array(3 * 1024 * 1024)), response(202), 80);
		assert.strictEqual(line, "PUT abc123 202 stored 3.0 MB 80ms");
	});

	it("reports a miss without a size", () => {
		assert.strictEqual(accessLine(request("GET", "/v8/artifacts/abc123"), response(404), 3), "GET abc123 404 miss 3ms");
	});

	it("says nothing about the readiness probe or the telemetry sink", () => {
		// The spawning step polls /status up to forty times.
		assert.isNull(accessLine(request("GET", "/v8/artifacts/status"), response(200), 1));
		assert.isNull(accessLine(request("POST", "/v8/artifacts/events"), response(200), 1));
		assert.isNull(accessLine(request("GET", "/elsewhere"), response(404), 1));
	});

	it("never carries the bearer token", () => {
		const line = accessLine(request("GET", "/v8/artifacts/abc123"), response(401), 1);
		assert.strictEqual(line, "GET abc123 401 unauthorized 1ms");
		assert.notInclude(line ?? "", "secret-token");
	});
});

describe("tallyAccessLog", () => {
	it("counts the outcomes the line formatter writes, through the server's own prefix", () => {
		const lines = [
			accessLine(request("GET", "/v8/artifacts/a"), response(200, new Uint8Array(10)), 1),
			accessLine(request("GET", "/v8/artifacts/b"), response(200, new Uint8Array(10)), 1),
			accessLine(request("GET", "/v8/artifacts/c"), response(404), 1),
			accessLine(request("PUT", "/v8/artifacts/c", new Uint8Array(10)), response(202), 1),
			accessLine(request("HEAD", "/v8/artifacts/c"), response(200), 1),
			accessLine(request("GET", "/v8/artifacts/d"), response(500), 1),
			accessLine(request("GET", "/v8/artifacts/e"), response(401), 1),
		].map((line) => `${SERVER_LOG_PREFIX}${line}`);

		assert.deepStrictEqual(tallyAccessLog(lines.join("\n")), { hits: 2, misses: 1, uploads: 1, errors: 2 });
	});

	it("skips lines that are not requests", () => {
		const log = [
			`${SERVER_LOG_PREFIX}listening on 127.0.0.1:41230 (backend github, prefix none)`,
			`${SERVER_LOG_PREFIX}the github backend failed: hit a wall`,
			"Error: something unrelated to a GET x 200 hit",
			"",
		].join("\n");

		assert.deepStrictEqual(tallyAccessLog(log), { hits: 0, misses: 0, uploads: 0, errors: 0 });
	});
});

describe("formatAccessTally", () => {
	it("renders the four counts, singular where there is one", () => {
		assert.strictEqual(
			formatAccessTally({ hits: 34, misses: 1, uploads: 1, errors: 0 }),
			"34 hits, 1 miss, 1 upload, 0 errors",
		);
		assert.strictEqual(
			formatAccessTally({ hits: 1, misses: 2, uploads: 0, errors: 1 }),
			"1 hit, 2 misses, 0 uploads, 1 error",
		);
	});
});
