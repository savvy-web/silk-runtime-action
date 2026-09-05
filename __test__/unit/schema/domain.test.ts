import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { AbsoluteVersion, ConfigError, PackageManagerName, RuntimeName } from "../../../src/schema/domain.js";

describe("AbsoluteVersion", () => {
	it.effect("accepts an exact semver", () =>
		Effect.gen(function* () {
			const v = yield* Schema.decodeUnknownEffect(AbsoluteVersion)("24.11.0");
			assert.strictEqual(v, "24.11.0");
		}),
	);
	it.effect("accepts an exact semver with build metadata", () =>
		Effect.gen(function* () {
			const v = yield* Schema.decodeUnknownEffect(AbsoluteVersion)("11.17.0+sha512.cca3cea3");
			assert.strictEqual(v, "11.17.0+sha512.cca3cea3");
		}),
	);
	// Whitespace-padded versions parse as SemVer but must not: the raw string is
	// interpolated into download URLs downstream, so it has to be exact, and
	// legacy's anchored regex rejected padding. This is a check, never a
	// transform — nothing is silently trimmed.
	for (const bad of [
		"^24.0.0",
		"~1.2.3",
		">=1.0.0",
		"<2.0.0",
		"=24.11.0",
		"24.x",
		"24.X",
		"1.2",
		"*",
		"latest",
		"",
		" 24.11.0",
		"24.11.0 ",
		" 24.11.0 ",
		"\t24.11.0",
		"24.11.0\n",
		"24. 11.0",
	]) {
		it.effect(`rejects "${bad}"`, () =>
			Effect.gen(function* () {
				const exit = yield* Effect.exit(Schema.decodeUnknownEffect(AbsoluteVersion)(bad));
				assert.strictEqual(exit._tag, "Failure");
			}),
		);
	}
});

describe("RuntimeName", () => {
	for (const name of ["node", "bun", "deno"]) {
		it.effect(`accepts "${name}"`, () =>
			Effect.gen(function* () {
				const v = yield* Schema.decodeUnknownEffect(RuntimeName)(name);
				assert.strictEqual(v, name);
			}),
		);
	}
	it.effect("rejects an unknown runtime name", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(Schema.decodeUnknownEffect(RuntimeName)("ruby"));
			assert.strictEqual(exit._tag, "Failure");
		}),
	);
});

describe("PackageManagerName", () => {
	// Five, not four: `action.yml` documents the `package-manager` output as
	// `npm | pnpm | yarn | bun | deno`, so dropping `deno` here would be a
	// silent parity break against v1.
	for (const name of ["npm", "pnpm", "yarn", "bun", "deno"]) {
		it.effect(`accepts "${name}"`, () =>
			Effect.gen(function* () {
				const v = yield* Schema.decodeUnknownEffect(PackageManagerName)(name);
				assert.strictEqual(v, name);
			}),
		);
	}
	it.effect("rejects an unknown package manager name", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(Schema.decodeUnknownEffect(PackageManagerName)("bundler"));
			assert.strictEqual(exit._tag, "Failure");
		}),
	);
});

describe("ConfigError", () => {
	it("carries its tag and reason", () => {
		const error = new ConfigError({
			reason: "invalid-dev-engines",
			message: "package.json has invalid or missing devEngines field",
		});
		assert.strictEqual(error._tag, "ConfigError");
		assert.strictEqual(error.reason, "invalid-dev-engines");
		assert.strictEqual(error.message, "package.json has invalid or missing devEngines field");
	});
});
