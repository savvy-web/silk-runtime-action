/**
 * What the dependency cache is keyed on and what it covers — as pure
 * functions.
 *
 * @remarks
 * Every decision the cache makes that is not a call to the runner lives here:
 * which package managers are in play, which lockfiles feed the key, which
 * directories are archived, and how the key's segments are laid out. Split out
 * of `restore-cache.ts` because it is all total and host-argument-driven, so a
 * test pins the Windows store paths and the arch segment without a runner, a
 * filesystem, or a mocked `process`.
 *
 * @module steps/cache-config
 */

import { posix, win32 } from "node:path";
import { CacheKey } from "@effected/github-actions";
import { filenamesFor } from "@effected/lockfiles";
import { PackageManagerCache } from "@effected/npm";
import { Option } from "effect";

import type { PackageManagerName, RuntimeConfig } from "../schema/domain.js";

/**
 * A named, versioned tool that participates in the cache — a `devEngines`
 * runtime, the package manager, or Biome.
 */
export interface ToolEntry {
	readonly name: string;
	readonly version: string;
}

/**
 * The package managers this run actually uses.
 *
 * @remarks
 * A runtime, not the manifest, is what makes a manager active (oracle 2): node
 * brings the `devEngines` package manager, while bun and deno are their own.
 * So a workspace declaring `packageManager: pnpm` with only a bun runtime
 * caches bun's store and not pnpm's — pnpm never runs.
 *
 * De-duplicated, first-seen order: bun-as-manager alongside a node runtime
 * names bun twice and contributes one entry.
 */
export const activePackageManagers = (config: RuntimeConfig): ReadonlyArray<PackageManagerName> => {
	const active = new Set<PackageManagerName>();
	for (const runtime of config.runtimes) {
		active.add(runtime.name === "node" ? config.packageManager.name : runtime.name);
	}
	return [...active];
};

/**
 * What each manager contributes to the key *beyond* its lockfile names.
 *
 * @remarks
 * None of these are lockfiles, which is why the kit does not know about them
 * and this table still exists (upstream round 7's ruling: the lockfile names
 * are the kit's, the workspace-config extras stay ours). They change what an
 * install resolves to just as a lockfile does, so they belong in the key, and
 * legacy put them alongside the lockfiles rather than inventing a second list
 * (oracle 1). They land in the `lockfiles` output as a consequence.
 *
 * yarn's `.yarn/install-state.gz` is both an input to the key and a file the
 * cache archives, so a saved cache invalidates the key that saved it. Carried
 * over deliberately: the fixtures pin yarn PnP files as lockfiles, and the
 * self-invalidation costs a rebuild rather than correctness.
 */
const WORKSPACE_CONFIG: Partial<Record<PackageManagerName, ReadonlyArray<string>>> = {
	pnpm: ["pnpm-workspace.yaml", ".pnpmfile.cjs"],
	yarn: [".pnp.cjs", ".yarn/install-state.gz"],
};

/**
 * The lockfile patterns each package manager contributes.
 *
 * @remarks
 * The names come from `@effected/lockfiles`' `filenamesFor`, primaries first,
 * rather than from a table restated here — the kit is where "which files is
 * this format spelled as" is settled, and it knows two this action's own table
 * had to be told about (npm's `npm-shrinkwrap.json`, bun's legacy `bun.lockb`).
 * Every name is globbed at any depth, which is this action's policy and not the
 * kit's: a workspace package's lockfile counts as much as the root's.
 *
 * deno is not in the kit's vocabulary — `LockfileFormat` covers the four npm-
 * ecosystem managers — so its one name stays local rather than being forced
 * into a format that does not have a row for it.
 */
const DENO_LOCKFILES = ["deno.lock"] as const;

const lockfileNames = (packageManager: PackageManagerName): ReadonlyArray<string> =>
	packageManager === "deno" ? DENO_LOCKFILES : filenamesFor(packageManager);

/**
 * Where a lockfile never counts, whatever it is named.
 *
 * @remarks
 * A lockfile only means something at the repository root or in a real workspace
 * package. Inside `node_modules` it belongs to a dependency, and inside a test
 * or fixture tree it is a deliberate fake — this action's own `__fixtures__/`
 * carries five of them. Either would make the key depend on files no install
 * ever reads.
 */
export const LOCKFILE_EXCLUSIONS = [
	"!**/node_modules/**",
	"!**/.git/**",
	"!**/__fixtures__/**",
	"!**/__tests__/**",
	"!**/__test__/**",
] as const;

/** Turbo's local artifact cache — see `turboLocalCachePaths` in the project README. */
export const TURBO_LOCAL_CACHE_PATHS = ["**/.turbo/cache"] as const;

/**
 * Absolute paths first, then globs, each alphabetically.
 *
 * @remarks
 * Presentation only — both lists are consumed as sets — but the `cache-paths`
 * output and the debug log are read by humans, and a stable order is what makes
 * two runs comparable by eye.
 */
const sorted = (paths: Iterable<string>): ReadonlyArray<string> => {
	const all = [...paths];
	return [...all.filter((path) => !path.startsWith("*")).sort(), ...all.filter((path) => path.startsWith("*")).sort()];
};

/**
 * The complete pattern set lockfile discovery runs with: the active managers'
 * patterns, then the caller's, then the exclusions.
 *
 * @remarks
 * The caller's patterns are appended *after* the sort, in the order they were
 * written (oracle 4). That is not an oversight to tidy up: a workflow author
 * reading `additional-lockfiles` back out of the `lockfiles` output should see
 * their own list where they put it.
 */
export const lockfilePatterns = (
	packageManagers: ReadonlyArray<PackageManagerName>,
	additional: ReadonlyArray<string>,
): ReadonlyArray<string> => [
	...sorted(
		new Set(
			packageManagers.flatMap((packageManager) =>
				[...lockfileNames(packageManager), ...(WORKSPACE_CONFIG[packageManager] ?? [])].map((name) => `**/${name}`),
			),
		),
	),
	...additional,
	...LOCKFILE_EXCLUSIONS,
];

/**
 * The path module for `platform`, rather than for the host running this code.
 *
 * @remarks
 * Legacy joined with the host's `node:path`, which is the same thing in
 * production — the platform is always the runner's. Selecting it explicitly is
 * what lets a Linux test pin the Windows store paths, which is the only way the
 * Windows branch is ever exercised outside a Windows runner.
 */
const pathFor = (platform: string) => (platform === "win32" ? win32 : posix);

/**
 * Each manager's default store directory.
 *
 * @remarks
 * Defaults only. Legacy shelled the manager itself for its configured store
 * (`npm config get cache`, `pnpm store path`, …) and fell back to these on any
 * failure — fifty lines of subprocess for a value that, on a GitHub runner with
 * a freshly installed manager, is always the default. Dropped with the
 * detection: no fixture ever asserted a detected store path, and the step now
 * needs no spawner at all.
 *
 * The four npm-ecosystem rows come from `@effected/npm`'s `PackageManagerCache`
 * — a facts table with a cited authority per row — rather than from the verbatim
 * legacy port that stood here, which had three wrong cells and so archived
 * directories the manager never writes to: pnpm's macOS store is
 * `~/Library/pnpm/store` and not the linux path; Classic's and Berry's caches
 * were swapped *and* both misspelled (`~/.yarn/cache` was never either one); and
 * bun uses `~/.bun/install/cache` on every platform, Windows included. A wrong
 * cell costs a cold cache rather than a broken run, which is exactly why it
 * survived a release — nothing fails, the archive is simply empty.
 *
 * yarn contributes two because Berry and Classic disagree about where the cache
 * lives and the manager's major version is not known here — the kit splits them
 * into two literals and refuses a bare `yarn`, so asking for both is the only
 * thing this call site *can* say. deno is out of the kit's vocabulary by scoping
 * and stays local policy.
 */
const storePaths = (packageManager: PackageManagerName, platform: string, home: string): ReadonlyArray<string> => {
	const options = { platform, home };
	switch (packageManager) {
		case "npm":
		case "pnpm":
		case "bun":
			return [PackageManagerCache.defaultDirectory(packageManager, options)];
		case "yarn":
			return [
				PackageManagerCache.defaultDirectory("yarn-classic", options),
				PackageManagerCache.defaultDirectory("yarn-berry", options),
			];
		case "deno":
			return [
				platform === "win32"
					? pathFor(platform).join(home, "AppData", "Local", "deno")
					: pathFor(platform).join(home, ".cache", "deno"),
			];
	}
};

/**
 * What a manager writes into the workspace itself, beyond its global store.
 *
 * @remarks
 * deno has none: it resolves modules out of its own store and never populates
 * `node_modules`. yarn's PnP layout adds three of its own on top of the
 * `node_modules` a non-PnP project still gets.
 */
const workspacePaths = (packageManager: PackageManagerName): ReadonlyArray<string> => {
	switch (packageManager) {
		case "npm":
		case "pnpm":
		case "bun":
			return ["**/node_modules"];
		case "yarn":
			return ["**/node_modules", "**/.yarn/cache", "**/.yarn/unplugged", "**/.yarn/install-state.gz"];
		case "deno":
			return [];
	}
};

/** The tools this action installs into the hostedtoolcache layout. */
const TOOL_CACHE_TOOLS: ReadonlySet<string> = new Set(["node", "bun", "deno", "biome"]);

/** Where the runner image keeps its tool cache, when `RUNNER_TOOL_CACHE` does not say. */
export const defaultToolCacheBase = (platform: string): string =>
	platform === "win32" ? "C:\\hostedtoolcache" : "/opt/hostedtoolcache";

/** Everything {@link cachePaths} derives the archived path set from. */
export interface CachePathOptions {
	readonly packageManagers: ReadonlyArray<PackageManagerName>;
	/** The runtimes this run installs, plus Biome when there is one. */
	readonly tools: ReadonlyArray<ToolEntry>;
	readonly toolCacheBase: string;
	/** The `additional-cache-paths` input, already split into lines. */
	readonly additional: ReadonlyArray<string>;
	/** Whether `turbo.json` was detected. */
	readonly turbo: boolean;
	readonly platform: string;
	readonly home: string;
}

/**
 * Every path this run archives, in the order they are reported.
 *
 * @remarks
 * Three groups, and the order is the contract: the built-ins sorted, then the
 * caller's `additional-cache-paths`, then turbo's artifact directory. Legacy
 * concatenated the same three and lost both the sort and the de-duplication in
 * the process (oracle 22); the sort is restored *within* the built-ins, where
 * it is meaningful, and the final list is de-duplicated because a caller
 * naming `**\/node_modules` would otherwise hand `tar` the same tree twice.
 *
 * The runtimes' tool-cache directories are archived alongside the dependency
 * stores. One archive for everything is legacy's design and is kept: it means a
 * runtime bump invalidates the dependency cache, which is a cost, but the
 * alternative is two caches that can disagree about what was installed.
 */
export const cachePaths = (options: CachePathOptions): ReadonlyArray<string> => {
	const path = pathFor(options.platform);
	const builtIn = new Set<string>();
	for (const packageManager of options.packageManagers) {
		for (const store of storePaths(packageManager, options.platform, options.home)) builtIn.add(store);
		for (const workspace of workspacePaths(packageManager)) builtIn.add(workspace);
	}
	for (const tool of options.tools) {
		if (TOOL_CACHE_TOOLS.has(tool.name)) builtIn.add(path.join(options.toolCacheBase, tool.name, tool.version));
	}
	return [...new Set([...sorted(builtIn), ...options.additional, ...(options.turbo ? TURBO_LOCAL_CACHE_PATHS : [])])];
};

/**
 * The lockfile segment when the pattern set matched nothing.
 *
 * @remarks
 * Legacy left the segment empty, producing a key ending in `-`. `CacheKey`
 * refuses an empty segment outright (`Segment` is `/^[^,\n\r]+$/`), so the
 * no-lockfile case needs a name; `"empty"` is the spelling upstream's own
 * `hashMatching` example uses. Nothing depends on the old shape — a key is not
 * parity surface, and the fixtures only need two runs of the same version to
 * agree.
 */
export const EMPTY_LOCKFILE_SEGMENT = "empty";

/** How many hex characters of a digest a key segment carries. */
const DIGEST_LENGTH = 8;

/** Everything {@link keySegments} derives the cache key from. */
export interface KeySegmentOptions {
	/** `process.platform`: `linux` | `darwin` | `win32`. */
	readonly platform: string;
	/** `process.arch`: `x64` | `arm64` | … */
	readonly arch: string;
	/** The runtimes this run installs, plus Biome when there is one. */
	readonly tools: ReadonlyArray<ToolEntry>;
	readonly packageManager: ToolEntry;
	/** The branch this run is on, or `""` when there is none. */
	readonly branch: string;
	/** The full lockfile digest, or `none` when nothing matched. */
	readonly lockfileHash: Option.Option<string>;
	/** The `cache-bust` input, already normalized. */
	readonly cacheBust: Option.Option<string>;
}

/**
 * The cache key's segments: `platform-arch-versionHash-branchHash-lockfileHash`.
 *
 * @remarks
 * The arch segment is new (legacy had none, oracle 9). Without it an arm64 and
 * an x64 macOS runner share a key and restore each other's tool-cache
 * directories — binaries for the wrong architecture, from a cache that reports
 * a hit.
 *
 * The tools are sorted by name before hashing, so the same workspace keys
 * identically however `devEngines` happens to order its runtimes. The cache
 * bust goes into the *version* digest rather than a segment of its own, which
 * is what lets a busted run keep the same key layout while matching nothing an
 * unbusted run wrote.
 *
 * A branchless run — a tag, a detached HEAD — hashes the literal `"null"`
 * rather than the empty string (oracle 12), so all of them share one key rather
 * than each getting the digest of `""` by accident.
 */
export const keySegments = (options: KeySegmentOptions): readonly [string, ...ReadonlyArray<string>] => {
	// Concatenated and hashed once rather than fed to a streaming digest in the
	// same order: sha256 does not care which, so the segment is byte-identical to
	// the hand-rolled one it replaces, and `CacheKey.digest` owns the truncation
	// that every other key segment in the kit is truncated by.
	const versions = [
		...Option.match(options.cacheBust, { onNone: () => [], onSome: (bust) => [bust] }),
		...[...options.tools]
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((tool) => `${tool.name}:${tool.version}`),
		`${options.packageManager.name}:${options.packageManager.version}`,
	].join("");

	return [
		options.platform,
		options.arch,
		CacheKey.digest(versions, DIGEST_LENGTH),
		CacheKey.digest(options.branch === "" ? "null" : options.branch, DIGEST_LENGTH),
		Option.match(options.lockfileHash, {
			onNone: () => EMPTY_LOCKFILE_SEGMENT,
			onSome: (hash) => hash.slice(0, DIGEST_LENGTH),
		}),
	];
};

/**
 * The restore-key ladder policy for a {@link keySegments} key, as leading
 * segment counts.
 *
 * @remarks
 * Two rungs, not the full ladder `CacheKey` derives by default. Depth 4 drops
 * the lockfile digest and falls back to an earlier cache for the same runtimes
 * on this branch; depth 3 drops the branch as well and reaches across branches.
 * Both restore something installed from the same `devEngines`. The default
 * ladder's remaining rungs (`linux-x64-`, `linux-`) drop the *version* digest,
 * and a cache built for a different Node would restore against them — which is
 * why the policy is carried on the key rather than left derived. Legacy stopped
 * at the same two.
 *
 * Handed to `CacheKey.withRestoreDepths` and read back off the key by
 * `ActionCache.restore`, so the rungs and the primary key cannot drift apart
 * (upstream round 7, item 2). A cache bust needs *no* ladder at all, which no
 * depth expresses — `withRestoreDepths` refuses `0` and refuses an empty list —
 * so that one case builds its key with `withoutRestoreKeys()` instead; see
 * `restore-cache.ts`.
 */
export const RESTORE_DEPTHS = [4, 3] as const;
