/**
 * Resolves whether this run provisions the BATS toolchain, and kcov with it.
 *
 * @module steps/detect-bats
 */

import { Data, Effect, FileSystem } from "effect";

import type { ToolMode } from "../schema/domain.js";

/** What this run will provision. */
export interface BatsDecision {
	readonly installBats: boolean;
	readonly installKcov: boolean;
}

/**
 * Raised when the repository cannot be inspected.
 *
 * @remarks
 * Declared and never raised, on the same terms as `TurboDetectError`: every
 * read failure resolves to "no signal", because a repository this cannot read
 * is not a repository the action should fail over an optional tool. The union
 * keeps the contract open without making today's tolerance a lie.
 */
export class BatsDetectError extends Data.TaggedError("BatsDetectError")<{
	readonly reason: "read";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** Directories a walk never descends into. */
const SKIP = new Set(["node_modules", ".git", "dist", "coverage", ".turbo"]);

/** How deep the `.bats` walk goes before giving up. */
const MAX_DEPTH = 4;

/**
 * Whether any `*.bats` file exists within {@link MAX_DEPTH} of the working
 * directory.
 *
 * @remarks
 * Depth-bounded and `node_modules`-excluded rather than a full walk: this runs
 * on every job in every consuming repository, and the signal it is looking for
 * lives near the top of a repository that has it. A vendored `.bats` fixture
 * inside a dependency is not this repository's intent to run bats.
 */
const hasBatsFile = (fs: FileSystem.FileSystem, dir: string, depth: number): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		if (depth > MAX_DEPTH) return false;
		const entries = yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));
		for (const entry of entries) {
			if (entry.endsWith(".bats")) return true;
		}
		for (const entry of entries) {
			if (SKIP.has(entry) || entry.startsWith(".")) continue;
			const nested = yield* hasBatsFile(fs, dir === "." ? entry : `${dir}/${entry}`, depth + 1);
			if (nested) return true;
		}
		return false;
	});

/** Whether the root manifest depends on `vitest-bats`, in any dependency set. */
const dependsOnVitestBats = (fs: FileSystem.FileSystem): Effect.Effect<boolean> =>
	Effect.gen(function* () {
		const raw = yield* fs.readFileString("package.json").pipe(Effect.catch(() => Effect.succeed("{}")));
		const parsed = yield* Effect.try(() => JSON.parse(raw) as unknown).pipe(
			Effect.catch(() => Effect.succeed({} as unknown)),
		);
		if (parsed === null || typeof parsed !== "object") return false;
		const manifest = parsed as Record<string, unknown>;
		for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
			const set = manifest[field];
			if (set !== null && typeof set === "object" && "vitest-bats" in (set as object)) return true;
		}
		return false;
	});

/**
 * Resolves the `bats` / `kcov` inputs against the repository.
 *
 * @remarks
 * `auto` looks for two independent signals, and **both are load-bearing**: a
 * `*.bats` file, or `vitest-bats` in the root manifest. They are not
 * redundant — `vitest-bats` generates its `.bats` files at run time and commits
 * none, so for that consumer the glob signal never fires and the manifest
 * signal is the only one that does. A repository with committed `.bats` files
 * and no `vitest-bats` dependency is the mirror case. Both paths must work;
 * neither is a fallback for the other.
 *
 * `on` short-circuits before any filesystem access, matching `detectBiome`'s
 * override posture (oracle 1-2).
 *
 * kcov is gated on bats twice over: `kcov: auto` follows the bats decision, and
 * an explicit `kcov: on` still yields nothing when bats is off. Installing a
 * shell-coverage tool for a repository that runs no shell tests is never what
 * the consumer meant.
 */
export const detectBats = (modes: {
	readonly bats: ToolMode;
	readonly kcov: ToolMode;
}): Effect.Effect<BatsDecision, BatsDetectError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const installBats = yield* resolveBats(modes.bats);
		if (!installBats) return { installBats: false, installKcov: false };
		const installKcov = modes.kcov !== "off";
		yield* Effect.logInfo(installKcov ? "Detected BATS testing (with kcov)" : "Detected BATS testing");
		return { installBats, installKcov };
	});

/** The bats half of the decision. */
const resolveBats = (mode: ToolMode): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		if (mode === "off") return false;
		if (mode === "on") return true;
		const fs = yield* FileSystem.FileSystem;
		if (yield* dependsOnVitestBats(fs)) return true;
		return yield* hasBatsFile(fs, ".", 0);
	});
