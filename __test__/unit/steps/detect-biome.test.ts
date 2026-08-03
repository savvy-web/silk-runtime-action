import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Logger, Option, PlatformError, References } from "effect";

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
 * A `FileSystem` serving `files` — keyed by the relative path the step probes —
 * and nothing else.
 *
 * @remarks
 * `access` fails for anything absent, which is how a missing config file looks
 * to the real filesystem. Every other member is left to `layerNoop`, so a step
 * reaching for one shows up as a failure rather than a silent success.
 */
const fileSystemTest = (
	files: Readonly<Record<string, string>>,
	calls: Calls = { accessed: [], read: [] },
	options: { readonly unreadable?: ReadonlySet<string> } = {},
): Layer.Layer<FileSystem.FileSystem> =>
	FileSystem.layerNoop({
		access: (path) => {
			calls.accessed.push(path);
			return path in files
				? Effect.void
				: Effect.fail(
						PlatformError.systemError({
							_tag: "NotFound",
							module: "FileSystem",
							method: "access",
							pathOrDescriptor: path,
						}),
					);
		},
		readFileString: (path) => {
			calls.read.push(path);
			const contents = files[path];
			return contents === undefined || options.unreadable?.has(path) === true
				? Effect.fail(
						PlatformError.systemError({
							_tag: "PermissionDenied",
							module: "FileSystem",
							method: "readFileString",
							pathOrDescriptor: path,
						}),
					)
				: Effect.succeed(contents);
		},
	});

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

			expect(version).toStrictEqual(Option.some("2.3.14"));
			expect(calls.accessed).toEqual([]);
			expect(calls.read).toEqual([]);
		}),
	);

	it.effect("trims the requested version", () =>
		Effect.gen(function* () {
			// Deviation from v1, which passed " 2.3.14 " straight into a download url
			// (oracle quirk 3). The trim is the whole fix: the version is a path
			// segment in the release url, and padding makes it a 404.
			expect(yield* run(Option.some("  2.3.14\n"))).toStrictEqual(Option.some("2.3.14"));
		}),
	);

	it.effect("reads a blank requested version as no request at all", () =>
		Effect.gen(function* () {
			const calls: Calls = { accessed: [], read: [] };
			const version = yield* run(Option.some("   "), { [JSONC]: `{"$schema": "${schemaUrl("2.4.9")}"}` }, calls);

			// Empty-after-trim is absent, so the config file decides — the same
			// reading `ActionInput` already gives the empty string.
			expect(version).toStrictEqual(Option.some("2.4.9"));
			expect(calls.read).toEqual([JSONC]);
		}),
	);

	it.effect("does not validate the requested version", () =>
		Effect.gen(function* () {
			// v1 parity, consciously kept (oracle quirk 4): biome's tags are npm
			// -style and the url encodes whatever is asked for, so "latest" and
			// "nightly" are legitimate values this step has no business refusing.
			expect(yield* run(Option.some("latest"))).toStrictEqual(Option.some("latest"));
		}),
	);

	it.effect("reads the version out of biome.jsonc's $schema", () =>
		Effect.gen(function* () {
			const version = yield* run(Option.none(), { [JSONC]: `{"$schema": "${schemaUrl("2.4.9")}"}` });
			expect(version).toStrictEqual(Option.some("2.4.9"));
		}),
	);

	it.effect("parses the config as JSONC, comments and all", () =>
		Effect.gen(function* () {
			const contents = `{
				// the version this repository pins
				"$schema": "${schemaUrl("2.4.9")}",
				"formatter": { "enabled": true },
			}`;
			expect(yield* run(Option.none(), { [JSONC]: contents })).toStrictEqual(Option.some("2.4.9"));
		}),
	);

	it.effect("falls back to biome.json, and stops at the first file it finds", () =>
		Effect.gen(function* () {
			const calls: Calls = { accessed: [], read: [] };
			const version = yield* run(Option.none(), { [JSON_]: `{"$schema": "${schemaUrl("2.1.0")}"}` }, calls);

			expect(version).toStrictEqual(Option.some("2.1.0"));
			expect(calls.accessed).toEqual([JSONC, JSON_]);

			// With both present the probe stops at the first.
			const both: Calls = { accessed: [], read: [] };
			const first = yield* run(
				Option.none(),
				{ [JSONC]: `{"$schema": "${schemaUrl("2.4.9")}"}`, [JSON_]: `{"$schema": "${schemaUrl("2.1.0")}"}` },
				both,
			);
			expect(first).toStrictEqual(Option.some("2.4.9"));
			expect(both.accessed).toEqual([JSONC]);
		}),
	);

	it.effect("reports no Biome when neither config file is there", () =>
		Effect.gen(function* () {
			expect(yield* run(Option.none())).toStrictEqual(Option.none());
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
			expect(version).toStrictEqual(Option.none());
		}),
	);

	it.effect("reports no Biome when the config file is not parseable", () =>
		Effect.gen(function* () {
			expect(yield* run(Option.none(), { [JSONC]: "{ this is not json" })).toStrictEqual(Option.none());
		}),
	);

	it.effect("reports no Biome when the config has no $schema", () =>
		Effect.gen(function* () {
			expect(yield* run(Option.none(), { [JSONC]: `{"formatter": {"enabled": true}}` })).toStrictEqual(Option.none());
		}),
	);

	it.effect("survives a $schema that is not a string", () =>
		Effect.gen(function* () {
			// v1's latent defect (oracle 11): a truthy non-string `$schema` reached
			// `.match` and threw an unhandled `TypeError`, which killed the action.
			// Three shapes, because only the object one is truthy in v1's guard.
			for (const schema of ["12", "{}", "[]"]) {
				expect(yield* run(Option.none(), { [JSONC]: `{"$schema": ${schema}}` })).toStrictEqual(Option.none());
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
				expect(yield* run(Option.none(), { [JSONC]: `{"$schema": "${schema}"}` })).toStrictEqual(Option.none());
			}
		}),
	);

	it.effect("takes the version from any host, and does not validate it", () =>
		Effect.gen(function* () {
			// The regex is v1's, unanchored and host-agnostic (oracle 10): a vendored
			// or mirrored schema url resolves the same way, and a moving tag in the
			// url is a version this step passes along rather than judges.
			const mirrored = "https://internal.example/mirror/biomejs/schemas/2.4.9/schema.json";
			expect(yield* run(Option.none(), { [JSONC]: `{"$schema": "${mirrored}"}` })).toStrictEqual(Option.some("2.4.9"));
			expect(yield* run(Option.none(), { [JSONC]: `{"$schema": "${schemaUrl("next")}"}` })).toStrictEqual(
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
			expect(logs).toContain("Detected Biome: 2.4.9");
		}),
	);
});
