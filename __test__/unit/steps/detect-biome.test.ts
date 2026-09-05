import { assert, describe, it } from "@effect/vitest";
import { MemoryFileSystem } from "@effected/memfs";
import type { FileSystem } from "effect";
import { Effect, Layer, Logger, Option, PlatformError, References } from "effect";

import { detectBiome } from "../../../src/steps/detect-biome.js";

/** The two config file names the step probes, in the order it probes them. */
const JSONC = "biome.jsonc";
const JSON_ = "biome.json";

/** A `$schema` url as biome writes it, for `version`. */
const schemaUrl = (version: string): string => `https://biomejs.dev/schemas/${version}/schema.json`;

/** Every filesystem call the step made, in order. */
interface Calls {
	readonly accessed: Array<string>;
	readonly read: Array<string>;
}

/**
 * A volume holding `files` — keyed by the relative path the step probes — and
 * nothing else, wrapped in a recorder over the two members the step uses.
 *
 * @remarks
 * Absence is the volume's own answer rather than a stubbed one: an unseeded
 * config file fails `NotFound` on `access` exactly as a missing file does on a
 * runner. The recorders return `undefined` and so delegate; only `unreadable`
 * substitutes a failure, because a volume has no permissions model and
 * "present but unreadable" is a distinct case this suite has to reach.
 */
const fileSystemTest = (
	files: Readonly<Record<string, string>>,
	calls: Calls = { accessed: [], read: [] },
	options: { readonly unreadable?: ReadonlySet<string> } = {},
): Layer.Layer<FileSystem.FileSystem> =>
	MemoryFileSystem.layerFaulty({
		access: (path) => {
			calls.accessed.push(path);
			return undefined;
		},
		readFileString: (path) => {
			calls.read.push(path);
			return options.unreadable?.has(path) === true
				? Effect.fail(
						PlatformError.systemError({
							_tag: "PermissionDenied",
							module: "FileSystem",
							method: "readFileString",
							pathOrDescriptor: path,
						}),
					)
				: undefined;
		},
	}).pipe(
		Layer.provide(
			MemoryFileSystem.layerWith(Object.fromEntries(Object.entries(files).map(([name, body]) => [`/${name}`, body]))),
		),
	);

/** Runs the step against `files`, returning the resolved version. */
const run = (requested: Option.Option<string>, files: Readonly<Record<string, string>> = {}, calls?: Calls) =>
	detectBiome(requested).pipe(Effect.provide(fileSystemTest(files, calls)));

describe("detectBiome", () => {
	it.effect("takes the requested version without touching the filesystem", () =>
		Effect.gen(function* () {
			const calls: Calls = { accessed: [], read: [] };
			// A config file is present and says something else: the override still
			// wins, and the file is never even probed (oracle 1-2).
			const version = yield* run(Option.some("2.3.14"), { [JSONC]: `{"$schema": "${schemaUrl("9.9.9")}"}` }, calls);

			assert.deepStrictEqual(version, Option.some("2.3.14"));
			assert.deepStrictEqual(calls.accessed, []);
			assert.deepStrictEqual(calls.read, []);
		}),
	);

	it.effect("trims the requested version", () =>
		Effect.gen(function* () {
			// Deviation from v1, which passed " 2.3.14 " straight into a download url
			// (oracle quirk 3). The trim is the whole fix: the version is a path
			// segment in the release url, and padding makes it a 404.
			assert.deepStrictEqual(yield* run(Option.some("  2.3.14\n")), Option.some("2.3.14"));
		}),
	);

	it.effect("reads a blank requested version as no request at all", () =>
		Effect.gen(function* () {
			const calls: Calls = { accessed: [], read: [] };
			const version = yield* run(Option.some("   "), { [JSONC]: `{"$schema": "${schemaUrl("2.4.9")}"}` }, calls);

			// Empty-after-trim is absent, so the config file decides — the same
			// reading `ActionInput` already gives the empty string.
			assert.deepStrictEqual(version, Option.some("2.4.9"));
			assert.deepStrictEqual(calls.read, [JSONC]);
		}),
	);

	it.effect("does not semver-validate the requested version", () =>
		Effect.gen(function* () {
			// v1 parity, consciously kept (oracle quirk 4): biome's tags are npm
			// -style and the url encodes whatever is asked for, so "latest" and
			// "nightly" are legitimate values this step has no business refusing.
			assert.deepStrictEqual(yield* run(Option.some("latest")), Option.some("latest"));
		}),
	);

	it.effect("refuses a requested version that could redirect the download url", () =>
		Effect.gen(function* () {
			// The version becomes a path segment in the release url. A separator or
			// dot-segment names a *different* url, so it is refused outright rather
			// than fetched — quirk 4's tag tolerance is about shapes like "next",
			// not about path traversal.
			for (const hostile of ["../../../evil/repo/releases/download/v1", "2.4.9/extra", "..", "%2e%2e"]) {
				assert.deepStrictEqual(yield* run(Option.some(hostile)), Option.none());
			}
		}),
	);

	it.effect("drops a $schema capture that is not a plain version", () =>
		Effect.gen(function* () {
			const version = yield* run(Option.none(), {
				[JSONC]: `{"$schema": "https://biomejs.dev/schemas/../schema.json"}`,
			});
			assert.deepStrictEqual(version, Option.none());
		}),
	);

	it.effect("reads the version out of biome.jsonc's $schema", () =>
		Effect.gen(function* () {
			const version = yield* run(Option.none(), { [JSONC]: `{"$schema": "${schemaUrl("2.4.9")}"}` });
			assert.deepStrictEqual(version, Option.some("2.4.9"));
		}),
	);

	it.effect("parses the config as JSONC, comments and all", () =>
		Effect.gen(function* () {
			const contents = `{
				// the version this repository pins
				"$schema": "${schemaUrl("2.4.9")}",
				"formatter": { "enabled": true },
			}`;
			assert.deepStrictEqual(yield* run(Option.none(), { [JSONC]: contents }), Option.some("2.4.9"));
		}),
	);

	it.effect("falls back to biome.json, and stops at the first file it finds", () =>
		Effect.gen(function* () {
			const calls: Calls = { accessed: [], read: [] };
			const version = yield* run(Option.none(), { [JSON_]: `{"$schema": "${schemaUrl("2.1.0")}"}` }, calls);

			assert.deepStrictEqual(version, Option.some("2.1.0"));
			assert.deepStrictEqual(calls.accessed, [JSONC, JSON_]);

			// With both present the probe stops at the first.
			const both: Calls = { accessed: [], read: [] };
			const first = yield* run(
				Option.none(),
				{ [JSONC]: `{"$schema": "${schemaUrl("2.4.9")}"}`, [JSON_]: `{"$schema": "${schemaUrl("2.1.0")}"}` },
				both,
			);
			assert.deepStrictEqual(first, Option.some("2.4.9"));
			assert.deepStrictEqual(both.accessed, [JSONC]);
		}),
	);

	it.effect("reports no Biome when neither config file is there", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* run(Option.none()), Option.none());
		}),
	);

	it.effect("reports no Biome when the config file cannot be read", () =>
		Effect.gen(function* () {
			// The file exists and the read fails — a permission problem, say. v1 read
			// that as "{}" and carried on (oracle 7), and so does this: a repository
			// with an unreadable biome config is not a repository this action should
			// fail.
			const files = { [JSONC]: `{"$schema": "${schemaUrl("2.4.9")}"}` };
			const version = yield* detectBiome(Option.none()).pipe(
				Effect.provide(fileSystemTest(files, undefined, { unreadable: new Set([JSONC]) })),
			);
			assert.deepStrictEqual(version, Option.none());
		}),
	);

	it.effect("reports no Biome when the config file is not parseable", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* run(Option.none(), { [JSONC]: "{ this is not json" }), Option.none());
		}),
	);

	it.effect("reports no Biome when the config has no $schema", () =>
		Effect.gen(function* () {
			assert.deepStrictEqual(yield* run(Option.none(), { [JSONC]: `{"formatter": {"enabled": true}}` }), Option.none());
		}),
	);

	it.effect("survives a $schema that is not a string", () =>
		Effect.gen(function* () {
			// v1's latent defect (oracle 11): a truthy non-string `$schema` reached
			// `.match` and threw an unhandled `TypeError`, which killed the action.
			// Three shapes, because only the object one is truthy in v1's guard.
			for (const schema of ["12", "{}", "[]"]) {
				assert.deepStrictEqual(yield* run(Option.none(), { [JSONC]: `{"$schema": ${schema}}` }), Option.none());
			}
		}),
	);

	it.effect("reports no Biome when the $schema url is not a version url", () =>
		Effect.gen(function* () {
			for (const schema of [
				"https://biomejs.dev/schema.json",
				"./node_modules/@biomejs/biome/configuration_schema.json",
				"",
			]) {
				assert.deepStrictEqual(yield* run(Option.none(), { [JSONC]: `{"$schema": "${schema}"}` }), Option.none());
			}
		}),
	);

	it.effect("takes the version from any host, and does not validate it", () =>
		Effect.gen(function* () {
			// The regex is v1's, unanchored and host-agnostic (oracle 10): a vendored
			// or mirrored schema url resolves the same way, and a moving tag in the
			// url is a version this step passes along rather than judges.
			const mirrored = "https://internal.example/mirror/biomejs/schemas/2.4.9/schema.json";
			assert.deepStrictEqual(
				yield* run(Option.none(), { [JSONC]: `{"$schema": "${mirrored}"}` }),
				Option.some("2.4.9"),
			);
			assert.deepStrictEqual(
				yield* run(Option.none(), { [JSONC]: `{"$schema": "${schemaUrl("next")}"}` }),
				Option.some("next"),
			);
		}),
	);

	it.effect("says what it detected", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			yield* detectBiome(Option.none()).pipe(
				Effect.provide(
					Layer.mergeAll(
						fileSystemTest({ [JSONC]: `{"$schema": "${schemaUrl("2.4.9")}"}` }),
						Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
						Layer.succeed(References.MinimumLogLevel)("Debug"),
					),
				),
			);

			// v1's line, verbatim (oracle 12).
			assert.include(logs, "Detected Biome: 2.4.9");
		}),
	);
});
