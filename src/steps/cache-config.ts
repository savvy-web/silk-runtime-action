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
 *
 * Every name is anchored at the **workspace root**, not globbed at any depth.
 * All five managers write one lockfile, at the root, and a workspace package's
 * dependency change reaches the key through that file rather than beside it —
 * so a deeper match is never the lockfile an install reads. What a deeper match
 * *is*, reliably, is a test fixture: this repository's own `__fixtures__/`
 * carries five, and `spencerbeggs/effected` carries forty-one under
 * `packages/*\/__test__/fixtures/`. {@link LOCKFILE_EXCLUSIONS} caught those two
 * layouts by name, which is the whole problem with it — it is a denylist of
 * directory conventions, and `test/fixtures/`, `e2e/` or `examples/` walk
 * straight past it and key the cache on files no install ever reads.
 *
 * Anchoring costs the repository that keeps several independent projects side
 * by side, each with its own lockfile. That is what `additional-lockfiles` is
 * for, and it is the case the action already declines to serve elsewhere:
 * `load-config` reads `package.json` from the working directory, so a root
 * manifest is a hard requirement, not a convention.
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
 * These now guard the **caller's** patterns rather than this action's own:
 * {@link lockfilePatterns} anchors every built-in name at the workspace root,
 * where none of these can match. `additional-lockfiles` still takes arbitrary
 * globs, and a consumer writing `**\/deno.lock` should not have it resolve
 * inside `node_modules` or a fixture tree.
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
			packageManagers.flatMap((packageManager) => [
				...lockfileNames(packageManager),
				...(WORKSPACE_CONFIG[packageManager] ?? []),
			]),
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
 * Every global store the active managers download into.
 *
 * @remarks
 * Exported because these are archived under a key of their **own** — see
 * {@link storeKeySegments}. A store is content-addressable and append-only:
 * nothing in it goes stale, a lockfile bump only ever adds to it, and a store
 * from another branch is as good as this branch's. Keying it the way the
 * workspace archive is keyed — on the branch and the exact lockfile digest —
 * threw away a hundreds-of-megabytes download on every branch cut and every
 * dependency bump, for no correctness this cache ever needed.
 */
export const storeCachePaths = (
	packageManagers: ReadonlyArray<PackageManagerName>,
	platform: string,
	home: string,
): ReadonlyArray<string> => {
	const stores = new Set<string>();
	for (const packageManager of packageManagers) {
		for (const store of storePaths(packageManager, platform, home)) stores.add(store);
	}
	return sorted(stores);
};

/**
 * What a manager writes into the workspace itself, beyond its global store.
 *
 * @remarks
 * `packageDirs` is the workspace's own membership — root first, then each
 * package, as root-relative POSIX directories — and each contributes exactly
 * its own `node_modules`. It replaces a bare `**\/node_modules`, which was the
 * `**\/`-glob problem in its most expensive form: the pattern matched every
 * `node_modules` anywhere beneath the checkout, including the ones inside
 * `dist/` trees and test fixtures, so the archive carried directories no
 * install had produced and no restore could use. Enumerating the workspace
 * instead means the archive holds the trees the manager actually linked, and
 * nothing else.
 *
 * deno has none at all: it resolves modules out of its own store and never
 * populates `node_modules`. yarn's PnP layout adds three of its own, at the
 * root, on top of the `node_modules` a non-PnP project still gets.
 */
const workspacePaths = (
	packageManager: PackageManagerName,
	packageDirs: ReadonlyArray<string>,
): ReadonlyArray<string> => {
	const nodeModules = packageDirs.map((dir) => (dir === "." || dir === "" ? "node_modules" : `${dir}/node_modules`));
	switch (packageManager) {
		case "npm":
		case "pnpm":
		case "bun":
			return nodeModules;
		case "yarn":
			return [...nodeModules, ".yarn/cache", ".yarn/unplugged", ".yarn/install-state.gz"];
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
	/**
	 * The workspace's membership as root-relative POSIX directories, root
	 * (`"."`) first — `WorkspaceDiscovery`'s answer, or `["."]` when it had none.
	 */
	readonly packageDirs: ReadonlyArray<string>;
	readonly platform: string;
	readonly home: string;
}

/**
 * Every path the **workspace** archive covers, in the order they are reported.
 *
 * @remarks
 * Three groups, and the order is the contract: the built-ins sorted, then the
 * caller's `additional-cache-paths`, then turbo's artifact directory. Legacy
 * concatenated the same three and lost both the sort and the de-duplication in
 * the process (oracle 22); the sort is restored *within* the built-ins, where
 * it is meaningful, and the final list is de-duplicated because a caller
 * naming a directory already here would otherwise hand `tar` the same tree
 * twice.
 *
 * The managers' global stores are **not** here — they are archived separately,
 * under {@link storeKeySegments}, because they are the one part of this set
 * that a branch cut and a lockfile bump do not invalidate. What remains is
 * exactly the set that a change to the lockfile *does* invalidate: the linked
 * `node_modules` trees, yarn's PnP artifacts, the tool-cache directories, and
 * turbo's local cache.
 *
 * The runtimes' tool-cache directories stay in with the workspace, which means
 * a runtime bump still invalidates the linked trees. That is the right pairing
 * — a `node_modules` with native builds is specific to the runtime that built
 * it — and it is the pairing the split preserves rather than one it introduces.
 */
export const cachePaths = (options: CachePathOptions): ReadonlyArray<string> => {
	const path = pathFor(options.platform);
	const builtIn = new Set<string>();
	for (const packageManager of options.packageManagers) {
		for (const workspace of workspacePaths(packageManager, options.packageDirs)) builtIn.add(workspace);
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
	/** What the dependency install is going to do — see {@link installSegment}. */
	readonly install: InstallPolicy;
}

/** The two inputs that decide what an install leaves on disk. */
export interface InstallPolicy {
	/** The `install-deps` input. */
	readonly deps: boolean;
	/** The `ignore-scripts` input. */
	readonly ignoreScripts: boolean;
}

/**
 * The install policy as one token in the version digest.
 *
 * @remarks
 * The archive is a picture of the workspace *after* the install, so two runs
 * whose installs do different things must not share a key — and before this
 * existed they did. A job passing `install-deps: false` restores, skips the
 * install, and its post phase archives the tool cache with an **empty**
 * `node_modules` and an **empty** package-manager store under exactly the key a
 * full-install job on the same commit would use. Every later run then reports
 * `exact hit`, skips the save (there is nothing to re-save when the key already
 * matches), and installs from the network — a cache that reports a hit while
 * caching nothing, and which nothing ever repairs because the poisoned entry
 * keeps winning. Observed in the wild: an "exact hit" restore followed by pnpm's
 * `reused 0, downloaded 939`.
 *
 * `ignore-scripts` is the same hazard one layer down: a `node_modules` built
 * with lifecycle scripts skipped is missing every `postinstall` artifact — the
 * native builds, the generated files — so restoring it into a run that asked
 * for a full install hands back a tree that looks complete and is not.
 *
 * A skipped install collapses to one token whatever `ignore-scripts` says,
 * because there is no install for it to have changed.
 */
const installSegment = (policy: InstallPolicy): string =>
	policy.deps ? (policy.ignoreScripts ? "deps:no-scripts" : "deps:scripts") : "no-deps";

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
 * unbusted run wrote. {@link installSegment} rides in the same digest for the
 * same reason, and is what keeps a `install-deps: false` job from poisoning the
 * key a full install saves under.
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
		installSegment(options.install),
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

/** Everything {@link storeKeySegments} derives the store cache key from. */
export interface StoreKeySegmentOptions {
	readonly platform: string;
	readonly arch: string;
	/** The managers whose stores are archived, with the versions they run at. */
	readonly packageManagers: ReadonlyArray<ToolEntry>;
	/** The full lockfile digest, or `none` when nothing matched. */
	readonly lockfileHash: Option.Option<string>;
	/** The `cache-bust` input, already normalized. */
	readonly cacheBust: Option.Option<string>;
}

/**
 * The store cache key's segments:
 * `store-platform-arch-managerHash-lockfileHash`.
 *
 * @remarks
 * The `store` literal leads so the two key spaces cannot overlap: a workspace
 * key opens with the platform, and no rung of either ladder can reach the
 * other's entries.
 *
 * What is **absent** is the point. There is no branch segment — a store from
 * another branch is as good as this one's, and keying on the branch meant every
 * branch cut re-downloaded a store it already had. There are no runtime or
 * Biome versions either: a package tarball is the same tarball whichever node
 * unpacks it, so a runtime bump has no business discarding the download.
 *
 * The lockfile digest stays, and it is doing a different job here than it does
 * in {@link keySegments}. A store is append-only, so an older one is never
 * *wrong* — only short. Keeping the digest on the primary key while
 * {@link STORE_RESTORE_DEPTHS} drops it from the one rung below is what makes
 * the entry top up: a changed lockfile misses the primary, hits the rung,
 * restores the previous store, lets the install add what is new, and archives
 * the union under the new digest. Without the digest the key would never change,
 * every run after the first would report an exact hit, and — since an exact hit
 * skips the save — the store would be frozen at whatever the first run happened
 * to download.
 *
 * The manager digest is versioned because the store layout is: pnpm keeps a
 * `v10`/`v11` subdirectory under the path this action archives, and a major
 * bump writes a new one rather than reusing the old.
 */
export const storeKeySegments = (options: StoreKeySegmentOptions): readonly [string, ...ReadonlyArray<string>] => {
	const managers = [
		...Option.match(options.cacheBust, { onNone: () => [], onSome: (bust) => [bust] }),
		...[...options.packageManagers]
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((manager) => `${manager.name}:${manager.version}`),
	].join("");

	return [
		"store",
		options.platform,
		options.arch,
		CacheKey.digest(managers, DIGEST_LENGTH),
		Option.match(options.lockfileHash, {
			onNone: () => EMPTY_LOCKFILE_SEGMENT,
			onSome: (hash) => hash.slice(0, DIGEST_LENGTH),
		}),
	];
};

/**
 * The store cache's restore ladder: one rung, dropping the lockfile digest.
 *
 * @remarks
 * Depth 4 is `store-platform-arch-managerHash-`, which matches every store this
 * platform, architecture and manager version ever archived — the most recent
 * wins. That single rung is the whole self-healing mechanism described on
 * {@link storeKeySegments}, and there is deliberately nothing below it: depth 3
 * would drop the manager version and restore a store laid out for a different
 * major.
 */
export const STORE_RESTORE_DEPTHS = [4] as const;

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
