import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert, describe, it } from "@effect/vitest";
import { ActionInput } from "@effected/github-actions";
import { Effect, Option } from "effect";

import { INPUT_NAMES, loadInputs } from "../../../src/schema/inputs.js";

/**
 * The input names declared in `action.yml`, read from the file itself.
 *
 * @remarks
 * A deliberate five-line parse rather than a YAML dependency: the block is
 * two-space-indented `name:` keys between the top-level `inputs:` and the next
 * top-level key, and reading it for real is what makes the guard bite when
 * `action.yml` and the code drift apart.
 */
const declaredInputNames = (): ReadonlyArray<string> => {
	const source = readFileSync(fileURLToPath(new URL("../../../action.yml", import.meta.url)), "utf8");
	const lines = source.split("\n");
	const start = lines.indexOf("inputs:");
	const names: Array<string> = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\S/.test(line)) break;
		const match = /^ {2}([A-Za-z0-9-]+):\s*$/.exec(line);
		if (match?.[1] !== undefined) names.push(match[1]);
	}
	return names;
};

/**
 * An `ActionInput` environment that records every variable name looked up.
 *
 * @remarks
 * `ActionInput.provider` resolves each read as a plain `env[NAME]` lookup, so a
 * proxy is a faithful recorder: every value reads as absent, which is exactly
 * the "no inputs supplied" case, while the set of names asked for is captured.
 *
 * Since the provider became dual-accept, one input costs **two** probes — the
 * `INPUT_` derivation first, then the name verbatim — so a key already spelled
 * as a runner variable is probed once as `INPUT_INPUT_…` before being found as
 * itself. Repeated prefixes are stripped rather than counted: the assertion is
 * about which *inputs* are read, and how many spellings the provider tries to
 * find each one is its business, not this suite's.
 */
const recordingEnv = (seen: Set<string>): Record<string, string> =>
	new Proxy({} as Record<string, string>, {
		get: (_target, property) => {
			// The runner uppercases the input name and leaves dashes alone, so the
			// recorded variable maps back to the `action.yml` name by lowercasing.
			if (typeof property === "string" && property.startsWith("INPUT_")) {
				seen.add(property.replace(/^(?:INPUT_)+/, "").toLowerCase());
			}
			return undefined;
		},
	});

describe("loadInputs", () => {
	it.effect("applies action.yml defaults when everything is absent", () =>
		Effect.gen(function* () {
			const inputs = yield* loadInputs;
			assert.strictEqual(inputs.turboCache, "auto");
			assert.strictEqual(inputs.installDeps, true);
			assert.deepStrictEqual(inputs.cacheBust, Option.none());
			assert.deepStrictEqual(inputs.biomeVersion, Option.none());
			assert.deepStrictEqual(inputs.additionalLockfiles, []);
		}).pipe(Effect.provide(ActionInput.layer({}))),
	);
	it.effect("parses multiline additional-lockfiles and s3 fields", () =>
		Effect.gen(function* () {
			const inputs = yield* loadInputs;
			assert.deepStrictEqual(inputs.additionalLockfiles, ["deno.lock", "**/yarn.lock"]);
			assert.strictEqual(Option.isSome(inputs.turboS3Bucket), true);
		}).pipe(
			Effect.provide(
				ActionInput.layer({
					"additional-lockfiles": "deno.lock\n**/yarn.lock",
					"turbo-s3-bucket": "my-bucket",
				}),
			),
		),
	);
	it.effect("normalizes turbo-cache to off only for the literal value 'off'", () =>
		Effect.gen(function* () {
			const inputs = yield* loadInputs;
			assert.strictEqual(inputs.turboCache, "off");
		}).pipe(Effect.provide(ActionInput.layer({ "turbo-cache": "off" }))),
	);
	it.effect("normalizes cache-bust literal 'false' to Option.none()", () =>
		Effect.gen(function* () {
			const inputs = yield* loadInputs;
			assert.deepStrictEqual(inputs.cacheBust, Option.none());
		}).pipe(Effect.provide(ActionInput.layer({ "cache-bust": "false" }))),
	);
	it.effect("keeps a real cache-bust value", () =>
		Effect.gen(function* () {
			const inputs = yield* loadInputs;
			assert.deepStrictEqual(inputs.cacheBust, Option.some("run-123"));
		}).pipe(Effect.provide(ActionInput.layer({ "cache-bust": "run-123" }))),
	);
	it.effect("keeps redacted secrets redacted", () =>
		Effect.gen(function* () {
			const inputs = yield* loadInputs;
			assert.strictEqual(Option.isSome(inputs.turboToken), true);
		}).pipe(Effect.provide(ActionInput.layer({ "turbo-token": "secret-value" }))),
	);
	it.effect("fails rather than silently defaulting on a malformed install-deps value", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(loadInputs);
			assert.strictEqual(exit._tag, "Failure");
		}).pipe(Effect.provide(ActionInput.layer({ "install-deps": "yes" }))),
	);
});

describe("bats and kcov inputs", () => {
	it.effect("defaults both to auto when unset", () =>
		Effect.gen(function* () {
			const inputs = yield* loadInputs;
			assert.strictEqual(inputs.bats, "auto");
			assert.strictEqual(inputs.kcov, "auto");
		}).pipe(Effect.provide(ActionInput.layer({}))),
	);

	it.effect("normalizes true to on and false to off", () =>
		Effect.gen(function* () {
			const inputs = yield* loadInputs;
			assert.strictEqual(inputs.bats, "on");
			assert.strictEqual(inputs.kcov, "off");
		}).pipe(Effect.provide(ActionInput.layer({ bats: "true", kcov: "false" }))),
	);

	it.effect("normalizes any unrecognized value to auto", () =>
		Effect.gen(function* () {
			const inputs = yield* loadInputs;
			assert.strictEqual(inputs.bats, "auto");
		}).pipe(Effect.provide(ActionInput.layer({ bats: "yes-please" }))),
	);
});

describe("INPUT_NAMES", () => {
	it("matches the inputs action.yml declares", () => {
		assert.deepStrictEqual([...INPUT_NAMES].sort(), [...declaredInputNames()].sort());
	});

	it.effect("is exactly the set loadInputs reads", () =>
		Effect.gen(function* () {
			const seen = new Set<string>();
			yield* loadInputs.pipe(Effect.provide(ActionInput.layer(recordingEnv(seen))));
			assert.deepStrictEqual([...seen].sort(), [...INPUT_NAMES].sort());
		}),
	);
});
