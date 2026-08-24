import { describe, expect, it } from "@effect/vitest";
import { BlobStore, BlobStoreError, TruncatedBlobEnvelopeError } from "@effected/github-actions";
import { Effect, Redacted, Result } from "effect";

import {
	DEFAULT_TURBO_SERVER_PORT,
	TURBO_SERVER_ENV,
	isAuthShapedFailure,
	readServerConfig,
	serverBlobStoreLayer,
} from "../../../src/turbo-cache/server-config.js";

/** The minimum the worker will boot on: a token, and nothing else. */
const bootable = { [TURBO_SERVER_ENV.token]: "run-token" } as const;

/** The environment an S3-backed server is spawned with. */
const s3Environment = {
	...bootable,
	[TURBO_SERVER_ENV.backend]: "s3",
	[TURBO_SERVER_ENV.s3Bucket]: "turbo-cache",
	[TURBO_SERVER_ENV.s3Region]: "us-east-1",
	[TURBO_SERVER_ENV.s3AccessKeyId]: "minioadmin",
	[TURBO_SERVER_ENV.s3SecretAccessKey]: "minioadmin-secret",
} as const;

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

		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) expect(result.failure).toContain(TURBO_SERVER_ENV.token);
	});

	it("refuses to boot on an empty token", () => {
		expect(Result.isFailure(readServerConfig({ [TURBO_SERVER_ENV.token]: "" }))).toBe(true);
	});

	it("defaults the port, prefix and backend", () => {
		expect(configOf(bootable)).toEqual({
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

		expect(config.port).toBe(45_000);
		expect(config.prefix).toBe("team-a/");
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
		expect(configOf({ ...bootable, [TURBO_SERVER_ENV.port]: port }).port).toBe(DEFAULT_TURBO_SERVER_PORT);
	});

	it("keeps the last valid port", () => {
		expect(configOf({ ...bootable, [TURBO_SERVER_ENV.port]: "65535" }).port).toBe(65_535);
	});

	it("reads the s3 backend", () => {
		const config = configOf(s3Environment);

		expect(config.backend).toBe("s3");
		if (config.backend !== "s3") return;
		expect(config.s3.bucket).toBe("turbo-cache");
		expect(config.s3.region).toBe("us-east-1");
		expect(config.s3.accessKeyId).toBe("minioadmin");
		expect(Redacted.value(config.s3.secretAccessKey)).toBe("minioadmin-secret");
	});

	it("omits the optional s3 fields when they are unset", () => {
		// Oracle 48: endpoint, session token and prefix are spread in only when
		// nonempty — an empty endpoint would point the signer at nothing, and an
		// empty prefix would namespace every key under a leading separator.
		const config = configOf(s3Environment);

		expect(config.backend === "s3" && "endpoint" in config.s3).toBe(false);
		expect(config.backend === "s3" && "sessionToken" in config.s3).toBe(false);
		expect(config.backend === "s3" && "prefix" in config.s3).toBe(false);
	});

	it("omits the optional s3 fields when they are empty", () => {
		const config = configOf({
			...s3Environment,
			[TURBO_SERVER_ENV.s3Endpoint]: "",
			[TURBO_SERVER_ENV.s3SessionToken]: "",
			[TURBO_SERVER_ENV.s3Prefix]: "",
		});

		expect(config.backend === "s3" && "endpoint" in config.s3).toBe(false);
		expect(config.backend === "s3" && "sessionToken" in config.s3).toBe(false);
		expect(config.backend === "s3" && "prefix" in config.s3).toBe(false);
	});

	it("carries the optional s3 fields when they are set", () => {
		const config = configOf({
			...s3Environment,
			[TURBO_SERVER_ENV.s3Endpoint]: "http://127.0.0.1:9000",
			[TURBO_SERVER_ENV.s3SessionToken]: "session",
			[TURBO_SERVER_ENV.s3Prefix]: "cache/",
		});

		expect(config.backend).toBe("s3");
		if (config.backend !== "s3") return;
		expect(config.s3.endpoint).toBe("http://127.0.0.1:9000");
		expect(config.s3.prefix).toBe("cache/");
		expect(config.s3.sessionToken === undefined ? "" : Redacted.value(config.s3.sessionToken)).toBe("session");
	});

	it("reads an absent s3 credential as empty rather than failing", () => {
		// The S3 layer reports its own misconfiguration, with the bucket and status
		// a failed request carries. Guessing at it here would refuse to boot on a
		// backend that a workflow may have configured through some other means.
		const config = configOf({ ...bootable, [TURBO_SERVER_ENV.backend]: "s3" });

		expect(config.backend).toBe("s3");
		if (config.backend !== "s3") return;
		expect(config.s3.bucket).toBe("");
		expect(Redacted.value(config.s3.secretAccessKey)).toBe("");
	});

	it("treats any other backend name as github", () => {
		expect(configOf({ ...bootable, [TURBO_SERVER_ENV.backend]: "azure" }).backend).toBe("github");
	});
});

describe("serverBlobStoreLayer", () => {
	/** Builds the layer and answers with the store it provides. */
	const build = (env: Record<string, string | undefined>) =>
		Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* BlobStore;
				return [typeof store.get, typeof store.put, typeof store.has];
			}).pipe(Effect.provide(serverBlobStoreLayer(configOf(env)))),
		);

	it("builds the github backend", async () => {
		expect(await build(bootable)).toEqual(["function", "function", "function"]);
	});

	it("builds the s3 backend", async () => {
		expect(await build(s3Environment)).toEqual(["function", "function", "function"]);
	});

	it("never writes the s3 credentials to this process's log", async () => {
		// The S3 backend declassifies its signing key through `Secret.forSigning`,
		// which masks first — and masking is `::add-mask::<plaintext>` written to
		// stdout for the *runner* to parse. This process is detached, so its stdout
		// is a temp file nothing parses, and the real `ActionOutputs` layer would
		// write both secrets there in the clear. `console.log` is the channel
		// `Console.log` ends up on, so capturing it is capturing the leak.
		const secret = "s3-secret-that-must-not-appear";
		const session = "s3-session-that-must-not-appear";
		const said: Array<string> = [];
		const original = console.log;
		console.log = (...args: ReadonlyArray<unknown>) => void said.push(args.map(String).join(" "));
		try {
			await build({
				...s3Environment,
				[TURBO_SERVER_ENV.s3SecretAccessKey]: secret,
				[TURBO_SERVER_ENV.s3SessionToken]: session,
			});
		} finally {
			console.log = original;
		}

		expect(said.join("\n")).not.toContain(secret);
		expect(said.join("\n")).not.toContain(session);
		expect(said.join("\n")).not.toContain("add-mask");
	});
});

describe("isAuthShapedFailure", () => {
	it("is true for a 401", () => {
		expect(isAuthShapedFailure(new BlobStoreError({ reason: "unreachable", status: 401 }))).toBe(true);
	});

	it("is true for a refusal", () => {
		expect(isAuthShapedFailure(new BlobStoreError({ reason: "refused" }))).toBe(true);
	});

	it("is false for an unreachable store", () => {
		expect(isAuthShapedFailure(new BlobStoreError({ reason: "unreachable" }))).toBe(false);
	});

	it("is false for a misconfigured store", () => {
		expect(isAuthShapedFailure(new BlobStoreError({ reason: "misconfigured" }))).toBe(false);
	});

	it("is false for an envelope failure", () => {
		expect(isAuthShapedFailure(new TruncatedBlobEnvelopeError({}))).toBe(false);
	});
});
