import { assert, describe, it } from "@effect/vitest";
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
	turboApi: Option.none(),
	installDeps: true,
	ignoreScripts: false,
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

/** The hosted service, as a shared workflow passes it. */
const hostedApi = { turboApi: Option.some("https://cache.savvyweb.systems") } as const;

describe("resolveTurboCache", () => {
	it("is off when turbo is not detected", () => {
		assert.deepStrictEqual(resolveTurboCache({ turboDetected: false, inputs: baseInputs }), { mode: "off" });
	});

	it("no turbo.json wins over turbo-api", () => {
		assert.deepStrictEqual(resolveTurboCache({ turboDetected: false, inputs: inputs(hostedApi) }), { mode: "off" });
	});

	it("is off when turbo is not detected even with every credential set", () => {
		assert.deepStrictEqual(
			resolveTurboCache({ turboDetected: false, inputs: inputs({ ...passthroughCredentials, ...hostedApi }) }),
			{ mode: "off" },
		);
	});

	it("is off when the mode input says off", () => {
		assert.deepStrictEqual(resolveTurboCache({ turboDetected: true, inputs: inputs({ turboCache: "off" }) }), {
			mode: "off",
		});
	});

	it("off wins over turbo-api", () => {
		// The fork leg of a shared workflow sets `turbo-cache: off`; nothing a
		// caller also passes may turn sign-in back on.
		assert.deepStrictEqual(
			resolveTurboCache({ turboDetected: true, inputs: inputs({ turboCache: "off", ...hostedApi }) }),
			{ mode: "off" },
		);
	});

	it("is off when the mode input says off even with every credential set", () => {
		assert.deepStrictEqual(
			resolveTurboCache({
				turboDetected: true,
				inputs: inputs({ turboCache: "off", ...passthroughCredentials, ...hostedApi }),
			}),
			{ mode: "off" },
		);
	});

	it("turbo-api selects hosted", () => {
		assert.deepStrictEqual(resolveTurboCache({ turboDetected: true, inputs: inputs(hostedApi) }), {
			mode: "hosted",
			api: "https://cache.savvyweb.systems",
		});
	});

	it("turbo-api wins over a Vercel token and team", () => {
		assert.deepStrictEqual(
			resolveTurboCache({ turboDetected: true, inputs: inputs({ ...passthroughCredentials, ...hostedApi }) }),
			{ mode: "hosted", api: "https://cache.savvyweb.systems" },
		);
	});

	it("turbo-api wins over half a Vercel credential", () => {
		assert.deepStrictEqual(
			resolveTurboCache({
				turboDetected: true,
				inputs: inputs({ turboTeam: passthroughCredentials.turboTeam, ...hostedApi }),
			}),
			{ mode: "hosted", api: "https://cache.savvyweb.systems" },
		);
	});

	it("a token and team without turbo-api is passthrough", () => {
		assert.deepStrictEqual(resolveTurboCache({ turboDetected: true, inputs: inputs(passthroughCredentials) }), {
			mode: "passthrough",
			token: Redacted.make("vercel-token"),
			team: "my-team",
		});
	});

	it("nothing set is embedded", () => {
		assert.deepStrictEqual(resolveTurboCache({ turboDetected: true, inputs: baseInputs }), { mode: "embedded" });
	});

	it("falls through to embedded when only the token is set", () => {
		// Quirk 77: partial passthrough credentials are not an error and not a
		// passthrough — the rule needs both, so the resolution walks on. Ruling 77
		// adds a warning at the call site; the table itself is unchanged.
		assert.deepStrictEqual(
			resolveTurboCache({ turboDetected: true, inputs: inputs({ turboToken: passthroughCredentials.turboToken }) }),
			{ mode: "embedded" },
		);
	});

	it("falls through to embedded when only the team is set", () => {
		assert.deepStrictEqual(
			resolveTurboCache({ turboDetected: true, inputs: inputs({ turboTeam: passthroughCredentials.turboTeam }) }),
			{ mode: "embedded" },
		);
	});
});

describe("hasPartialPassthroughCredentials", () => {
	it("is true when only the token is set", () => {
		assert.strictEqual(
			hasPartialPassthroughCredentials(inputs({ turboToken: passthroughCredentials.turboToken })),
			true,
		);
	});

	it("is true when only the team is set", () => {
		assert.strictEqual(hasPartialPassthroughCredentials(inputs({ turboTeam: passthroughCredentials.turboTeam })), true);
	});

	it("is false when both are set", () => {
		assert.strictEqual(hasPartialPassthroughCredentials(inputs(passthroughCredentials)), false);
	});

	it("is false when neither is set", () => {
		assert.strictEqual(hasPartialPassthroughCredentials(baseInputs), false);
	});
});
