import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Logger, Path } from "effect";

import type { ConfigError } from "../../../src/schema/domain.js";
import { loadConfig } from "../../../src/steps/load-config.js";

/**
 * A `FileSystem` serving `content` for every `readFileString`, recording each
 * requested path into `seen` so tests can assert the literal, cwd-relative
 * `"package.json"` lookup (oracle 15/39).
 */
const fsServing = (content: string, seen: string[] = []): Layer.Layer<FileSystem.FileSystem | Path.Path> =>
	Layer.mergeAll(
		FileSystem.layerNoop({
			readFileString: (path) => {
				seen.push(path);
				return Effect.succeed(content);
			},
		}),
		Path.layer,
	);

/** `loadConfig` against a `package.json` whose contents are `json`. */
const load = (json: string, seen?: string[]) => loadConfig.pipe(Effect.provide(fsServing(json, seen)));

/** `loadConfig` against a workspace with no readable `package.json` at all. */
const loadMissing = loadConfig.pipe(Effect.provide(Layer.mergeAll(FileSystem.layerNoop({}), Path.layer)));

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
			expect(seen).toEqual(["package.json"]);
			expect(config.packageManager).toMatchObject({ name: "pnpm", version: "10.20.0" });
			expect(config.runtimes).toEqual([{ name: "node", version: "24.11.0" }]);
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
			expect(config.runtimes).toHaveLength(1);
			expect(config.runtimes[0]).toMatchObject({ name: "bun", version: "1.3.3" });
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
			expect(config.runtimes.map((r) => r.name)).toEqual(["deno", "node", "bun"]);
			expect(config.runtimes.map((r) => r.version)).toEqual(["2.5.6", "24.11.0", "1.3.3"]);
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
			expect(config.packageManager.name).toBe("pnpm");
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
			expect(config.packageManager).toMatchObject({ name: "pnpm", version: "10.20.0" });
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
			expect(config.packageManager.onFail).toBe("error");
			expect(config.runtimes[0].onFail).toBe("ignore");
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
			expect(config.packageManager.version).toBe("11.8.0+sha512.c1f5eaa1");
		}),
	);
});

describe("loadConfig — failures", () => {
	it.effect("fails with missing-package-json when no manifest can be read", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(loadMissing);
			expect(error._tag).toBe("ConfigError");
			expect(error.reason).toBe("missing-package-json");
			expect(error.message).toBe(
				"package.json not found. This action requires a package.json with devEngines.packageManager and devEngines.runtime fields.",
			);
			// The cause is the untouched filesystem failure — the point of keeping
			// it is that it still says which read failed, and on what.
			const cause = error.cause as { _tag: string; reason: { _tag: string; method: string; pathOrDescriptor: string } };
			expect(cause._tag).toBe("PlatformError");
			expect(cause.reason._tag).toBe("NotFound");
			expect(cause.reason.method).toBe("readFileString");
			expect(cause.reason.pathOrDescriptor).toBe("package.json");
		}),
	);

	it.effect("fails with malformed-json when package.json is not valid JSON", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load("{ not json"));
			expect(error.reason).toBe("malformed-json");
			expect(error.message).toBe("Failed to parse package.json: Invalid JSON");
			// Whatever JSON.parse threw, verbatim — the collapsed message says
			// nothing about where the JSON went wrong, so the cause must.
			expect(error.cause).toBeInstanceOf(SyntaxError);
		}),
	);

	it.effect("rejects JSONC — comments are not stripped before parsing", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(`{\n\t// a comment\n\t"devEngines": {}\n}`));
			expect(error.reason).toBe("malformed-json");
		}),
	);

	it.effect("fails with invalid-dev-engines when devEngines is absent", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(JSON.stringify({ name: "my-project" })));
			expect(error.reason).toBe("invalid-dev-engines");
			expect(error.message).toBe("package.json has invalid or missing devEngines field");
			// The message is deliberately field-blind (oracle 45), so the schema
			// issue riding in `cause` is the only thing that can say what broke.
			const cause = error.cause as { _tag: string; issue: unknown; message: string };
			expect(cause._tag).toBe("SchemaError");
			expect(cause.issue).toBeDefined();
			expect(cause.message).toContain("devEngines");
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
			expect(deep.reason).toBe("invalid-dev-engines");
			expect(deep.message).toBe(absent.message);
			// Same collapsed message, different cause: the diagnostic detail the
			// message drops is not lost, only relocated.
			const cause = deep.cause as { _tag: string; message: string };
			expect(cause._tag).toBe("SchemaError");
			expect(cause.message).toContain("version");
			expect(cause.message).not.toBe((absent.cause as { message: string }).message);
		}),
	);

	it.effect("rejects a devEngines block with no packageManager", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(JSON.stringify({ devEngines: { runtime: validDevEngines.runtime } })));
			expect(error.reason).toBe("invalid-dev-engines");
		}),
	);

	it.effect("rejects a devEngines block with no runtime", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(JSON.stringify({ devEngines: { packageManager: validDevEngines.packageManager } })),
			);
			expect(error.reason).toBe("invalid-dev-engines");
		}),
	);

	it.effect("rejects an empty runtime array", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: [] } })));
			expect(error.reason).toBe("invalid-dev-engines");
		}),
	);

	for (const range of ["^24.0.0", "~24.0.0", ">=24.0.0", "24.x", "*"]) {
		it.effect(`rejects the semver range "${range}" in the runtime slot`, () =>
			Effect.gen(function* () {
				const error = yield* failureOf(
					load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: { name: "node", version: range } } })),
				);
				expect(error.reason).toBe("invalid-dev-engines");
			}),
		);

		it.effect(`rejects the semver range "${range}" in the packageManager slot`, () =>
			Effect.gen(function* () {
				const error = yield* failureOf(
					load(
						JSON.stringify({ devEngines: { ...validDevEngines, packageManager: { name: "pnpm", version: range } } }),
					),
				);
				expect(error.reason).toBe("invalid-dev-engines");
			}),
		);
	}

	it.effect("rejects an unsupported runtime name", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: { name: "ruby", version: "3.4.1" } } })),
			);
			expect(error.reason).toBe("invalid-dev-engines");
		}),
	);

	it.effect("rejects an unsupported package manager name", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(
					JSON.stringify({ devEngines: { ...validDevEngines, packageManager: { name: "bundler", version: "2.5.0" } } }),
				),
			);
			expect(error.reason).toBe("invalid-dev-engines");
		}),
	);

	it.effect("rejects a runtime entry with no name", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: { version: "24.11.0" } } })),
			);
			expect(error.reason).toBe("invalid-dev-engines");
		}),
	);

	it.effect("rejects a runtime entry with no version", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(
				load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: { name: "node" } } })),
			);
			expect(error.reason).toBe("invalid-dev-engines");
		}),
	);

	it.effect("rejects a non-object runtime entry", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: "node@24" } })));
			expect(error.reason).toBe("invalid-dev-engines");
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
			expect(config.runtimes).toHaveLength(3);
			expect(config.runtimes.map((r) => r.version)).toEqual(["24.11.0", "24.11.0", "22.0.0"]);
		}),
	);

	for (const name of ["Node", "NODE"]) {
		it.effect(`matches runtime names case-sensitively, rejecting "${name}"`, () =>
			Effect.gen(function* () {
				const error = yield* failureOf(
					load(JSON.stringify({ devEngines: { ...validDevEngines, runtime: { name, version: "24.11.0" } } })),
				);
				expect(error.reason).toBe("invalid-dev-engines");
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
			expect(error.reason).toBe("invalid-dev-engines");
		}),
	);

	it.effect("applies no defaults — an empty devEngines block is a failure, not node/npm", () =>
		Effect.gen(function* () {
			const error = yield* failureOf(load(JSON.stringify({ devEngines: {} })));
			expect(error.reason).toBe("invalid-dev-engines");
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
			expect(error.reason).toBe("invalid-dev-engines");
		}),
	);

	it.effect("leaves onFail absent when the manifest omits it", () =>
		Effect.gen(function* () {
			const config = yield* load(JSON.stringify({ devEngines: validDevEngines }));
			expect(config.packageManager.onFail).toBeUndefined();
			expect(config.runtimes[0].onFail).toBeUndefined();
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
			expect(logs).toContain("Detected runtime(s): node@26.3.1, bun@1.3.3");
			expect(logs).toContain("Detected package manager: pnpm@11.8.0");
		}),
	);
});
