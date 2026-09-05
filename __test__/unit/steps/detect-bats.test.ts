import { assert, describe, it } from "@effect/vitest";
import type { MemoryFileSystemSeed } from "@effected/memfs";
import { MemoryFileSystem } from "@effected/memfs";
import { Effect } from "effect";

import { detectBats } from "../../../src/steps/detect-bats.js";

/**
 * A real in-memory volume seeded with `seed`.
 *
 * @remarks
 * A volume rather than a hand-stubbed `readDirectory`/`stat` pair, because the
 * distinction this suite exists to prove is one only a real tree can make
 * without the double having agreed to it in advance: a *directory* whose name
 * ends in `.bats` is a directory because it was seeded as one, not because a
 * stub was told to answer `"Directory"` for that path. An unseeded read fails
 * `NotFound`, which is how the unreadable-manifest case is reached.
 *
 * Paths are absolute because the volume is one; the step walks from `"."`,
 * which the volume resolves from its root.
 */
const fsWith = (seed: MemoryFileSystemSeed) => MemoryFileSystem.layerWith(seed);

/** A manifest carrying no bats signal at all. */
const PLAIN_MANIFEST = JSON.stringify({ name: "x" });

/** A minimal, genuinely-a-file `.bats` body. */
const BATS_FILE = "@test 'works' { true; }\n";

const AUTO = { bats: "auto", kcov: "auto" } as const;

describe("detectBats", () => {
	it.effect("installs nothing when the repository shows no bash testing", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats(AUTO);
			assert.deepStrictEqual(decision, { installBats: false, installKcov: false });
		}).pipe(Effect.provide(fsWith({ "/package.json": PLAIN_MANIFEST }))),
	);

	it.effect("installs when vitest-bats is a devDependency, with no .bats file present", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats(AUTO);
			assert.deepStrictEqual(decision, { installBats: true, installKcov: true });
		}).pipe(
			Effect.provide(
				fsWith({
					"/package.json": JSON.stringify({ devDependencies: { "vitest-bats": "workspace:*" } }),
				}),
			),
		),
	);

	it.effect("installs when a .bats file exists, with no vitest-bats dependency", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats(AUTO);
			assert.strictEqual(decision.installBats, true);
		}).pipe(Effect.provide(fsWith({ "/package.json": PLAIN_MANIFEST, "/test/cli.bats": BATS_FILE }))),
	);

	it.effect("does not count a *directory* whose name ends in .bats", () =>
		Effect.gen(function* () {
			// `readDirectory` reports directories alongside files, so a name check
			// alone would provision the whole toolchain for a repository holding no
			// test file at all.
			const decision = yield* detectBats(AUTO);
			assert.deepStrictEqual(decision, { installBats: false, installKcov: false });
		}).pipe(
			Effect.provide(fsWith({ "/package.json": PLAIN_MANIFEST, "/fixtures.bats": MemoryFileSystem.directory() })),
		),
	);

	it.effect("never descends into node_modules", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats(AUTO);
			assert.strictEqual(decision.installBats, false);
		}).pipe(Effect.provide(fsWith({ "/package.json": PLAIN_MANIFEST, "/node_modules/vendored.bats": BATS_FILE }))),
	);

	it.effect("forces the install when bats is explicitly on, without touching the filesystem", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats({ bats: "on", kcov: "auto" });
			assert.deepStrictEqual(decision, { installBats: true, installKcov: true });
		}).pipe(Effect.provide(MemoryFileSystem.layer)),
	);

	it.effect("skips everything when bats is explicitly off, kcov included", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats({ bats: "off", kcov: "on" });
			assert.deepStrictEqual(decision, { installBats: false, installKcov: false });
		}).pipe(Effect.provide(MemoryFileSystem.layer)),
	);

	it.effect("takes bats without kcov when kcov is explicitly off", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats({ bats: "on", kcov: "off" });
			assert.deepStrictEqual(decision, { installBats: true, installKcov: false });
		}).pipe(Effect.provide(MemoryFileSystem.layer)),
	);

	it.effect("treats an unreadable package.json as no dependency signal, not a failure", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats(AUTO);
			assert.strictEqual(decision.installBats, false);
		}).pipe(Effect.provide(fsWith({}))),
	);
});
