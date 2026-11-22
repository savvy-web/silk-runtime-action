import { assert, describe, it } from "@effect/vitest";
import { BlobStore, BlobStoreError, TruncatedBlobEnvelopeError } from "@effected/github-actions";
import { Effect, Result } from "effect";

import {
	DEFAULT_TURBO_SERVER_PORT,
	TURBO_SERVER_ENV,
	isAuthShapedFailure,
	readServerConfig,
	serverBlobStoreLayer,
} from "../../../src/turbo-cache/server-config.js";

/** The minimum the worker will boot on: a token, and nothing else. */
const bootable = { [TURBO_SERVER_ENV.token]: "run-token" } as const;

/** The config a successful read produced, or a failure the test did not expect. */
const configOf = (env: Record<string, string | undefined>) => {
	const result = readServerConfig(env);
	if (Result.isFailure(result)) throw new Error(`expected a config, got: ${result.failure}`);
	return result.success;
};

describe("readServerConfig", () => {
	it("refuses to boot without a token", () => {
		// Ruling 72, fail closed: an empty token disables authentication at the
		// handler, which would leave an open cache server listening on the runner.
		// `apply` always supplies one, so this is a posture fix rather than a path
		// a real run reaches.
		const result = readServerConfig({});

		assert.strictEqual(Result.isFailure(result), true);
		if (Result.isFailure(result)) assert.include(result.failure, TURBO_SERVER_ENV.token);
	});

	it("refuses to boot on an empty token", () => {
		assert.strictEqual(Result.isFailure(readServerConfig({ [TURBO_SERVER_ENV.token]: "" })), true);
	});

	it("defaults the port, prefix and backend", () => {
		assert.deepStrictEqual(configOf(bootable), {
			port: DEFAULT_TURBO_SERVER_PORT,
			prefix: "",
			token: "run-token",
			backend: "github",
		});
	});

	it("reads the port and prefix it was given", () => {
		const config = configOf({
			...bootable,
			[TURBO_SERVER_ENV.port]: "45000",
			[TURBO_SERVER_ENV.prefix]: "team-a/",
		});

		assert.strictEqual(config.port, 45_000);
		assert.strictEqual(config.prefix, "team-a/");
	});

	it.each([
		["not a number", "not-a-port"],
		["fractional", "41230.5"],
		["negative", "-1"],
		["zero", "0"],
		["above the last port", "65536"],
	])("falls back to the default port when the port is %s", (_name, port) => {
		// `listen` throws *synchronously* on a port outside `1..65535`, so the
		// error listener ruling 71 added never fires for this case and the process
		// would die with a stack trace instead of a line. The spawning step only
		// ever writes the one port this action uses, so anything else means
		// something foreign set it — binding the known port keeps the server where
		// the action is about to look for it.
		assert.strictEqual(configOf({ ...bootable, [TURBO_SERVER_ENV.port]: port }).port, DEFAULT_TURBO_SERVER_PORT);
	});

	it("keeps the last valid port", () => {
		assert.strictEqual(configOf({ ...bootable, [TURBO_SERVER_ENV.port]: "65535" }).port, 65_535);
	});

	it("treats any backend name as github, the retired s3 included", () => {
		// The embedded server has one store. A worker handed `s3` by something
		// stale must not go looking for a bucket it no longer knows how to sign for.
		for (const name of ["azure", "s3", "", "GITHUB"]) {
			assert.deepStrictEqual(configOf({ ...bootable, [TURBO_SERVER_ENV.backend]: name }), {
				port: DEFAULT_TURBO_SERVER_PORT,
				prefix: "",
				token: "run-token",
				backend: "github",
			});
		}
	});

	it("ignores every S3 variable a stale environment still carries", () => {
		const config = configOf({
			...bootable,
			TURBOGHA_BACKEND: "s3",
			TURBOGHA_S3_BUCKET: "turbo-cache",
			TURBOGHA_S3_SECRET_ACCESS_KEY: "stale-secret",
		});
		assert.notInclude(JSON.stringify(config), "turbo-cache");
		assert.notInclude(JSON.stringify(config), "stale-secret");
	});
});

describe("TURBO_SERVER_ENV", () => {
	it("names the four variables the worker is configured with and no S3 one", () => {
		assert.deepStrictEqual(TURBO_SERVER_ENV, {
			port: "TURBOGHA_PORT",
			prefix: "TURBOGHA_PREFIX",
			token: "TURBOGHA_TOKEN",
			backend: "TURBOGHA_BACKEND",
		});
	});
});

describe("serverBlobStoreLayer", () => {
	it("builds the github backend", async () => {
		const members = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* BlobStore;
				return [typeof store.get, typeof store.put, typeof store.has];
			}).pipe(Effect.provide(serverBlobStoreLayer)),
		);
		assert.deepStrictEqual(members, ["function", "function", "function"]);
	});
});

describe("isAuthShapedFailure", () => {
	it("is true for a 401", () => {
		assert.strictEqual(isAuthShapedFailure(new BlobStoreError({ reason: "unreachable", status: 401 })), true);
	});

	it("is true for a refusal", () => {
		assert.strictEqual(isAuthShapedFailure(new BlobStoreError({ reason: "refused" })), true);
	});

	it("is false for an unreachable store", () => {
		assert.strictEqual(isAuthShapedFailure(new BlobStoreError({ reason: "unreachable" })), false);
	});

	it("is false for a misconfigured store", () => {
		assert.strictEqual(isAuthShapedFailure(new BlobStoreError({ reason: "misconfigured" })), false);
	});

	it("is false for an envelope failure", () => {
		assert.strictEqual(isAuthShapedFailure(new TruncatedBlobEnvelopeError({})), false);
	});
});
