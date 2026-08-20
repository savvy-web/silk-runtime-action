import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { detectBats } from "../../../src/steps/detect-bats.js";

/**
 * A filesystem double answering from a fixed file map.
 *
 * `dirs` names each directory's entries; anything listed there is a directory,
 * anything else that is asked about is a regular file. That is what lets a case
 * model the entry `detectBats` must reject — a *directory* whose name ends in
 * `.bats` — rather than only the file it must accept.
 */
const fsWith = (files: Record<string, string>, dirs: Record<string, ReadonlyArray<string>> = {}) =>
	FileSystem.layerNoop({
		readFileString: (path: string) =>
			path in files ? Effect.succeed(files[path] as string) : Effect.fail(new Error(`no such file: ${path}`) as never),
		readDirectory: (path: string) => Effect.succeed([...(dirs[path] ?? [])]),
		stat: (path: string) =>
			Effect.succeed({ type: path in dirs ? "Directory" : "File" } as unknown as FileSystem.File.Info),
	});

const AUTO = { bats: "auto", kcov: "auto" } as const;

describe("detectBats", () => {
	it.effect("installs nothing when the repository shows no bash testing", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats(AUTO);
			expect(decision).toEqual({ installBats: false, installKcov: false });
		}).pipe(Effect.provide(fsWith({ "package.json": JSON.stringify({ name: "x" }) }))),
	);

	it.effect("installs when vitest-bats is a devDependency, with no .bats file present", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats(AUTO);
			expect(decision).toEqual({ installBats: true, installKcov: true });
		}).pipe(
			Effect.provide(
				fsWith({
					"package.json": JSON.stringify({ devDependencies: { "vitest-bats": "workspace:*" } }),
				}),
			),
		),
	);

	it.effect("installs when a .bats file exists, with no vitest-bats dependency", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats(AUTO);
			expect(decision.installBats).toBe(true);
		}).pipe(
			Effect.provide(fsWith({ "package.json": JSON.stringify({ name: "x" }) }, { ".": ["test"], test: ["cli.bats"] })),
		),
	);

	it.effect("does not count a *directory* whose name ends in .bats", () =>
		Effect.gen(function* () {
			// `readDirectory` reports directories alongside files, so a name check
			// alone would provision the whole toolchain for a repository holding no
			// test file at all.
			const decision = yield* detectBats(AUTO);
			expect(decision).toEqual({ installBats: false, installKcov: false });
		}).pipe(
			Effect.provide(
				fsWith({ "package.json": JSON.stringify({ name: "x" }) }, { ".": ["fixtures.bats"], "fixtures.bats": [] }),
			),
		),
	);

	it.effect("never descends into node_modules", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats(AUTO);
			expect(decision.installBats).toBe(false);
		}).pipe(
			Effect.provide(
				fsWith(
					{ "package.json": JSON.stringify({ name: "x" }) },
					{ ".": ["node_modules"], node_modules: ["vendored.bats"] },
				),
			),
		),
	);

	it.effect("forces the install when bats is explicitly on, without touching the filesystem", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats({ bats: "on", kcov: "auto" });
			expect(decision).toEqual({ installBats: true, installKcov: true });
		}).pipe(Effect.provide(FileSystem.layerNoop({}))),
	);

	it.effect("skips everything when bats is explicitly off, kcov included", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats({ bats: "off", kcov: "on" });
			expect(decision).toEqual({ installBats: false, installKcov: false });
		}).pipe(Effect.provide(FileSystem.layerNoop({}))),
	);

	it.effect("takes bats without kcov when kcov is explicitly off", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats({ bats: "on", kcov: "off" });
			expect(decision).toEqual({ installBats: true, installKcov: false });
		}).pipe(Effect.provide(FileSystem.layerNoop({}))),
	);

	it.effect("treats an unreadable package.json as no dependency signal, not a failure", () =>
		Effect.gen(function* () {
			const decision = yield* detectBats(AUTO);
			expect(decision.installBats).toBe(false);
		}).pipe(Effect.provide(fsWith({}))),
	);
});
