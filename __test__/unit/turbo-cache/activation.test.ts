import { describe, expect, it } from "@effect/vitest";
import { Option, Redacted } from "effect";

import type { Inputs } from "../../../src/schema/inputs.js";
import { hasPartialPassthroughCredentials, resolveTurboCache } from "../../../src/turbo-cache/activation.js";

/** Every input absent, every default applied. */
const baseInputs: Inputs = {
	biomeVersion: Option.none(),
	turboCache: "auto",
	turboCachePrefix: "",
	turboToken: Option.none(),
	turboTeam: Option.none(),
	turboS3Bucket: Option.none(),
	turboS3Region: Option.none(),
	turboS3Endpoint: Option.none(),
	turboS3AccessKeyId: Option.none(),
	turboS3SecretAccessKey: Option.none(),
	turboS3SessionToken: Option.none(),
	turboS3Prefix: Option.none(),
	installDeps: true,
	bats: "auto",
	kcov: "auto",
	cacheBust: Option.none(),
	additionalLockfiles: [],
	additionalCachePaths: [],
};

/** `baseInputs` with the turbo fields a row cares about overridden. */
const inputs = (overrides: Partial<Inputs>): Inputs => ({ ...baseInputs, ...overrides });

/** The external Vercel credentials, as a workflow supplies both of them. */
const passthroughCredentials = {
	turboToken: Option.some(Redacted.make("vercel-token")),
	turboTeam: Option.some("my-team"),
} as const;

/** The one S3 field the table probes, plus the one that rides beside it. */
const s3Credentials = {
	turboS3Bucket: Option.some("my-bucket"),
	turboS3Region: Option.some("us-east-1"),
} as const;

/** The `s3` payload `s3Credentials` resolves to. */
const s3Settings = {
	bucket: "my-bucket",
	region: Option.some("us-east-1"),
	endpoint: Option.none(),
	accessKeyId: Option.none(),
	secretAccessKey: Option.none(),
	sessionToken: Option.none(),
	prefix: Option.none(),
};

describe("resolveTurboCache", () => {
	it("is off when turbo is not detected", () => {
		expect(resolveTurboCache({ turboDetected: false, inputs: baseInputs })).toEqual({ mode: "off" });
	});

	it("is off when turbo is not detected even with every credential set", () => {
		expect(
			resolveTurboCache({
				turboDetected: false,
				inputs: inputs({ ...passthroughCredentials, ...s3Credentials }),
			}),
		).toEqual({ mode: "off" });
	});

	it("is off when the mode input says off", () => {
		expect(resolveTurboCache({ turboDetected: true, inputs: inputs({ turboCache: "off" }) })).toEqual({ mode: "off" });
	});

	it("is off when the mode input says off even with every credential set", () => {
		expect(
			resolveTurboCache({
				turboDetected: true,
				inputs: inputs({ turboCache: "off", ...passthroughCredentials, ...s3Credentials }),
			}),
		).toEqual({ mode: "off" });
	});

	it("is passthrough when token and team are both present", () => {
		expect(resolveTurboCache({ turboDetected: true, inputs: inputs(passthroughCredentials) })).toEqual({
			mode: "passthrough",
			token: Redacted.make("vercel-token"),
			team: "my-team",
		});
	});

	it("prefers passthrough over s3 when both are configured", () => {
		expect(
			resolveTurboCache({ turboDetected: true, inputs: inputs({ ...passthroughCredentials, ...s3Credentials }) }),
		).toEqual({ mode: "passthrough", token: Redacted.make("vercel-token"), team: "my-team" });
	});

	it("is embedded s3 when a bucket is present and no external credentials are", () => {
		expect(resolveTurboCache({ turboDetected: true, inputs: inputs(s3Credentials) })).toEqual({
			mode: "embedded",
			backend: "s3",
			s3: s3Settings,
		});
	});

	it("carries every s3 field through to the resolution", () => {
		const resolution = resolveTurboCache({
			turboDetected: true,
			inputs: inputs({
				...s3Credentials,
				turboS3Endpoint: Option.some("http://127.0.0.1:9000"),
				turboS3AccessKeyId: Option.some("minioadmin"),
				turboS3SecretAccessKey: Option.some(Redacted.make("minioadmin")),
				turboS3SessionToken: Option.some(Redacted.make("session")),
				turboS3Prefix: Option.some("cache/"),
			}),
		});

		expect(resolution).toEqual({
			mode: "embedded",
			backend: "s3",
			s3: {
				bucket: "my-bucket",
				region: Option.some("us-east-1"),
				endpoint: Option.some("http://127.0.0.1:9000"),
				accessKeyId: Option.some("minioadmin"),
				secretAccessKey: Option.some(Redacted.make("minioadmin")),
				sessionToken: Option.some(Redacted.make("session")),
				prefix: Option.some("cache/"),
			},
		});
	});

	it("is embedded github when nothing at all is configured", () => {
		expect(resolveTurboCache({ turboDetected: true, inputs: baseInputs })).toEqual({
			mode: "embedded",
			backend: "github",
		});
	});

	it("falls through to embedded github when only the token is set", () => {
		// Quirk 77: partial passthrough credentials are not an error and not a
		// passthrough — R2 needs both, so the resolution walks on. Ruling 77 adds a
		// warning at the call site; the table itself is unchanged.
		expect(
			resolveTurboCache({ turboDetected: true, inputs: inputs({ turboToken: passthroughCredentials.turboToken }) }),
		).toEqual({ mode: "embedded", backend: "github" });
	});

	it("falls through to embedded github when only the team is set", () => {
		expect(
			resolveTurboCache({ turboDetected: true, inputs: inputs({ turboTeam: passthroughCredentials.turboTeam }) }),
		).toEqual({ mode: "embedded", backend: "github" });
	});

	it("falls through to embedded s3 when passthrough credentials are partial and a bucket is set", () => {
		expect(
			resolveTurboCache({
				turboDetected: true,
				inputs: inputs({ turboTeam: passthroughCredentials.turboTeam, ...s3Credentials }),
			}),
		).toEqual({ mode: "embedded", backend: "s3", s3: s3Settings });
	});

	it("probes only the bucket, never the other s3 fields", () => {
		// Rule R3 reads `bucket` and nothing else (oracle 3): S3 credentials with no
		// bucket are the github backend, not a misconfigured S3 one.
		expect(
			resolveTurboCache({
				turboDetected: true,
				inputs: inputs({
					turboS3Region: Option.some("us-east-1"),
					turboS3AccessKeyId: Option.some("key"),
					turboS3SecretAccessKey: Option.some(Redacted.make("secret")),
				}),
			}),
		).toEqual({ mode: "embedded", backend: "github" });
	});
});

describe("hasPartialPassthroughCredentials", () => {
	it("is true when only the token is set", () => {
		expect(hasPartialPassthroughCredentials(inputs({ turboToken: passthroughCredentials.turboToken }))).toBe(true);
	});

	it("is true when only the team is set", () => {
		expect(hasPartialPassthroughCredentials(inputs({ turboTeam: passthroughCredentials.turboTeam }))).toBe(true);
	});

	it("is false when both are set", () => {
		expect(hasPartialPassthroughCredentials(inputs(passthroughCredentials))).toBe(false);
	});

	it("is false when neither is set", () => {
		expect(hasPartialPassthroughCredentials(baseInputs)).toBe(false);
	});
});
