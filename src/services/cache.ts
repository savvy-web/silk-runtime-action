import { createHash } from "node:crypto";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { ActionCache, ActionEnvironment, ActionState, CommandRunner, Glob } from "@savvy-web/github-action-effects";
import { Effect, Option } from "effect";
import { CacheError } from "../errors/errors.js";
import type { PackageManagerName } from "../schemas/domain.js";
import { CacheState, STATE_KEYS } from "../state.js";

/**
 * Supported package managers for caching.
 */
export type PackageManager = PackageManagerName;

/**
 * Cache configuration for a package manager.
 */
export interface CacheConfig {
	/** Cache directory paths */
	readonly cachePaths: string[];
	/** Lock file patterns to look for */
	readonly lockfilePatterns: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * SHA256 hash truncated to 8 hex characters.
 */
const hashString = (input: string): string => createHash("sha256").update(input).digest("hex").substring(0, 8);

/**
 * Gets default fallback cache paths for a package manager based on the
 * current platform.
 */
/* v8 ignore start -- platform-specific constant mappings, only one branch executes per OS */
export const getDefaultCachePaths = (pm: PackageManager): string[] => {
	const plat = platform();
	const home = homedir();

	switch (pm) {
		case "npm":
			return [plat === "win32" ? join(home, "AppData", "Local", "npm-cache") : join(home, ".npm")];

		case "pnpm":
			return [
				plat === "win32"
					? join(home, "AppData", "Local", "pnpm", "store")
					: join(home, ".local", "share", "pnpm", "store"),
			];

		case "yarn":
			return [
				plat === "win32" ? join(home, "AppData", "Local", "Yarn", "Cache") : join(home, ".yarn", "cache"),
				plat === "win32" ? join(home, "AppData", "Local", "Yarn", "Berry", "cache") : join(home, ".cache", "yarn"),
			];

		case "bun":
			return [
				plat === "win32"
					? join(home, "AppData", "Local", "bun", "install", "cache")
					: join(home, ".bun", "install", "cache"),
			];

		case "deno":
			return [plat === "win32" ? join(home, "AppData", "Local", "deno") : join(home, ".cache", "deno")];
	}
};
/* v8 ignore stop */

/**
 * Lockfile glob patterns per package manager.
 */
export const getLockfilePatterns = (pm: PackageManager): string[] => {
	switch (pm) {
		case "npm":
			return ["**/package-lock.json", "**/npm-shrinkwrap.json"];
		case "pnpm":
			return ["**/pnpm-lock.yaml", "**/pnpm-workspace.yaml", "**/.pnpmfile.cjs"];
		case "yarn":
			return ["**/yarn.lock", "**/.pnp.cjs", "**/.yarn/install-state.gz"];
		case "bun":
			return ["**/bun.lock", "**/bun.lockb"];
		case "deno":
			return ["**/deno.lock"];
	}
};

/**
 * Gets additional dependency paths beyond the global cache directory.
 */
const getAdditionalPaths = (pm: PackageManager): string[] => {
	switch (pm) {
		case "npm":
		case "pnpm":
			return ["**/node_modules"];
		case "yarn":
			return ["**/node_modules", "**/.yarn/cache", "**/.yarn/unplugged", "**/.yarn/install-state.gz"];
		case "bun":
			return ["**/node_modules"];
		case "deno":
			return [];
	}
};

/**
 * Gets tool cache paths for specific runtimes.
 * Tool cache is at /opt/hostedtoolcache on Linux/macOS, C:\\hostedtoolcache on Windows.
 */
const getToolCachePaths = (runtimes: ReadonlyArray<{ name: string; version: string }>): string[] => {
	const plat = platform();
	const toolCacheBase =
		process.env.RUNNER_TOOL_CACHE ?? (plat === "win32" ? "C:\\hostedtoolcache" : "/opt/hostedtoolcache");
	const paths: string[] = [];

	for (const { name, version } of runtimes) {
		if (name === "node" || name === "bun" || name === "deno" || name === "biome") {
			paths.push(join(toolCacheBase, name, version));
		}
	}

	return paths;
};

/**
 * Sorts paths with absolute paths first, then glob patterns, for readability.
 */
const sortPaths = (paths: string[]): string[] => {
	const absolute = paths.filter((p) => !p.startsWith("*")).sort();
	const globs = paths.filter((p) => p.startsWith("*")).sort();
	return [...absolute, ...globs];
};

// ---------------------------------------------------------------------------
// Effectful functions
// ---------------------------------------------------------------------------

/**
 * Queries a package manager for its cache directory.
 * Falls back to platform-specific defaults on failure.
 *
 * Uses CommandRunner.execCapture to run:
 *   npm  → `npm config get cache`
 *   pnpm → `pnpm store path`
 *   yarn → `yarn config get cacheFolder` (Berry), `yarn cache dir` (Classic)
 *   bun  → `bun pm cache`
 *   deno → `deno info --json` → parse denoDir
 */
export const detectCachePath = (pm: PackageManager) =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		const tmpDir = tmpdir();

		const opts = { silent: true, cwd: tmpDir };

		const detected: string | null = yield* Effect.gen(function* () {
			switch (pm) {
				case "npm": {
					const out = yield* runner.execCapture("npm", ["config", "get", "cache"], opts);
					return out.stdout.trim() || null;
				}
				case "pnpm": {
					const out = yield* runner.execCapture("pnpm", ["store", "path"], opts);
					return out.stdout.trim() || null;
				}
				case "yarn": {
					// Try Yarn Berry first
					const berry = yield* runner
						.execCapture("yarn", ["config", "get", "cacheFolder"], opts)
						.pipe(Effect.orElse(() => Effect.succeed({ exitCode: 1, stdout: "", stderr: "" })));
					if (berry.stdout.trim() && berry.stdout.trim() !== "undefined") {
						return berry.stdout.trim();
					}
					/* v8 ignore next 3 -- Yarn Classic fallback, only reached when Berry isn't installed */
					const classic = yield* runner.execCapture("yarn", ["cache", "dir"], opts);
					return classic.stdout.trim() || null;
				}
				case "bun": {
					const out = yield* runner.execCapture("bun", ["pm", "cache"], opts);
					return out.stdout.trim() || null;
				}
				case "deno": {
					const out = yield* runner.execCapture("deno", ["info", "--json"], opts);
					if (out.stdout.trim()) {
						let info: { denoDir?: string } | null = null;
						try {
							info = JSON.parse(out.stdout) as { denoDir?: string };
						} catch {
							// deno info output may not be valid JSON
						}
						return info?.denoDir ?? null;
					}
					return null;
				}
			}
		}).pipe(Effect.orElse(() => Effect.succeed(null)));

		return detected;
	});

/**
 * Gets cache config (paths + lockfile patterns) for a single package manager.
 */
export const getCacheConfig = (pm: PackageManager) =>
	Effect.gen(function* () {
		const detected = yield* detectCachePath(pm).pipe(Effect.orElse(() => Effect.succeed(null)));

		const globalCachePaths = detected ? [detected] : getDefaultCachePaths(pm);
		const additionalPaths = getAdditionalPaths(pm);
		const cachePaths = [...globalCachePaths, ...additionalPaths];
		const lockfilePatterns = getLockfilePatterns(pm);

		return { cachePaths, lockfilePatterns } satisfies CacheConfig;
	});

/**
 * Merges configs from multiple package managers, deduplicating paths.
 * Also includes tool cache paths for the given runtimes.
 */
export const getCombinedCacheConfig = (
	pms: PackageManager[],
	runtimes: ReadonlyArray<{ name: string; version: string }> = [],
) =>
	Effect.gen(function* () {
		const cachePathsSet = new Set<string>();
		const lockfilePatternsSet = new Set<string>();

		for (const pm of pms) {
			const config = yield* getCacheConfig(pm);
			for (const p of config.cachePaths) cachePathsSet.add(p);
			for (const p of config.lockfilePatterns) lockfilePatternsSet.add(p);
		}

		// Add tool cache paths for runtimes
		for (const p of getToolCachePaths(runtimes)) {
			cachePathsSet.add(p);
		}

		return {
			cachePaths: sortPaths(Array.from(cachePathsSet)),
			lockfilePatterns: sortPaths(Array.from(lockfilePatternsSet)),
		} satisfies CacheConfig;
	});

/**
 * Finds lockfiles matching glob patterns using the Glob service.
 * Supports simple filenames and glob patterns. Excludes node_modules and .git.
 */
export const findLockFiles = (patterns: string[]) =>
	Effect.gen(function* () {
		const glob = yield* Glob;
		// Build a single patterns string: include patterns + exclude patterns using ! prefix
		const excludes = "!**/node_modules/**\n!**/.git/**";
		const patternsStr = [...patterns, excludes].join("\n");
		const matches = yield* glob
			.glob(patternsStr)
			.pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>)));
		return [...matches].sort();
	});

/**
 * Hash a list of files using Glob.hashFiles, truncated to 8 hex chars.
 * Returns "" when the files list is empty.
 */
const hashFiles = (files: string[]) =>
	Effect.gen(function* () {
		if (files.length === 0) return "";
		const glob = yield* Glob;
		// Join file paths as a newline-separated pattern string for Glob.hashFiles
		const patternsStr = files.join("\n");
		const result = yield* glob
			.hashFiles(patternsStr)
			.pipe(Effect.catchAll(() => Effect.succeed(Option.none<string>())));
		return Option.getOrElse(result, () => "").substring(0, 8);
	});

/**
 * Gets the branch name from GitHub Actions environment variables.
 * For PRs: uses GITHUB_HEAD_REF.
 * For pushes: strips "refs/heads/" from GITHUB_REF.
 */
const getBranchName = Effect.gen(function* () {
	const env = yield* ActionEnvironment;

	// PR branch
	const headRef = yield* env.getOptional("GITHUB_HEAD_REF");
	if (Option.isSome(headRef) && headRef.value !== "") {
		return headRef.value;
	}

	// Push branch — strip refs/heads/ prefix
	const ref = yield* env.getOptional("GITHUB_REF");
	if (Option.isSome(ref) && ref.value.startsWith("refs/heads/")) {
		return ref.value.replace("refs/heads/", "");
	}

	return "";
});

/**
 * Builds a deterministic version hash from runtime versions and package manager.
 * Optionally prefixes with cacheBust for test cache isolation.
 */
const buildVersionHash = (
	runtimes: ReadonlyArray<{ name: string; version: string }>,
	packageManager: { name: string; version: string },
	cacheBust?: string,
): string => {
	const hasher = createHash("sha256");
	if (cacheBust) hasher.update(cacheBust);
	for (const rt of [...runtimes].sort((a, b) => a.name.localeCompare(b.name))) {
		hasher.update(`${rt.name}:${rt.version}`);
	}
	hasher.update(`${packageManager.name}:${packageManager.version}`);
	return hasher.digest("hex").substring(0, 8);
};

export const generateCacheKey = (
	runtimes: ReadonlyArray<{ name: string; version: string }>,
	packageManager: { name: string; version: string },
	lockfiles: string[],
	cacheBust?: string,
) =>
	Effect.gen(function* () {
		const plat = platform();
		const versionHash = buildVersionHash(runtimes, packageManager, cacheBust);
		const branch = yield* getBranchName;
		const branchHash = hashString(branch || "null");
		const lockfileHash = yield* hashFiles(lockfiles);

		return `${plat}-${versionHash}-${branchHash}-${lockfileHash}`;
	});

/**
 * Generates restore key prefixes for cache fallback.
 * When cacheBust is set (testing), returns empty to force exact matches.
 */
export const generateRestoreKeys = (
	runtimes: ReadonlyArray<{ name: string; version: string }>,
	packageManager: { name: string; version: string },
	cacheBust?: string,
) =>
	Effect.gen(function* () {
		if (cacheBust) return [];

		const plat = platform();
		const versionHash = buildVersionHash(runtimes, packageManager);
		const branch = yield* getBranchName;
		const branchHash = hashString(branch || "null");

		return [`${plat}-${versionHash}-${branchHash}-`, `${plat}-${versionHash}-`];
	});

/**
 * Restores cache and saves state for the post action.
 *
 * Uses ActionCache.restore to attempt cache restoration, then persists
 * the result via ActionState.save so saveCache can decide whether to
 * save a new entry.
 */
export const restoreCache = (config: {
	readonly cachePaths: string[];
	readonly runtimes: ReadonlyArray<{ name: string; version: string }>;
	readonly packageManager: { name: string; version: string };
	readonly lockfiles: string[];
	readonly cacheBust?: string;
}) =>
	Effect.gen(function* () {
		const cache = yield* ActionCache;
		const state = yield* ActionState;

		const primaryKey = yield* generateCacheKey(
			config.runtimes,
			config.packageManager,
			config.lockfiles,
			config.cacheBust,
		);

		const restoreKeys = yield* generateRestoreKeys(config.runtimes, config.packageManager, config.cacheBust);

		// Log cache key details for debugging (debug level — visible with RUNNER_DEBUG=1)
		yield* Effect.logDebug(`Cache primary key: ${primaryKey}`);
		yield* Effect.logDebug(
			`Cache restore keys: ${restoreKeys.length > 0 ? restoreKeys.join(", ") : "(none — exact match only)"}`,
		);
		yield* Effect.logDebug(`Cache paths (${config.cachePaths.length}): ${config.cachePaths.join(", ")}`);
		if (config.cacheBust) {
			yield* Effect.logDebug(`Cache bust value: ${config.cacheBust}`);
		}

		const matchedKey = yield* cache.restore(config.cachePaths, primaryKey, restoreKeys).pipe(
			Effect.mapError(
				(cause) =>
					new CacheError({
						operation: "restore",
						reason: `Failed to restore cache with key ${primaryKey}`,
						cause,
					}),
			),
		);

		// Determine hit status
		const hit = Option.isSome(matchedKey)
			? matchedKey.value === primaryKey
				? ("exact" as const)
				: ("partial" as const)
			: ("none" as const);

		yield* Effect.log(
			`Cache ${hit === "exact" ? "restored (exact match)" : hit === "partial" ? `restored (partial: ${Option.getOrElse(matchedKey, () => "?")})` : "miss"}`,
		);

		// Save state for post action
		yield* state.save(
			STATE_KEYS.cacheState,
			new CacheState({
				key: primaryKey,
				paths: config.cachePaths,
				restored: hit === "exact",
			}),
			CacheState,
		);

		return hit;
	});

/**
 * Saves cache if the previous restore was not an exact hit.
 * Called from post.ts — reads state saved by restoreCache.
 */
export const saveCache = () =>
	Effect.gen(function* () {
		const cache = yield* ActionCache;
		const state = yield* ActionState;

		const cacheState = yield* state.get(STATE_KEYS.cacheState, CacheState).pipe(
			Effect.mapError(
				(cause) =>
					new CacheError({
						operation: "save",
						reason: "Failed to read cache state",
						cause,
					}),
			),
		);

		yield* Effect.log(
			`Cache state from main: restored=${cacheState.restored}, key=${cacheState.key}, paths=${cacheState.paths.length}`,
		);

		// Skip save on exact hit — cache is already up to date
		if (cacheState.restored) {
			yield* Effect.log("Cache exact hit — skipping save");
			return;
		}

		const key = cacheState.key;
		const paths = cacheState.paths;

		if (paths.length === 0) {
			yield* Effect.log("No cache paths — skipping save");
			return;
		}

		yield* Effect.log(`Saving cache: key=${key}, paths (${paths.length}): ${paths.join(", ")}`);

		yield* cache.save(paths, key).pipe(
			Effect.mapError(
				(cause) =>
					new CacheError({
						operation: "save",
						reason: `Failed to save cache with key ${key}`,
						cause,
					}),
			),
		);

		yield* Effect.log(`Cache saved successfully: key=${key}`);
	});
