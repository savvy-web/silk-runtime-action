import { describe, expect, it } from "@effect/vitest";
import { ScriptedSpawner } from "@effected/commands";
import {
	ActionCache,
	ActionCacheError,
	ActionLogger,
	ActionOutputs,
	ActionState,
	ActionStateError,
	RunnerFileWriteError,
	ToolInstaller,
	ToolInstallerError,
} from "@effected/github-actions";
import { Effect, FileSystem, Layer, Logger, Option, Path, PlatformError, References } from "effect";

import { kcovCacheKey } from "../../../src/descriptors/kcov.js";
import { installKcov } from "../../../src/steps/install-kcov.js";

const HOST = { platform: "linux", arch: "x64" };
const OPTS = {
	host: HOST,
	imageOs: "ubuntu24",
	imageVersion: Option.some("20260801.1"),
	bust: Option.none<string>(),
	toolRoot: "/opt/hostedtoolcache",
};
const KEY = kcovCacheKey("43", "ubuntu24", "x64", Option.none(), Option.some("20260801.1"));
const PRIMARY = KEY.key;
const RUNG = KEY.restoreKeys[0] ?? "";
/**
 * What the real backend answers on a rung match: the **full stored key** of an
 * older entry, not the rung itself. The double returns this so the fallback
 * tests exercise the realistic value.
 */
const OLDER = `${RUNG}20260715.2`;

interface Recorded {
	readonly restored: Array<string>;
	readonly ladders: Array<ReadonlyArray<string>>;
	readonly ran: Array<string>;
	readonly paths: Array<string>;
	readonly env: Array<readonly [string, string]>;
	readonly saved: Array<unknown>;
	readonly logs: Array<string>;
}

const recorder = (): Recorded => ({ restored: [], ladders: [], ran: [], paths: [], env: [], saved: [], logs: [] });

/**
 * What the cache answers: nothing, the primary key exactly, or the fallback
 * prefix rung — the weekly `ImageVersion` bump.
 */
type Restore = "miss" | "primary" | "prefix";

interface LayerOptions {
	readonly restore: Restore;
	/**
	 * The exit code the **first** `kcov --version` answers with. `0` is a healthy
	 * binary; anything else is the restored-but-unloadable case the probe exists
	 * to catch.
	 */
	readonly probeExit: number;
	readonly buildExit?: number;
	readonly restoreFails?: boolean;
	readonly saveFails?: boolean;
	readonly publishFails?: boolean;
	readonly downloadFails?: boolean;
	readonly makeDirectoryFails?: boolean;
	/** No build tool is on `PATH` at all — a spawn failure rather than a non-zero exit. */
	readonly spawnFails?: boolean;
}

const makeLayer = (r: Recorded, options: LayerOptions) => {
	let probes = 0;
	const spawner = ScriptedSpawner.make((command, args) => {
		r.ran.push([command, ...args].join(" "));
		if (command.endsWith("kcov")) {
			probes += 1;
			// The first probe answers `probeExit`; a probe after a rebuild passes,
			// which is what makes the rebuild path's second probe meaningful.
			return { exit: probes === 1 ? options.probeExit : 0, stdout: "kcov 43\n", stderr: "" };
		}
		if (options.spawnFails === true) return ScriptedSpawner.notFound(command);
		return { exit: options.buildExit ?? 0, stdout: "", stderr: "boom\n" };
	});
	return Layer.mergeAll(
		spawner.layer,
		ActionCache.layerTest({
			// A typed `CacheKey` carries its own ladder, which the real service reads
			// off the key rather than taking as a third argument — the double reads it
			// the same way.
			restore: (_paths, key) =>
				options.restoreFails === true
					? Effect.fail(new ActionCacheError({ reason: "unreachable" }))
					: Effect.sync(() => {
							const primary = typeof key === "string" ? key : key.key;
							const rungs = typeof key === "string" ? [] : key.restoreKeys;
							r.restored.push(primary);
							r.ladders.push(rungs);
							if (options.restore === "primary") return Option.some(primary);
							// A rung match answers the full key of the older entry it found.
							if (options.restore === "prefix" && rungs[0] !== undefined) {
								return Option.some(`${rungs[0]}20260715.2`);
							}
							return Option.none<string>();
						}),
		}),
		ActionState.layerTest({
			save: (_key, value) =>
				options.saveFails === true
					? Effect.fail(new ActionStateError({ reason: "writeFailed", key: "silk-runtime-kcov" }))
					: Effect.sync(() => void r.saved.push(value)),
		}),
		ToolInstaller.layerTest({
			download: () =>
				options.downloadFails === true
					? Effect.fail(new ToolInstallerError({ reason: "downloadFailed", subject: "kcov" }))
					: Effect.succeed("/tmp/kcov.tar.gz"),
			extractTar: () => Effect.succeed("/tmp/x"),
		}),
		ActionOutputs.layerTest({
			addPath: (p) =>
				options.publishFails === true
					? Effect.fail(new RunnerFileWriteError({ file: "GITHUB_PATH" }))
					: Effect.sync(() => void r.paths.push(p)),
			exportVariable: (n, v) => Effect.sync(() => void r.env.push([n, v])),
		}),
		FileSystem.layerNoop({
			makeDirectory: (path: string) =>
				options.makeDirectoryFails === true
					? Effect.fail(
							PlatformError.systemError({
								module: "FileSystem",
								method: "makeDirectory",
								_tag: "PermissionDenied",
								pathOrDescriptor: path,
							}),
						)
					: Effect.void,
			access: () => Effect.void,
		}),
		Path.layer,
		ActionLogger.layerTest({}),
		Logger.layer([Logger.make(({ message }) => void r.logs.push(String(message)))]),
		Layer.succeed(References.MinimumLogLevel)("Debug"),
	);
};

describe("installKcov", () => {
	it.effect("installs nothing when the decision was not to install", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installKcov(false, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "miss", probeExit: 0 })),
			);
			expect(Option.isNone(result)).toBe(true);
			expect(r.restored).toEqual([]);
		}),
	);

	it.effect("exact-hits the primary, skips the build, and leaves post nothing to do", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "primary", probeExit: 0 })),
			);
			expect(r.restored).toEqual([PRIMARY]);
			expect(r.ladders).toEqual([[RUNG]]);
			expect(Option.isSome(result) && result.value.cacheHit).toBe(true);
			// The entry already lives under the key a save would use, so there is no
			// state to stash.
			expect(r.saved).toEqual([]);
			// The one thing a hit is worth: no apt, no cmake, no make.
			expect(r.ran).toEqual(["/opt/hostedtoolcache/kcov/43/x64/bin/kcov --version"]);
		}),
	);

	// THE discriminating case: a key that matched, a binary that will not run.
	it.effect("rebuilds when a restored binary fails its probe", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "primary", probeExit: 127 })),
			);
			expect(Option.isSome(result) && result.value.cacheHit).toBe(false);
			expect(r.saved).toHaveLength(1);
			expect(r.logs.some((l) => l.includes("rebuilding"))).toBe(true);
			expect(r.ran.filter((c) => c.endsWith("kcov --version"))).toHaveLength(2);
			expect(r.ran).toContain("make install");
			expect(r.saved[0]).toMatchObject({ primaryKey: PRIMARY, restoredKey: Option.none() });
		}),
	);

	// The weekly `ImageVersion` bump: the primary misses, the prefix rung matches
	// a still-good tree. Skipping the save here is the mistake that leaves the
	// ladder permanently one image behind.
	it.effect("restores from the prefix rung and re-saves under the new primary", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "prefix", probeExit: 0 })),
			);
			expect(Option.isSome(result) && result.value.cacheHit).toBe(true);
			// Warm: restored, probed, published — never built.
			expect(r.ran).toEqual(["/opt/hostedtoolcache/kcov/43/x64/bin/kcov --version"]);
			expect(r.saved).toHaveLength(1);
			expect(r.saved[0]).toMatchObject({ primaryKey: PRIMARY, restoredKey: Option.some(OLDER) });
		}),
	);

	// The self-healing assertion. A poisoned entry restored off the prefix rung is
	// rebuilt and saved under the NEW primary — not the key it came from — so the
	// next run exact-hits a binary that actually runs.
	it.effect("saves a rebuild under the new primary, not the key it restored", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "prefix", probeExit: 127 })),
			);
			expect(Option.isSome(result) && result.value.cacheHit).toBe(false);
			expect(r.ran).toContain("make install");
			expect(r.saved).toHaveLength(1);
			// Saved under the NEW primary with no restored key — never under the key it
			// came from, which is what makes the poisoned entry heal.
			expect(r.saved[0]).toMatchObject({ primaryKey: PRIMARY, restoredKey: Option.none() });
			expect((r.saved[0] as { primaryKey: string }).primaryKey).not.toBe(OLDER);
		}),
	);

	it.effect("builds and stashes save state on a cache miss", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "miss", probeExit: 0 })),
			);
			expect(Option.isSome(result) && result.value.cacheHit).toBe(false);
			expect(r.saved).toHaveLength(1);
			expect(r.paths).toEqual(["/opt/hostedtoolcache/kcov/43/x64/bin"]);
			expect(r.env).toContainEqual(["KCOV_PATH", "/opt/hostedtoolcache/kcov/43/x64/bin/kcov"]);
			expect(r.ran).toEqual([
				"sudo apt-get update",
				"sudo apt-get install -y --no-install-recommends cmake g++ libdw-dev binutils-dev libcurl4-openssl-dev zlib1g-dev pkg-config",
				"cmake -DCMAKE_INSTALL_PREFIX=/opt/hostedtoolcache/kcov/43/x64 /tmp/x/kcov-43",
				"make -j",
				"make install",
				"/opt/hostedtoolcache/kcov/43/x64/bin/kcov --version",
			]);
		}),
	);

	it.effect("installs Homebrew dependencies on macOS", () =>
		Effect.gen(function* () {
			const r = recorder();
			yield* installKcov(true, { ...OPTS, host: { platform: "darwin", arch: "arm64" }, imageOs: "macos15" }).pipe(
				Effect.provide(makeLayer(r, { restore: "miss", probeExit: 0 })),
			);
			const macKey = kcovCacheKey("43", "macos15", "arm64", Option.none(), Option.some("20260801.1"));
			expect(r.restored).toEqual([macKey.key]);
			expect(r.ladders).toEqual([macKey.restoreKeys]);
			expect(r.ran[0]).toBe("brew install dwarfutils openssl@3");
		}),
	);

	it.effect("fails typed on an unsupported platform, without touching the cache", () =>
		Effect.gen(function* () {
			const r = recorder();
			const error = yield* installKcov(true, { ...OPTS, host: { platform: "win32", arch: "x64" } }).pipe(
				Effect.provide(makeLayer(r, { restore: "miss", probeExit: 0 })),
				Effect.flip,
			);
			expect(error.reason).toBe("detect");
			expect(r.restored).toEqual([]);
			expect(r.ladders).toEqual([]);
			expect(r.ran).toEqual([]);
		}),
	);

	it.effect("fails typed when the build itself fails", () =>
		Effect.gen(function* () {
			const r = recorder();
			const error = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "miss", probeExit: 0, buildExit: 2 })),
				Effect.flip,
			);
			expect(error.reason).toBe("build");
			expect(error.message).toContain("boom");
		}),
	);

	// `verify` is deliberately not `build`: this build compiled and still produced
	// something that will not run.
	it.effect("fails with verify when a freshly built binary will not run", () =>
		Effect.gen(function* () {
			const r = recorder();
			const error = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "miss", probeExit: 127 })),
				Effect.flip,
			);
			expect(error.reason).toBe("verify");
			expect(r.saved).toEqual([]);
		}),
	);

	it.effect("treats an unreachable cache as a miss and builds", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "miss", probeExit: 0, restoreFails: true })),
			);
			expect(Option.isSome(result) && result.value.cacheHit).toBe(false);
			expect(r.logs.some((l) => l.includes("cache could not be read"))).toBe(true);
		}),
	);

	it.effect("warns but still installs when the state save fails", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "miss", probeExit: 0, saveFails: true })),
			);
			expect(Option.isSome(result)).toBe(true);
			expect(r.logs.some((l) => l.includes("the next run will rebuild"))).toBe(true);
			expect(r.paths).toHaveLength(1);
		}),
	);

	it.effect("fails typed when the installed tree cannot be published", () =>
		Effect.gen(function* () {
			const r = recorder();
			const error = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "primary", probeExit: 0, publishFails: true })),
				Effect.flip,
			);
			expect(error.reason).toBe("publish");
		}),
	);

	it.effect("fails typed when the source tarball cannot be fetched", () =>
		Effect.gen(function* () {
			const r = recorder();
			const error = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "miss", probeExit: 0, downloadFails: true })),
				Effect.flip,
			);
			expect(error.reason).toBe("download");
		}),
	);

	it.effect("fails typed when the build directory cannot be created", () =>
		Effect.gen(function* () {
			const r = recorder();
			const error = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "miss", probeExit: 0, makeDirectoryFails: true })),
				Effect.flip,
			);
			expect(error.reason).toBe("build");
			expect(error.message).toContain("/tmp/x/build");
		}),
	);

	it.effect("fails typed when a build tool is not on PATH at all", () =>
		Effect.gen(function* () {
			const r = recorder();
			const error = yield* installKcov(true, OPTS).pipe(
				Effect.provide(makeLayer(r, { restore: "miss", probeExit: 0, spawnFails: true })),
				Effect.flip,
			);
			expect(error.reason).toBe("build");
			expect(error.message).toContain("apt-get update could not be run");
		}),
	);

	// `imageVersion` is read from the environment beside `ImageOS`, and every other
	// test in this file supplies it directly — so without this one the `??` and the
	// empty-string guard are executed but never discriminated.
	it.effect("reads ImageVersion from the environment, treating empty as absent", () =>
		Effect.gen(function* () {
			const r = recorder();
			const before = process.env.ImageVersion;
			process.env.ImageVersion = "";
			try {
				const { imageVersion: _ignored, ...withoutImageVersion } = OPTS;
				yield* installKcov(true, withoutImageVersion).pipe(
					Effect.provide(makeLayer(r, { restore: "miss", probeExit: 0 })),
				);
			} finally {
				if (before === undefined) delete process.env.ImageVersion;
				else process.env.ImageVersion = before;
			}
			// Collapsed onto the rung, with no trailing separator and no ladder.
			expect(r.restored).toEqual([RUNG.slice(0, -1)]);
			expect(r.ladders).toEqual([[]]);
		}),
	);
});
