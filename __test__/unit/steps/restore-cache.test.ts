import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { CacheKey } from "@effected/github-actions";
import {
	ActionCache,
	ActionCacheError,
	ActionEnvironment,
	ActionState,
	ActionStateError,
} from "@effected/github-actions";
import { Effect, FileSystem, Layer, Logger, Option, Path, References } from "effect";

import { RuntimeConfig } from "../../../src/schema/domain.js";
import type { Inputs } from "../../../src/schema/inputs.js";
import { CacheState, STATE_KEYS } from "../../../src/state.js";
import { restoreCache } from "../../../src/steps/restore-cache.js";

/** The checkout every case runs against, as `GITHUB_WORKSPACE` names it. */
const WORKSPACE = "/home/runner/work/repo/repo";

/** The tool cache every case runs against, as `RUNNER_TOOL_CACHE` names it. */
const TOOL_CACHE = "/opt/custom-toolcache";

/** A node + pnpm manifest, as `loadConfig` would return it. */
const nodeConfig = RuntimeConfig.make({
	packageManager: { name: "pnpm", version: "10.20.0" },
	runtimes: [{ name: "node", version: "24.11.0" }],
});

/** Every input absent, every default applied. */
const baseInputs: Inputs = {
	biomeVersion: Option.none(),
	turboCache: "auto",
	turboCachePrefix: "",
	turboToken: Option.none(),
	turboTeam: Option.none(),
	turboS3Bucket: Option.none(),
	turboS3Region: Option.none(),
	turboS3Endpoint: Option.none(),
	turboS3AccessKeyId: Option.none(),
	turboS3SecretAccessKey: Option.none(),
	turboS3SessionToken: Option.none(),
	turboS3Prefix: Option.none(),
	installDeps: true,
	bats: "auto",
	kcov: "auto",
	cacheBust: Option.none(),
	additionalLockfiles: [],
	additionalCachePaths: [],
};

/** One `ActionCache.restore` call, as this suite cares about it. */
interface Restore {
	readonly paths: ReadonlyArray<string>;
	readonly key: string | CacheKey;
	readonly restoreKeys: ReadonlyArray<string> | undefined;
}

/** One `ActionState.save` call, as this suite cares about it. */
interface Save {
	readonly key: string;
	readonly value: unknown;
}

/**
 * A `FileSystem` serving `files` — keyed by workspace-relative path — as the
 * only thing under the workspace.
 *
 * @remarks
 * Every member `CacheKey.matchingFiles` and `CacheKey.hashFiles` touch is
 * stubbed and nothing else is, so a step reading anything further dies rather
 * than quietly succeeding.
 */
const fileSystemTest = (files: Readonly<Record<string, string>> = {}): Layer.Layer<FileSystem.FileSystem> =>
	FileSystem.layerNoop({
		readDirectory: (path) =>
			path === WORKSPACE
				? Effect.succeed(Object.keys(files))
				: Effect.die(new Error(`unexpected FileSystem.readDirectory(${path})`)),
		stat: () => Effect.succeed({ type: "File" } as FileSystem.File.Info),
		readFile: (path) => {
			const contents = files[path.slice(WORKSPACE.length + 1)];
			return contents === undefined
				? Effect.die(new Error(`unexpected FileSystem.readFile(${path})`))
				: Effect.succeed(new TextEncoder().encode(contents));
		},
	});

/** An `ActionCache` double recording every restore, answering with `answer`. */
const cacheTest = (
	restores: Array<Restore>,
	answer: (key: string) => Effect.Effect<Option.Option<string>, ActionCacheError> = () => Effect.succeed(Option.none()),
): Layer.Layer<ActionCache> =>
	ActionCache.layerTest({
		restore: (paths, key, restoreKeys) => {
			restores.push({ paths, key, restoreKeys });
			return answer(typeof key === "string" ? key : key.key);
		},
	});

/** An `ActionState` double recording every save. */
const stateTest = (
	saves: Array<Save>,
	save: (key: string) => Effect.Effect<void, ActionStateError> = () => Effect.void,
): Layer.Layer<ActionState> =>
	ActionState.layerTest({
		save: ((key: string, value: unknown) => {
			saves.push({ key, value });
			return save(key);
		}) as ActionState["Service"]["save"],
	});

/** Everything the step needs, with the parts a case does not exercise pinned. */
const makeLayer = (options: {
	readonly restores?: Array<Restore>;
	readonly saves?: Array<Save>;
	readonly files?: Readonly<Record<string, string>>;
	readonly env?: Readonly<Record<string, string>>;
	readonly answer?: (key: string) => Effect.Effect<Option.Option<string>, ActionCacheError>;
	readonly save?: (key: string) => Effect.Effect<void, ActionStateError>;
	readonly logs?: Array<string>;
	/** A filesystem other than the one serving `files` — an unreadable one, say. */
	readonly fs?: Layer.Layer<FileSystem.FileSystem>;
}) =>
	Layer.mergeAll(
		cacheTest(options.restores ?? [], options.answer),
		stateTest(options.saves ?? [], options.save),
		options.fs ?? fileSystemTest(options.files),
		Path.layer,
		// `GITHUB_REF_NAME` is what the branch is read off now that `GitHubContext`
		// owns the fallback — the runner sets it on every event, and the raw
		// `GITHUB_REF` parse it replaces is the reason it was once absent here.
		// `GITHUB_HEAD_REF: ""` stays: the empty string is what the runner really
		// writes on a non-PR event, and decoding it as absent is the trap the kit
		// exists to encode.
		ActionEnvironment.layerTest({
			GITHUB_WORKSPACE: WORKSPACE,
			GITHUB_REF: "refs/heads/main",
			GITHUB_REF_NAME: "main",
			GITHUB_HEAD_REF: "",
			RUNNER_TOOL_CACHE: TOOL_CACHE,
			...options.env,
		}),
		// Captures the step's own log lines rather than letting them reach the
		// reporter, so a case can assert what a degraded run said. The debug
		// diagnostics are the point of half of it, so the floor comes down to
		// `Debug` — the runner does the same under `RUNNER_DEBUG=1`.
		Logger.layer([Logger.make(({ message }) => void (options.logs ?? []).push(String(message)))]),
		Layer.succeed(References.MinimumLogLevel)("Debug"),
	);

/** Runs the step with `overrides` folded into the default arguments. */
const run = (
	layer: Layer.Layer<ActionCache | ActionState | FileSystem.FileSystem | Path.Path | ActionEnvironment>,
	overrides: {
		readonly inputs?: Partial<Inputs>;
		readonly config?: RuntimeConfig;
		readonly biomeVersion?: Option.Option<string>;
		readonly turbo?: { readonly enabled: boolean };
	} = {},
) =>
	restoreCache({
		inputs: { ...baseInputs, ...overrides.inputs },
		config: overrides.config ?? nodeConfig,
		biomeVersion: overrides.biomeVersion ?? Option.none(),
		turbo: overrides.turbo ?? { enabled: false },
	}).pipe(Effect.provide(layer));

/** The key a recorded restore asked for, however it was passed. */
const askedFor = (restore: Restore | undefined): string =>
	restore === undefined ? "" : typeof restore.key === "string" ? restore.key : restore.key.key;

/**
 * The rungs a recorded restore would fall back to, however they were supplied.
 *
 * @remarks
 * A typed `CacheKey` carries its own ladder and the explicit `restoreKeys`
 * argument is absent; a bare string key carries none and the argument is what
 * would supply them. `ActionCache` reads whichever is present, so a test that
 * only looked at the argument would report an empty ladder for every
 * typed-key restore.
 */
const ladderOf = (restore: Restore | undefined): ReadonlyArray<string> => {
	if (restore === undefined) return [];
	return typeof restore.key === "string" ? (restore.restoreKeys ?? []) : restore.key.restoreKeys;
};

describe("restoreCache", () => {
	it.effect("asks for a key laid out platform-arch-versions-branch-lockfiles", () =>
		Effect.gen(function* () {
			const restores: Array<Restore> = [];
			const state = yield* run(makeLayer({ restores }));

			expect(restores).toHaveLength(1);
			expect(askedFor(restores[0])).toMatch(
				new RegExp(`^${process.platform}-${process.arch}-[0-9a-f]{8}-[0-9a-f]{8}-empty$`),
			);
			expect(state.primaryKey).toBe(askedFor(restores[0]));
		}),
	);

	it.effect("archives the active manager's store, its node_modules and the tool cache", () =>
		Effect.gen(function* () {
			const restores: Array<Restore> = [];
			yield* run(makeLayer({ restores }));

			const paths = restores[0]?.paths ?? [];
			expect(paths).toContain("**/node_modules");
			expect(paths).toContain(join(TOOL_CACHE, "node", "24.11.0"));
			// Nothing turbo-shaped: this workspace has no turbo.json.
			expect(paths).not.toContain("**/.turbo/cache");
		}),
	);

	it.effect("falls back to the branch, then across branches, and no further", () =>
		Effect.gen(function* () {
			const restores: Array<Restore> = [];
			yield* run(makeLayer({ restores }));

			// The ladder rides on the typed key rather than a hand-built list, so
			// this is what `ActionCache` reads the rungs off (upstream round 7,
			// item 2).
			expect(ladderOf(restores[0])).toHaveLength(2);
			for (const rung of ladderOf(restores[0])) expect(askedFor(restores[0]).startsWith(rung)).toBe(true);
		}),
	);

	it.effect("asks for exactly one key when a cache bust is in play", () =>
		Effect.gen(function* () {
			const restores: Array<Restore> = [];
			yield* run(makeLayer({ restores }), { inputs: { cacheBust: Option.some("npm-ubuntu-42") } });

			// By typed key carrying an explicitly empty ladder. Absence of a policy
			// would have `ActionCache` derive the default every-prefix one, which is
			// the opposite of what a busted run asks for — zero rungs is a policy,
			// not the lack of one, which is why this no longer needs a bare string.
			expect(typeof restores[0]?.key).toBe("object");
			expect(ladderOf(restores[0])).toEqual([]);
		}),
	);

	it.effect("reports an exact hit when the runner answers with the primary key", () =>
		Effect.gen(function* () {
			const restores: Array<Restore> = [];
			const state = yield* run(makeLayer({ restores, answer: (key) => Effect.succeed(Option.some(key)) }));

			expect(Option.getOrThrow(state.restoredKey)).toBe(state.primaryKey);
		}),
	);

	it.effect("reports a partial hit when the runner answers with a fallback key", () =>
		Effect.gen(function* () {
			const state = yield* run(
				makeLayer({ answer: (key) => Effect.succeed(Option.some(`${key.slice(0, 20)}-older`)) }),
			);

			expect(Option.isSome(state.restoredKey)).toBe(true);
			expect(Option.getOrThrow(state.restoredKey)).not.toBe(state.primaryKey);
		}),
	);

	it.effect("reports a miss when nothing matched", () =>
		Effect.gen(function* () {
			const state = yield* run(makeLayer({}));
			expect(Option.isNone(state.restoredKey)).toBe(true);
		}),
	);

	it.effect("persists what it restored for the post phase, and returns the same state", () =>
		Effect.gen(function* () {
			const saves: Array<Save> = [];
			const state = yield* run(makeLayer({ saves, answer: (key) => Effect.succeed(Option.some(key)) }));

			expect(saves).toHaveLength(1);
			expect(saves[0]?.key).toBe(STATE_KEYS.cache);
			expect(saves[0]?.value).toStrictEqual(state);
			expect(state).toBeInstanceOf(CacheState);
		}),
	);

	it.effect("folds the discovered lockfiles into the key and carries them in the state", () =>
		Effect.gen(function* () {
			const restores: Array<Restore> = [];
			const state = yield* run(
				makeLayer({ restores, files: { "pnpm-lock.yaml": "lockfileVersion: '9.0'", "README.md": "# repo" } }),
			);

			expect(state.lockfiles).toEqual([join(WORKSPACE, "pnpm-lock.yaml")]);
			expect(askedFor(restores[0])).toMatch(
				new RegExp(`^${process.platform}-${process.arch}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$`),
			);
		}),
	);

	it.effect("keys on the lockfile's contents, not merely its presence", () =>
		Effect.gen(function* () {
			const first: Array<Restore> = [];
			const second: Array<Restore> = [];
			yield* run(makeLayer({ restores: first, files: { "pnpm-lock.yaml": "one" } }));
			yield* run(makeLayer({ restores: second, files: { "pnpm-lock.yaml": "two" } }));

			expect(askedFor(first[0])).not.toBe(askedFor(second[0]));
		}),
	);

	it.effect("never counts a dependency's or a fixture's lockfile", () =>
		Effect.gen(function* () {
			const state = yield* run(
				makeLayer({
					files: {
						"node_modules/left-pad/package-lock.json": "{}",
						"__fixtures__/node-pnpm/pnpm-lock.yaml": "fixture",
						"__test__/unit/pnpm-lock.yaml": "fixture",
					},
				}),
			);

			expect(state.lockfiles).toEqual([]);
		}),
	);

	it.effect("discovers the caller's own lockfile patterns", () =>
		Effect.gen(function* () {
			const state = yield* run(makeLayer({ files: { "vendor.lock": "pinned" } }), {
				inputs: { additionalLockfiles: ["**/vendor.lock"] },
			});

			expect(state.lockfiles).toEqual([join(WORKSPACE, "vendor.lock")]);
		}),
	);

	it.effect("archives the caller's own paths, and turbo's when turbo was detected", () =>
		Effect.gen(function* () {
			const restores: Array<Restore> = [];
			const state = yield* run(makeLayer({ restores }), {
				inputs: { additionalCachePaths: ["**/build", "**/dist"] },
				turbo: { enabled: true },
			});

			expect(restores[0]?.paths).toEqual(state.paths);
			expect(state.paths).toContain("**/build");
			expect(state.paths).toContain("**/dist");
			expect(state.paths).toContain("**/.turbo/cache");
		}),
	);

	it.effect("keys on the resolved Biome version, and archives its tool-cache directory", () =>
		Effect.gen(function* () {
			const without: Array<Restore> = [];
			const with_: Array<Restore> = [];
			yield* run(makeLayer({ restores: without }));
			const state = yield* run(makeLayer({ restores: with_ }), { biomeVersion: Option.some("2.3.14") });

			expect(askedFor(with_[0])).not.toBe(askedFor(without[0]));
			expect(state.paths).toContain(join(TOOL_CACHE, "biome", "2.3.14"));
		}),
	);

	it.effect("keys on the pull request's head branch rather than the merge ref", () =>
		Effect.gen(function* () {
			const head: Array<Restore> = [];
			const push: Array<Restore> = [];
			// The pull request's own shape: `GITHUB_REF_NAME` is the useless
			// `12/merge`, and only `GITHUB_HEAD_REF` names the branch a human means.
			yield* run(
				makeLayer({
					restores: head,
					env: { GITHUB_HEAD_REF: "feature", GITHUB_REF: "refs/pull/12/merge", GITHUB_REF_NAME: "12/merge" },
				}),
			);
			yield* run(makeLayer({ restores: push, env: { GITHUB_REF: "refs/heads/feature", GITHUB_REF_NAME: "feature" } }));

			// Same branch by two routes, so the pull request restores what the branch
			// itself saved.
			expect(askedFor(head[0])).toBe(askedFor(push[0]));
		}),
	);

	it.effect("separates branches", () =>
		Effect.gen(function* () {
			const main: Array<Restore> = [];
			const dev: Array<Restore> = [];
			yield* run(makeLayer({ restores: main, env: { GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" } }));
			yield* run(makeLayer({ restores: dev, env: { GITHUB_REF: "refs/heads/dev", GITHUB_REF_NAME: "dev" } }));

			expect(askedFor(main[0])).not.toBe(askedFor(dev[0]));
		}),
	);

	it.effect("keys a tag push under the tag, and still falls back across to a branch", () =>
		Effect.gen(function* () {
			const tag: Array<Restore> = [];
			const branch: Array<Restore> = [];
			yield* run(makeLayer({ restores: tag, env: { GITHUB_REF: "refs/tags/v1.3.0", GITHUB_REF_NAME: "v1.3.0" } }));
			yield* run(makeLayer({ restores: branch, env: { GITHUB_REF: "refs/heads/main", GITHUB_REF_NAME: "main" } }));

			// The one divergence from the raw-`GITHUB_REF` chain `GitHubContext.branch`
			// replaced: that chain saw a ref which was not `refs/heads/*` and answered
			// `""`, so every tag in the repository shared the one contextless bucket.
			// A tag now gets a segment of its own.
			expect(askedFor(tag[0])).not.toBe(askedFor(branch[0]));
			// Which costs nothing on a cold tag, because depth 3 of RESTORE_DEPTHS
			// drops the branch segment: the first run on a new tag still restores
			// what the branch it was cut from saved.
			const [, crossBranch] = ladderOf(tag[0]);
			expect(crossBranch).toBeDefined();
			expect(ladderOf(branch[0])).toContain(crossBranch);
		}),
	);

	it.effect("reports a miss and keeps going when the runner's cache is unreachable", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			const saves: Array<Save> = [];
			const state = yield* run(
				makeLayer({
					logs,
					saves,
					answer: (key) => Effect.fail(new ActionCacheError({ reason: "unreachable", key })),
				}),
			);

			// A cache is an optimization: the run continues, and the installs that
			// follow simply do the work the cache would have saved.
			expect(Option.isNone(state.restoredKey)).toBe(true);
			expect(state.primaryKey).not.toBe("");
			expect(state.paths.length).toBeGreaterThan(0);
			// The reason literal is what a workflow log needs to tell a missing
			// token apart from a broken archive.
			expect(logs.join("\n")).toContain("unreachable");
			// The state is still persisted, so post saves what this run installs.
			expect(saves).toHaveLength(1);
		}),
	);

	it.effect("keys on no lockfiles at all when the workspace cannot be walked", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			const restores: Array<Restore> = [];
			// A filesystem whose `readDirectory` is unstubbed, so the walk fails the
			// way an absent or unreadable workspace fails.
			const state = yield* run(makeLayer({ logs, restores, fs: FileSystem.layerNoop({}) }));

			expect(askedFor(restores[0]).endsWith("-empty")).toBe(true);
			expect(state.lockfiles).toEqual([]);
			expect(logs.join("\n")).toContain("CacheKeyReadError");
		}),
	);

	it.effect("reports the outcome in v1's words, with the lockfile count", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			yield* run(
				makeLayer({
					logs,
					files: { "pnpm-lock.yaml": "lockfileVersion: '9.0'" },
					answer: (key) => Effect.succeed(Option.some(key)),
				}),
			);
			// Singular, because one lockfile matched.
			expect(logs).toContain("exact hit (1 lockfile)");

			const partial: Array<string> = [];
			yield* run(makeLayer({ logs: partial, answer: (key) => Effect.succeed(Option.some(`${key}-older`)) }));
			expect(partial).toContain("partial hit (0 lockfiles)");

			const miss: Array<string> = [];
			yield* run(makeLayer({ logs: miss }));
			expect(miss).toContain("miss (0 lockfiles)");
		}),
	);

	it.effect("says whether a cache bust was in play, either way", () =>
		Effect.gen(function* () {
			const busted: Array<string> = [];
			yield* run(makeLayer({ logs: busted }), { inputs: { cacheBust: Option.some("npm-ubuntu-42") } });
			expect(busted.join("\n")).toContain("Cache bust: npm-ubuntu-42");

			// A run that restored nothing is where the question gets asked, so the
			// absence has to be an answer rather than a missing line.
			const plain: Array<string> = [];
			yield* run(makeLayer({ logs: plain }));
			expect(plain.join("\n")).toContain("Cache bust: (none)");
		}),
	);

	it.effect("keeps its result when the state cannot be written", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			const state = yield* run(
				makeLayer({
					logs,
					save: (key) => Effect.fail(new ActionStateError({ reason: "writeFailed", key })),
					answer: (key) => Effect.succeed(Option.some(key)),
				}),
			);

			// Post will do nothing without the state, which is the cost. Failing the
			// action over it would throw away a restore that already landed.
			expect(Option.isSome(state.restoredKey)).toBe(true);
			expect(logs.join("\n")).toContain("writeFailed");
		}),
	);
});
