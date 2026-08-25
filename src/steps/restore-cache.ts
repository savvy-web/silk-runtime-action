import { homedir } from "node:os";
import type { ActionEnvironmentShape } from "@effected/github-actions";
import { ActionCache, ActionEnvironment, ActionState, CacheKey } from "@effected/github-actions";
import { WorkspaceDiscovery } from "@effected/workspaces";
import type { FileSystem, Path } from "effect";
import { Data, Effect, Option } from "effect";

import type { PackageManagerName, RuntimeConfig } from "../schema/domain.js";
import type { Inputs } from "../schema/inputs.js";
import { CacheState, STATE_KEYS, StoreCacheState } from "../state.js";
import type { ToolEntry } from "./cache-config.js";
import {
	RESTORE_DEPTHS,
	STORE_RESTORE_DEPTHS,
	activePackageManagers,
	cachePaths,
	defaultToolCacheBase,
	keySegments,
	lockfilePatterns,
	storeCachePaths,
	storeKeySegments,
} from "./cache-config.js";

/**
 * Everything the cache key and the restored path set are derived from.
 *
 * @remarks
 * A params object rather than positional arguments: Phase B adds the resolved
 * lockfile set and the active package-manager list here, and a named field is
 * an additive change where a fifth positional argument would not be.
 */
export interface RestoreCacheArgs {
	readonly inputs: Inputs;
	readonly config: RuntimeConfig;
	/** The version `detectBiome` resolved — part of the cache key when present. */
	readonly biomeVersion: Option.Option<string>;
	/** Whether `turbo.json` was detected — decides whether turbo's local artifact cache is restored. */
	readonly turbo: { readonly enabled: boolean };
}

/**
 * Raised when a cache key cannot be computed, or the runner's cache cannot be
 * restored from or saved to.
 *
 * @remarks
 * The shape a cache failure has whether it is raised or absorbed. The restore
 * step never fails the action — a cache is an optimization, and a cold or
 * unreachable one has to leave the run to the installs that follow — so `key`,
 * `restore` and `state` are shaped here and then logged rather than propagated.
 * `save` is the post phase's, which is under the same rule for the same reason.
 * Keeping one taxonomy for all four means the reason and the message a workflow
 * log shows do not depend on which side of that line the failure fell.
 *
 * `state` and `save` are two different writes and get two different literals:
 * `state` is `main` failing to hand the post phase what it restored, `save` is
 * the post phase failing to archive it. Sharing one literal would make a log
 * grep for a failed archive turn up runs whose archive was never attempted.
 */
export class CacheError extends Data.TaggedError("CacheError")<{
	readonly reason: "key" | "restore" | "state" | "save";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/**
 * What this step reads off the run's GitHub context, with the answers a run
 * outside Actions gets.
 *
 * @remarks
 * One read rather than two: `env.github` is a decode of the whole `GITHUB_*`
 * block, and asking it twice would let the workspace and the branch disagree
 * about whether there is a context at all.
 *
 * The branch is `GitHubContext.branch` — `headRef` when the event has one,
 * otherwise `refName`. That fallback matters because on a pull request
 * `GITHUB_REF` names the synthetic merge ref (`refs/pull/12/merge`) rather than
 * the branch, and keying on it would give every pull request a cache of its own
 * that nothing else ever restores. The kit also encodes the trap that made this
 * worth handing over: the runner writes `GITHUB_HEAD_REF` as the **empty
 * string** on non-PR events rather than omitting it, so a raw read reports it
 * present and keys the whole repository under one empty branch.
 *
 * Outside a runner there is no context to read either value from. The workspace
 * falls back to the process's own directory, which is where the checkout would
 * be anyway, and the branch to `""` — which {@link keySegments} hashes as a
 * literal so every contextless run shares one key rather than each getting the
 * digest of `""` by accident.
 *
 * One divergence from the chain this replaces, and it is an improvement rather
 * than a cost: a **tag** push now keys under the tag name, where the old chain
 * saw a ref that was not `refs/heads/*` and answered `""`. Every tag used to
 * share the contextless bucket; each now gets its own, and depth 3 of
 * {@link RESTORE_DEPTHS} drops the branch segment entirely, so the first run on
 * a new tag still restores across from the branch it was cut from.
 */
const context = (env: ActionEnvironmentShape): Effect.Effect<{ readonly workspace: string; readonly branch: string }> =>
	env.github.pipe(
		Effect.map((github) => ({ workspace: github.workspace, branch: github.branch })),
		Effect.catch(() => Effect.sync(() => ({ workspace: process.cwd(), branch: "" }))),
	);

/**
 * Absorbs a failure into `fallback`, logging it as the {@link CacheError} it
 * would otherwise have been.
 *
 * @remarks
 * Every degradation in this step goes through here, so "the restore never
 * fails the action" is one mechanism rather than a rule each call site
 * remembers. `message` takes the cause so a log line can name the reason
 * literal the kit reported — `unreachable` and `archiveFailed` call for
 * completely different responses from whoever reads the log, and the prose
 * alone does not distinguish them.
 */
const absorb = <A, B, E, R>(
	effect: Effect.Effect<A, E, R>,
	reason: CacheError["reason"],
	message: (cause: E) => string,
	fallback: B,
): Effect.Effect<A | B, never, R> =>
	effect.pipe(
		Effect.catch((cause) =>
			Effect.logWarning(new CacheError({ reason, message: message(cause), cause }).message).pipe(Effect.as(fallback)),
		),
	);

/** Both cache entries this step restores, and the state each was persisted as. */
export interface RestoredCaches {
	/** The workspace archive: linked trees, tool cache, turbo's local cache. */
	readonly workspace: CacheState;
	/** The package managers' global stores. */
	readonly store: StoreCacheState;
}

/**
 * The workspace's membership as root-relative POSIX directories, root first.
 *
 * @remarks
 * `WorkspaceDiscovery.listPackages` already answers root-first and sorted, and
 * already reports each member's `relativePath` as POSIX with `"."` for the
 * root — which is exactly the shape {@link cachePaths} wants, so this is a
 * projection rather than a computation.
 *
 * A discovery failure — or an empty answer, which cannot be truthful — degrades
 * to `["."]` rather than failing the step or
 * falling back to a `**\/node_modules` glob. Both alternatives are worse in the
 * same direction: a repository whose layout the kit cannot parse is precisely
 * the one where a wildcard would sweep up fixture and `dist` trees, and a cache
 * is never worth failing a run over. Root-only archives less than it might and
 * nothing it should not; `additional-cache-paths` is the escape hatch, and the
 * warning names the reason so a consumer can find it.
 */
const packageDirs = (): Effect.Effect<ReadonlyArray<string>, never, WorkspaceDiscovery> =>
	Effect.gen(function* () {
		const discovery = yield* WorkspaceDiscovery;
		const packages = yield* discovery.listPackages();
		// An empty answer is not a workspace with no members — every workspace has
		// at least its root package — so it is read the same way a failure is.
		return packages.length === 0 ? ["."] : packages.map((workspacePackage) => workspacePackage.relativePath);
	}).pipe(
		Effect.catch((cause) =>
			Effect.logWarning(
				`Workspace discovery failed (${cause._tag}): ${cause.message}. Caching the root node_modules only; ` +
					"name any others with additional-cache-paths.",
			).pipe(Effect.as<ReadonlyArray<string>>(["."])),
		),
	);

/**
 * The one-line verdict the run reports, in v1's words.
 *
 * @remarks
 * Three shapes — `exact hit (N lockfiles)`, `partial hit (…)`, `miss (…)` —
 * carried over verbatim from `legacy-v1/services/summary.ts:46`, singular
 * `1 lockfile` included. The count belongs on the line because a miss with no
 * lockfiles at all is a different problem from a miss with three: the first
 * says the patterns matched nothing, the second says the dependencies changed.
 *
 * The job-summary panel renders the same three (step 6), so the prose is
 * settled here rather than invented twice.
 */
const cacheLine = (restoredKey: Option.Option<string>, primaryKey: string, lockfileCount: number): string => {
	const lockfiles = `${lockfileCount} lockfile${lockfileCount === 1 ? "" : "s"}`;
	if (Option.isNone(restoredKey)) return `miss (${lockfiles})`;
	return restoredKey.value === primaryKey ? `exact hit (${lockfiles})` : `partial hit (${lockfiles})`;
};

/**
 * Computes a cache key from `args` and restores the dependency paths it names
 * from the runner's cache.
 *
 * @remarks
 * Runs *before* anything is installed, matching legacy
 * (`legacy-v1/program.ts:476`): a restore that lands is what makes the installs
 * that follow cheap, so it cannot depend on their results.
 *
 * `R` covers what `CacheKey` needs to hash and glob lockfiles (`FileSystem`,
 * `Path`) and what it needs to scope a key to the branch and runner OS
 * (`ActionEnvironment`), alongside the cache itself and the `ActionState` the
 * post phase reads back.
 *
 * Every restore is asked for by typed `CacheKey`, which carries its own ladder
 * policy — `ActionCache` reads the rungs off the key, so the primary and its
 * fallbacks cannot drift apart. A normal run carries `RESTORE_DEPTHS`; a busted
 * run carries an explicitly empty ladder, which is a policy rather than the
 * absence of one.
 *
 * Nothing here fails: the declared `CacheError` is what a failure is *shaped*
 * as before being logged, and the step answers with a miss-shaped
 * {@link CacheState} instead. The state is persisted even then, so the post
 * phase saves what this run installs rather than leaving the cache cold for the
 * next one too.
 */
export const restoreCache = (
	args: RestoreCacheArgs,
): Effect.Effect<
	RestoredCaches,
	CacheError,
	ActionCache | ActionState | FileSystem.FileSystem | Path.Path | ActionEnvironment | WorkspaceDiscovery
> =>
	Effect.gen(function* () {
		const cache = yield* ActionCache;
		const state = yield* ActionState;
		const env = yield* ActionEnvironment;

		// The workspace bounds lockfile discovery: nothing outside it is walked or
		// hashed, and the branch scopes the key to the ref that produced it.
		const { workspace, branch } = yield* context(env);
		const toolCacheBase = Option.getOrElse(yield* env.getOptional("RUNNER_TOOL_CACHE"), () =>
			defaultToolCacheBase(process.platform),
		);

		const packageManagers = activePackageManagers(args.config);
		// Biome rides along as a tool: it is versioned, tool-cached, and a version
		// change has to invalidate the archive that holds the old one (oracle 11).
		const tools: ReadonlyArray<ToolEntry> = [
			...args.config.runtimes.map((runtime) => ({ name: runtime.name, version: runtime.version })),
			...Option.match(args.biomeVersion, {
				onNone: (): ReadonlyArray<ToolEntry> => [],
				onSome: (version) => [{ name: "biome", version }],
			}),
		];

		const patterns = lockfilePatterns(packageManagers, args.inputs.additionalLockfiles);
		const lockfiles = yield* absorb(
			CacheKey.matchingFiles({ workspace, patterns }),
			"key",
			(cause) => `Lockfile discovery failed (${cause._tag}): ${cause.message}`,
			[] as ReadonlyArray<string>,
		);
		const lockfileHash = yield* absorb(
			CacheKey.hashFiles(lockfiles),
			"key",
			(cause) => `Lockfile hashing failed (${cause._tag}): ${cause.message}`,
			Option.none<string>(),
		);

		const dirs = yield* packageDirs();
		yield* Effect.logDebug(`Workspace packages (${dirs.length}): ${dirs.join(", ")}`);

		const paths = cachePaths({
			packageManagers,
			tools,
			toolCacheBase,
			additional: args.inputs.additionalCachePaths,
			turbo: args.turbo.enabled,
			packageDirs: dirs,
			platform: process.platform,
			home: homedir(),
		});
		const segments = CacheKey.of(
			...keySegments({
				platform: process.platform,
				arch: process.arch,
				tools,
				packageManager: args.config.packageManager,
				branch,
				lockfileHash,
				cacheBust: args.inputs.cacheBust,
				install: { deps: args.inputs.installDeps, ignoreScripts: args.inputs.ignoreScripts },
			}),
		);
		// A cache bust removes the ladder entirely (oracle 15): the fixtures pair a
		// create run with a restore run under one busted key to prove an **exact**
		// hit, and any fallback rung would satisfy the restore without proving
		// anything. `withoutRestoreKeys` is that third point in the policy space —
		// zero rungs, distinct from *absence*, which still selects the default
		// every-prefix ladder. Until the kit grew it, saying "this key or nothing"
		// forced the restore off the typed key and back onto a bare string.
		const busted = Option.isSome(args.inputs.cacheBust);
		const key = busted ? segments.withoutRestoreKeys() : segments.withRestoreDepths(RESTORE_DEPTHS);
		const ladder = key.restoreKeys;

		yield* Effect.logDebug(`Cache primary key: ${key.key}`);
		yield* Effect.logDebug(
			`Cache restore keys: ${ladder.length > 0 ? ladder.join(", ") : "(none — exact match only)"}`,
		);
		yield* Effect.logDebug(`Cache paths (${paths.length}): ${paths.join(", ")}`);
		yield* Effect.logDebug(`Lockfiles (${lockfiles.length}): ${lockfiles.join(", ") || "(none)"}`);
		// Logged whether or not one is set: a run that restored nothing is exactly
		// the run where "was a bust in play?" is the first question, and its absence
		// has to be an answer rather than a missing line (oracle 28).
		yield* Effect.logDebug(`Cache bust: ${Option.getOrElse(args.inputs.cacheBust, () => "(none)")}`);

		const restoredKey = yield* absorb(
			cache.restore(paths, key),
			"restore",
			(cause) => `Failed to restore cache with key ${key.key} (${cause.reason}): ${cause.message}`,
			Option.none<string>(),
		);

		yield* Effect.logInfo(cacheLine(restoredKey, key.key, lockfiles.length));
		yield* Effect.logDebug(`Cache matched key: ${Option.getOrElse(restoredKey, () => "(none)")}`);

		const restored = CacheState.make({ paths, primaryKey: key.key, restoredKey, lockfiles });
		yield* absorb(
			state.save(STATE_KEYS.cache, restored, CacheState),
			"state",
			(cause) => `Cache state could not be saved (${cause.reason}); the post phase will not save this run's cache`,
			undefined,
		);

		const store = yield* restoreStore({
			packageManagers,
			packageManagerVersion: args.config.packageManager,
			lockfileHash,
			cacheBust: args.inputs.cacheBust,
			busted,
		});

		return { workspace: restored, store };
	});

/** Everything {@link restoreStore} needs, already resolved by the caller. */
interface RestoreStoreArgs {
	readonly packageManagers: ReadonlyArray<PackageManagerName>;
	/** The `devEngines` manager, the only one carrying a version. */
	readonly packageManagerVersion: ToolEntry;
	readonly lockfileHash: Option.Option<string>;
	readonly cacheBust: Option.Option<string>;
	readonly busted: boolean;
}

/**
 * Restores the managers' global stores, as an entry of their own.
 *
 * @remarks
 * Second, and after the workspace archive, because a store restore can only
 * make the install that follows cheaper — never change what it resolves — so
 * nothing above it depends on the outcome.
 *
 * The version the key carries is the `devEngines` package manager's. bun and
 * deno are their own managers and reach {@link activePackageManagers} without
 * one, so they contribute their name at the version this run pinned when they
 * *are* the `devEngines` manager, and at `"runtime"` otherwise — a placeholder
 * rather than an empty segment, because what matters is only that two runs
 * pinning different managers do not share a store key.
 *
 * Degradation is the whole step's rule, applied again: a store that cannot be
 * restored costs a download, and the state is written either way so the post
 * phase archives what this run did fetch.
 */
const restoreStore = (args: RestoreStoreArgs): Effect.Effect<StoreCacheState, never, ActionCache | ActionState> =>
	Effect.gen(function* () {
		const cache = yield* ActionCache;
		const state = yield* ActionState;

		const paths = storeCachePaths(args.packageManagers, process.platform, homedir());
		const segments = CacheKey.of(
			...storeKeySegments({
				platform: process.platform,
				arch: process.arch,
				packageManagers: args.packageManagers.map((name) => ({
					name,
					version: name === args.packageManagerVersion.name ? args.packageManagerVersion.version : "runtime",
				})),
				lockfileHash: args.lockfileHash,
				cacheBust: args.cacheBust,
			}),
		);
		const key = args.busted ? segments.withoutRestoreKeys() : segments.withRestoreDepths(STORE_RESTORE_DEPTHS);

		yield* Effect.logDebug(`Store cache primary key: ${key.key}`);
		yield* Effect.logDebug(`Store cache paths (${paths.length}): ${paths.join(", ") || "(none)"}`);

		const restoredKey =
			paths.length === 0
				? Option.none<string>()
				: yield* absorb(
						cache.restore(paths, key),
						"restore",
						(cause) => `Failed to restore store cache with key ${key.key} (${cause.reason}): ${cause.message}`,
						Option.none<string>(),
					);

		yield* Effect.logInfo(
			Option.isNone(restoredKey)
				? "Store cache: miss"
				: restoredKey.value === key.key
					? "Store cache: exact hit"
					: "Store cache: partial hit",
		);

		const restored = StoreCacheState.make({ paths, primaryKey: key.key, restoredKey });
		yield* absorb(
			state.save(STATE_KEYS.storeCache, restored, StoreCacheState),
			"state",
			(cause) => `Store cache state could not be saved (${cause.reason}); the post phase will not save the store`,
			undefined,
		);
		return restored;
	});
