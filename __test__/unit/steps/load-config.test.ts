import { assert, describe, it } from "@effect/vitest";
import { MemoryFileSystem } from "@effected/memfs";
import type { FileSystem } from "effect";
import { Effect, Layer, Logger, Path } from "effect";

import type { ConfigError } from "../../../src/schema/domain.js";
import { loadConfig } from "../../../src/steps/load-config.js";

/**
 * A real in-memory volume holding one `package.json` whose contents are
 * `content`, wrapped in a recorder that pushes each requested path into `seen`.
 *
 * @remarks
 * The recorder is a `layerFaulty` handler that returns `undefined` — the
 * delegate-by-default form — so the read still goes to the volume and only the
 * path is observed. That is what lets a test assert the literal, cwd-relative
 * `"package.json"` lookup (oracle 15/39) without the double also having to
 * decide what a read answers.
 *
 * A volume rather than a hand-stubbed `readFileString` matters for the failure
 * half of this suite: an unseeded path fails `NotFound` the way the real
 * filesystem does, instead of whatever a stub's author remembered to write.
 */
const fsServing = (content: string, seen: string[] = []): Layer.Layer<FileSystem.FileSystem | Path.Path> =>
	Layer.mergeAll(
		MemoryFileSystem.layerFaulty({
			readFileString: (path) => {
				seen.push(path);
				return undefined;
			},
		}).pipe(Layer.provide(MemoryFileSystem.layerWith({ "/package.json": content }))),
		Path.layer,
	);

/** `loadConfig` against a `package.json` whose contents are `json`. */
const load = (json: string, seen?: string[]) => loadConfig.pipe(Effect.provide(fsServing(json, seen)));

/** `loadConfig` against a workspace with no readable `package.json` at all. */
const loadMissing = loadConfig.pipe(Effect.provide(Layer.mergeAll(MemoryFileSystem.layer, Path.layer)));

/** Runs `effect` expecting failure, and yields the `ConfigError` it failed with. */
const failureOf = <A>(effect: Effect.Effect<A, ConfigError, never>): Effect.Effect<ConfigError, A> =>
	Effect.flip(effect);

/** A `devEngines` block that decodes cleanly, for tests that vary one field. */
const validDevEngines = {
	packageManager: { name: "pnpm", version: "10.20.0" },
	runtime: { name: "node", version: "24.11.0" },
};

describe("loadConfig", () => {
	it.effect("reads package.json and returns the decoded devEngines config", () =>
		Effect.gen(function* () {
			const seen: string[] = [];
			const config = yield* load(
				JSON.stringify({
					devEngines: {
						packageManager: { name: "pnpm", version: "10.20.0" },
						runtime: { name: "node", version: "24.11.0" },
					},
				}),
				seen,
			);
			assert.deepStrictEqual(seen, ["package.json"]);
			assert.strictEqual(config.packageManager.name, "pnpm");
			assert.strictEqual(config.packageManager.version, "10.20.0");
			// Field-by-field rather than a deep compare against an object literal:
			// `runtimes` holds decoded `RuntimeSpec` instances, and `assert.*` compares
			// prototypes where `expect(...).toEqual` did not.
			assert.lengthOf(config.runtimes, 1);
			assert.strictEqual(config.runtimes[0].name, "node");
			assert.strictEqual(config.runtimes[0].version, "24.11.0");
		}),
	);

	it.effect("normalizes a single runtime object into an array of one", () =>
		Effect.gen(function* () {
			const config = yield* load(
				JSON.stringify({
					devEngines: {
						packageManager: { name: "bun", version: "1.3.3" },
						runtime: { name: "bun", version: "1.3.3" },
					},
				}),
			);
			assert.lengthOf(config.runtimes, 1);
			assert.strictEqual(config.runtimes[0].name, "bun");
			assert.strictEqual(config.runtimes[0].version, "1.3.3");
		}),
	);

	it.effect("preserves an array of runtimes in declaration order", () =>
		Effect.gen(function* () {
			const config = yield* load(
				JSON.stringify({
					devEngines: {
						packageManager: { name: "pnpm", version: "10.20.0" },
						runtime: [
							{ name: "deno", version: "2.5.6" },
							{ name: "node", version: "24.11.0" },
							{ name: "bun", version: "1.3.3" },
						],
					},
				}),
			);
			assert.deepStrictEqual(
				config.runtimes.map((r) => r.name),
				["deno", "node", "bun"],
			);
			assert.deepStrictEqual(
				config.runtimes.map((r) => r.version),
				["2.5.6", "24.11.0", "1.3.3"],
			);
		}),
	);

	it.effect("ignores unrelated top-level package.json keys", () =>
		Effect.gen(function* () {
			const config = yield* load(
				JSON.stringify({
					name: "my-project",
					version: "1.0.0",
					scripts: { build: "tsc" },
					dependencies: { effect: "4.0.0" },
					devEngines: {
						packageManager: { name: "pnpm", version: "10.20.0" },
						runtime: { name: "node", version: "24.11.0" },
					},
				}),
			);
			assert.strictEqual(config.packageManager.name, "pnpm");
		}),
	);

	it.effect("ignores a top-level packageManager pin, reading devEngines only", () =>
		Effect.gen(function* () {
			const config = yield* load(
				JSON.stringify({
					packageManager: "yarn@4.0.0",
					devEngines: {
						packageManager: { name: "pnpm", version: "10.20.0" },
						runtime: { name: "node", version: "24.11.0" },
					},
				}),
			);
			assert.strictEqual(config.packageManager.name, "pnpm");
			assert.strictEqual(config.packageManager.version, "10.20.0");
		}),
	);

	it.effect("parses onFail on both entry kinds without interpreting it", () =>
		Effect.gen(function* () {
			const config = yield* load(
				JSON.stringify({
					devEngines: {
						packageManager: { name: "pnpm", version: "10.20.0", onFail: "error" },
						runtime: { name: "node", version: "24.11.0", onFail: "ignore" },
					},
				}),
			);
			assert.strictEqual(config.packageManager.onFail, "error");
			assert.strictEqual(config.runtimes[0].onFail, "ignore");
		}),
	);

	it.effect("accepts a package manager version carrying an integrity hash", () =>
		Effect.gen(function* () {
			const config = yield* load(
				JSON.stringify({
					devEngines: {
						packageManager: { name: "pnpm", version: "11.8.0+sha512.c1f5eaa1" },
						runtime: { name: "node", version: "24.11.0" },
					},
				}),
			);
			assert.strictEqual(config.packageManager.version, "11.8.0+sha512.c1f5eaa1");
		}),
	);
});

describe("loadConfig — failures", () => {
	it.effect("fails with missing-package-json when no manifest can be read", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(loadMissing);
			assert.strictEqual(error._tag, "ConfigError");
			assert.strictEqual(error.reason, "missing-package-json");
			assert.strictEqual(
				error.message,
				"package.json not found. This action requires a package.json with devEngines.packageManager and devEngines.runtime fields.",
			);
			// The cause is the untouched filesystem failure — the point of keeping
			// it is that it still says which read failed, and on what.
			const cause = error.cause as { _tag: string; reason: { _tag: string; method: string; pathOrDescriptor: string } };
			assert.strictEqual(cause._tag, "PlatformError");
			assert.strictEqual(cause.reason._tag, "NotFound");
			// `readFile`, not `readFileString`: the volume derives the string form from
			// the byte read, so the error names the primitive that actually missed —
			// which is also what the real Node filesystem reports.
			assert.strictEqual(cause.reason.method, "readFile");
			assert.strictEqual(cause.reason.pathOrDescriptor, "package.json");
		}),
	);

	it.effect("fails with malformed-json when package.json is not valid JSON", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load("{ not json"));
			assert.strictEqual(error.reason, "malformed-json");
			assert.strictEqual(error.message, "Failed to parse package.json: Invalid JSON");
			// Whatever JSON.parse threw, verbatim — the collapsed message says
			// nothing about where the JSON went wrong, so the cause must.
			assert.instanceOf(error.cause, SyntaxError);
		}),
	);

	it.effect("rejects JSONC — comments are not stripped before parsing", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(`{\n\t// a comment\n\t"devEngines": {}\n}`));
			assert.strictEqual(error.reason, "malformed-json");
		}),
	);

	it.effect("fails with invalid-dev-engines when devEngines is absent", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(JSON.stringify({ name: "my-project" })));
			assert.strictEqual(error.reason, "invalid-dev-engines");
			assert.strictEqual(error.message, "package.json has invalid or missing devEngines field");
			// The message is deliberately field-blind (oracle 45), so the schema
			// issue riding in `cause` is the only thing that can say what broke.
			const cause = error.cause as { _tag: string; issue: unknown; message: string };
			assert.strictEqual(cause._tag, "SchemaError");
			assert.isDefined(cause.issue);
			assert.include(cause.message, "devEngines");
		}),
	);

	it.effect("collapses a deep decode failure into the same message as an absent devEngines", () =>
		Effect.gen(function* () {
			const absent = yield* failureOf(load(JSON.stringify({ name: "my-project" })));
			const deep = yield* failureOf(
				load(
					JSON.stringify({
						devEngines: { ...validDevEngines, runtime: { name: "node", version: "not-a-version" } },
					}),
				),
			);
			assert.strictEqual(deep.reason, "invalid-dev-engines");
			assert.strictEqual(deep.message, absent.message);
			// Same collapsed message, different cause: the diagnostic detail the
			// message drops is not lost, only relocated.
			const cause = deep.cause as { _tag: string; message: string };
			assert.strictEqual(cause._tag, "SchemaError");
			assert.include(cause.message, "version");
			assert.notStrictEqual(cause.message, (absent.cause as { message: string }).message);
		}),
	);

	it.effect("rejects a devEngines block with no packageManager", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(JSON.stringify({ devEngines: { runtime: validDevEngines.runtime } })));
			assert.strictEqual(error.reason, "invalid-dev-engines");
		}),
	);

	it.effect("rejects a devEngines block with no runtime", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(JSON.stringify({ devEngines: { packageManager: validDevEngines.packageManager } })),
			);
			assert.strictEqual(error.reason, "invalid-dev-engines");
		}),
	);

	it.effect("rejects an empty runtime array", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: [] } })));
			assert.strictEqual(error.reason, "invalid-dev-engines");
		}),
	);

	for (const range of ["^24.0.0", "~24.0.0", ">=24.0.0", "24.x", "*"]) {
		it.effect(`rejects the semver range "${range}" in the runtime slot`, () =>
			Effect.gen(function* () {
				const error = yield* failureOf(
					load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: { name: "node", version: range } } })),
				);
				assert.strictEqual(error.reason, "invalid-dev-engines");
			}),
		);

		it.effect(`rejects the semver range "${range}" in the packageManager slot`, () =>
			Effect.gen(function* () {
				const error = yield* failureOf(
					load(
						JSON.stringify({ devEngines: { ...validDevEngines, packageManager: { name: "pnpm", version: range } } }),
					),
				);
				assert.strictEqual(error.reason, "invalid-dev-engines");
			}),
		);
	}

	it.effect("rejects an unsupported runtime name", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: { name: "ruby", version: "3.4.1" } } })),
			);
			assert.strictEqual(error.reason, "invalid-dev-engines");
		}),
	);

	it.effect("rejects an unsupported package manager name", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(
					JSON.stringify({ devEngines: { ...validDevEngines, packageManager: { name: "bundler", version: "2.5.0" } } }),
				),
			);
			assert.strictEqual(error.reason, "invalid-dev-engines");
		}),
	);

	it.effect("rejects a runtime entry with no name", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: { version: "24.11.0" } } })),
			);
			assert.strictEqual(error.reason, "invalid-dev-engines");
		}),
	);

	it.effect("rejects a runtime entry with no version", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: { name: "node" } } })),
			);
			assert.strictEqual(error.reason, "invalid-dev-engines");
		}),
	);

	it.effect("rejects a non-object runtime entry", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: "node@24" } })));
			assert.strictEqual(error.reason, "invalid-dev-engines");
		}),
	);
});

describe("loadConfig — normalization edges", () => {
	it.effect("does not deduplicate repeated runtime entries", () =>
		Effect.gen(function* () {
			const config = yield* load(
				JSON.stringify({
					devEngines: {
						...validDevEngines,
						runtime: [
							{ name: "node", version: "24.11.0" },
							{ name: "node", version: "24.11.0" },
							{ name: "node", version: "22.0.0" },
						],
					},
				}),
			);
			assert.lengthOf(config.runtimes, 3);
			assert.deepStrictEqual(
				config.runtimes.map((r) => r.version),
				["24.11.0", "24.11.0", "22.0.0"],
			);
		}),
	);

	for (const name of ["Node", "NODE"]) {
		it.effect(`matches runtime names case-sensitively, rejecting "${name}"`, () =>
			Effect.gen(function* () {
				const error = yield* failureOf(
					load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: { name, version: "24.11.0" } } })),
				);
				assert.strictEqual(error.reason, "invalid-dev-engines");
			}),
		);
	}

	it.effect('matches package manager names case-sensitively, rejecting "PNPM"', () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(
					JSON.stringify({ devEngines: { ...validDevEngines, packageManager: { name: "PNPM", version: "10.20.0" } } }),
				),
			);
			assert.strictEqual(error.reason, "invalid-dev-engines");
		}),
	);

	it.effect("applies no defaults — an empty devEngines block is a failure, not node/npm", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(JSON.stringify({ devEngines: {} })));
			assert.strictEqual(error.reason, "invalid-dev-engines");
		}),
	);

	// Divergence from legacy, inherited from the Phase A contract: legacy typed
	// `onFail` as a free-form optional string, `RuntimeSpec` narrows it to the
	// npm-documented literals. Every fixture and test uses an in-spec value, so
	// this is a tightening rather than an observed parity break.
	it.effect("rejects an onFail value outside the documented literals", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(
					JSON.stringify({
						devEngines: { ...validDevEngines, runtime: { name: "node", version: "24.11.0", onFail: "explode" } },
					}),
				),
			);
			assert.strictEqual(error.reason, "invalid-dev-engines");
		}),
	);

	it.effect("leaves onFail absent when the manifest omits it", () =>
		Effect.gen(function* () {
			const config = yield* load(JSON.stringify({ devEngines: validDevEngines }));
			assert.isUndefined(config.packageManager.onFail);
			assert.isUndefined(config.runtimes[0].onFail);
		}),
	);

	// Ruling 31. The step decoded silently, which left its group empty in the
	// workflow log while every detection step beside it announced what it found.
	it.effect("says what it decoded, one line per half of devEngines", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			yield* load(
				JSON.stringify({
					devEngines: {
						packageManager: { name: "pnpm", version: "11.8.0" },
						runtime: [
							{ name: "node", version: "26.3.1" },
							{ name: "bun", version: "1.3.3" },
						],
					},
				}),
			).pipe(Effect.provide(Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))])));

			// `@`-joined, unlike the panel's space-separated cells — v1's split per
			// formatter, kept as-is (ruling 54).
			assert.include(logs, "Detected runtime(s): node@26.3.1, bun@1.3.3");
			assert.include(logs, "Detected package manager: pnpm@11.8.0");
		}),
	);
});
