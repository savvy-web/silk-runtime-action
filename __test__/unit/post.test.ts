import { describe, expect, it } from "@effect/vitest";
import type { DetachedProcessOps } from "@effected/github-actions";
import {
	ActionCache,
	ActionCacheError,
	ActionLogger,
	ActionState,
	ActionStateError,
	DetachedProcess,
	DetachedProcessError,
	ProcessId,
} from "@effected/github-actions";
import { Effect, Layer, Logger, Option, References } from "effect";

import { makePost, post } from "../../src/post.js";
import { CacheState, STATE_KEYS, TurboServerState } from "../../src/state.js";

/**
 * `makePost` over a seam that stubs `reap` and nothing else.
 *
 * @remarks
 * The post phase calls exactly one detached operation, so the other two are left
 * unstubbed deliberately: `DetachedProcess.makeTestOps` makes them die naming
 * themselves (effected#240), which turns "this phase does not spawn" from an
 * untested assumption into a failing test if it ever stops being true.
 *
 * That guarantee is worth more here than anywhere else in the suite. The member
 * being replaced signals a pid read back out of `GITHUB_STATE` — so a seam that
 * silently fell through to the real static would send `SIGTERM` to whatever
 * process happens to own the number a fixture made up.
 */
const postReaping = (reap: DetachedProcessOps["reap"]) => makePost(DetachedProcess.makeTestOps({ reap }));

/**
 * The keys `post` reads, in the order it reads them.
 *
 * @remarks
 * Recording them is what makes "post reads exactly the two `STATE_KEYS`" an
 * assertion rather than a comment — a third read added later shows up here.
 */
const makeLayer = (
	read: Array<string>,
	cache: Layer.Layer<ActionCache> = ActionCache.layerTest({}),
): Layer.Layer<ActionCache | ActionState> =>
	Layer.mergeAll(
		ActionState.layerTest({
			getOptional: ((key: string) =>
				Effect.sync(() => {
					read.push(key);
					return Option.none();
				})) as ActionState["Service"]["getOptional"],
		}),
		cache,
		// `ActionLogger.layerSilent` is both the service double and a silent
		// `Effect.log*`, so `post`'s debug lines do not leak into the reporter.
		ActionLogger.layerSilent,
	);

/** One `ActionCache.save` call, as this suite cares about it. */
interface Saved {
	readonly paths: ReadonlyArray<string>;
	readonly key: string;
}

/** An `ActionCache` double recording every save, answering with `answer`. */
const cacheTest = (
	saves: Array<Saved>,
	answer: Effect.Effect<void, ActionCacheError> = Effect.void,
): Layer.Layer<ActionCache> =>
	ActionCache.layerTest({
		save: (paths, key) => {
			saves.push({ paths, key: typeof key === "string" ? key : key.key });
			return answer;
		},
	});

/** An `ActionState` serving `cache` under the cache key, and nothing else. */
const stateWith = (cache: Option.Option<CacheState>): Layer.Layer<ActionState> =>
	ActionState.layerTest({
		getOptional: ((key: string) =>
			Effect.succeed(key === STATE_KEYS.cache ? cache : Option.none())) as ActionState["Service"]["getOptional"],
	});

/** Runs `post` over `state` and `cache`, capturing every log line it emits. */
const runPost = (options: {
	readonly state: Layer.Layer<ActionState>;
	readonly cache: Layer.Layer<ActionCache>;
	readonly logs?: Array<string>;
}) =>
	post.pipe(
		Effect.provide(
			Layer.mergeAll(
				options.state,
				options.cache,
				Logger.layer([Logger.make(({ message }) => void (options.logs ?? []).push(String(message)))]),
			),
		),
		Effect.exit,
	);

/** What `main` saves after starting an embedded cache server. */
const server = TurboServerState.make({
	pid: ProcessId.make(4242),
	port: 41230,
	backend: "github",
	logFile: "/tmp/turbo-server.log",
});

/** An `ActionState` serving the server state, and no cache state. */
const serverOnly: Layer.Layer<ActionState> = ActionState.layerTest({
	getOptional: ((key: string) =>
		Effect.succeed(
			key === STATE_KEYS.turboServer ? Option.some(server) : Option.none(),
		)) as ActionState["Service"]["getOptional"],
});

/** What `main` saves after a miss. */
const missed = CacheState.make({
	paths: ["/home/runner/.local/share/pnpm/store", "**/node_modules"],
	primaryKey: "linux-x64-aaaaaaaa-bbbbbbbb-cccccccc",
	restoredKey: Option.none(),
	lockfiles: ["/home/runner/work/repo/repo/pnpm-lock.yaml"],
});

describe("post", () => {
	it.effect("reads both cross-phase state keys, the server first", () =>
		Effect.gen(function* () {
			const read: Array<string> = [];
			yield* post.pipe(Effect.provide(makeLayer(read)));
			// Teardown precedes every branch that can return early (oracle 35): a
			// detached child outliving the job is worse than an unsaved cache.
			expect(read).toEqual([STATE_KEYS.turboServer, STATE_KEYS.cache]);
		}),
	);

	it.effect("succeeds without saving a cache or reaping a server when neither key is present", () =>
		Effect.gen(function* () {
			const read: Array<string> = [];
			// Every `ActionCache` member is unstubbed, so a save attempt dies —
			// which is precisely the "no save on `Option.none()`" assertion.
			const exit = yield* post.pipe(Effect.provide(makeLayer(read)), Effect.exit);
			expect(exit._tag).toBe("Success");
		}),
	);

	it.effect("saves what main restored nothing for, under the key it asked for", () =>
		Effect.gen(function* () {
			const saves: Array<Saved> = [];
			const exit = yield* runPost({ state: stateWith(Option.some(missed)), cache: cacheTest(saves) });

			expect(exit._tag).toBe("Success");
			expect(saves).toEqual([{ paths: missed.paths, key: missed.primaryKey }]);
		}),
	);

	it.effect("saves under the primary key after a partial restore, not the key that matched", () =>
		Effect.gen(function* () {
			const saves: Array<Saved> = [];
			const partial = CacheState.make({ ...missed, restoredKey: Option.some("linux-x64-aaaaaaaa-bbbbbbbb-older") });
			yield* runPost({ state: stateWith(Option.some(partial)), cache: cacheTest(saves) });

			// A partial restore left the archive short of what this run installed, so
			// the primary key is the one that has to end up populated.
			expect(saves).toEqual([{ paths: partial.paths, key: partial.primaryKey }]);
		}),
	);

	it.effect("skips the save after an exact hit", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			const exact = CacheState.make({ ...missed, restoredKey: Option.some(missed.primaryKey) });
			// Every `ActionCache` member is unstubbed, so a save would die.
			const exit = yield* runPost({ state: stateWith(Option.some(exact)), cache: ActionCache.layerTest({}), logs });

			expect(exit._tag).toBe("Success");
			// Verbatim v1, because it is what a workflow log has always said.
			expect(logs).toContain("Cache was an exact hit — skipping save");
		}),
	);

	it.effect("skips the save when there is nothing to archive", () =>
		Effect.gen(function* () {
			const empty = CacheState.make({ ...missed, paths: [] });
			const exit = yield* runPost({ state: stateWith(Option.some(empty)), cache: ActionCache.layerTest({}) });

			expect(exit._tag).toBe("Success");
		}),
	);

	it.effect("warns rather than failing the workflow when the save fails", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			const saves: Array<Saved> = [];
			const exit = yield* runPost({
				state: stateWith(Option.some(missed)),
				cache: cacheTest(saves, Effect.fail(new ActionCacheError({ reason: "refused", key: missed.primaryKey }))),
				logs,
			});

			// The job has already done its work; a cache that would not take it is
			// not a reason to fail the run.
			expect(exit._tag).toBe("Success");
			expect(saves).toHaveLength(1);
			expect(logs.join("\n")).toContain("refused");
		}),
	);

	it.effect("keeps saving the cache after reading the turbo server state", () =>
		Effect.gen(function* () {
			const read: Array<string> = [];
			const exit = yield* post.pipe(
				Effect.provide(
					Layer.mergeAll(
						ActionState.layerTest({
							getOptional: ((key: string) =>
								Effect.sync(() => {
									read.push(key);
									return key === STATE_KEYS.cache ? Option.some(missed) : Option.none();
								})) as ActionState["Service"]["getOptional"],
						}),
						cacheTest([], Effect.fail(new ActionCacheError({ reason: "unreachable" }))),
						ActionLogger.layerSilent,
					),
				),
				Effect.exit,
			);

			expect(exit._tag).toBe("Success");
			expect(read).toEqual([STATE_KEYS.turboServer, STATE_KEYS.cache]);
		}),
	);

	it.effect("reaps the server and saves the cache when both keys are present", () =>
		Effect.gen(function* () {
			const saves: Array<Saved> = [];
			const reaped: Array<number> = [];
			const exit = yield* postReaping((pid) =>
				Effect.sync(() => {
					reaped.push(pid);
					return true;
				}),
			).pipe(
				Effect.provide(
					Layer.mergeAll(
						ActionState.layerTest({
							getOptional: ((key: string) =>
								Effect.succeed(
									key === STATE_KEYS.cache ? Option.some(missed) : Option.some(server),
								)) as ActionState["Service"]["getOptional"],
						}),
						cacheTest(saves),
						ActionLogger.layerSilent,
					),
				),
				Effect.exit,
			);
			expect(exit._tag).toBe("Success");
			expect(saves).toHaveLength(1);
			expect(reaped).toEqual([4242]);
		}),
	);

	it.effect("names the pid and the log file it is reaping", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			yield* postReaping(() => Effect.succeed(true)).pipe(
				Effect.provide(
					Layer.mergeAll(
						serverOnly,
						ActionCache.layerTest({}),
						Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
					),
				),
				// The teardown lines are debug: routine on a healthy run, and the
				// thing an operator turns `ACTIONS_STEP_DEBUG` on to read.
				Effect.provideService(References.MinimumLogLevel, "Debug"),
			);
			// The log file is the only record a detached child leaves, and post is
			// the last place that can point at it.
			expect(logs.join("\n")).toContain("pid=4242");
			expect(logs.join("\n")).toContain("/tmp/turbo-server.log");
		}),
	);

	it.effect("treats a child that already exited as the normal ending", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			const exit = yield* postReaping(() => Effect.succeed(false)).pipe(
				Effect.provide(
					Layer.mergeAll(
						serverOnly,
						ActionCache.layerTest({}),
						Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
					),
				),
				Effect.provideService(References.MinimumLogLevel, "Debug"),
				Effect.exit,
			);
			// The server exits on its own SIGTERM handler, and a runner may have
			// torn the process group down before post ran.
			expect(exit._tag).toBe("Success");
			expect(logs.join("\n")).toContain("had already exited");
		}),
	);

	it.effect("never fails the workflow when the reap itself fails", () =>
		Effect.gen(function* () {
			const exit = yield* postReaping(() =>
				Effect.fail(new DetachedProcessError({ reason: "signalFailed", pid: 4242 })),
			).pipe(
				Effect.provide(Layer.mergeAll(serverOnly, ActionCache.layerTest({}), ActionLogger.layerSilent)),
				Effect.exit,
			);
			expect(exit._tag).toBe("Success");
		}),
	);

	it.effect("saves the cache even when the reap defected", () =>
		Effect.gen(function* () {
			const saves: Array<Saved> = [];
			const logs: Array<string> = [];
			const exit = yield* postReaping(() => Effect.die(new Error("kill exploded"))).pipe(
				Effect.provide(
					Layer.mergeAll(
						ActionState.layerTest({
							getOptional: ((key: string) =>
								Effect.succeed(
									key === STATE_KEYS.cache ? Option.some(missed) : Option.some(server),
								)) as ActionState["Service"]["getOptional"],
						}),
						cacheTest(saves),
						Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
					),
				),
				Effect.exit,
			);
			// Teardown and the archive are two independent jobs. Running teardown
			// first buys the guarantee that a child is always signalled; containing
			// its failures is what stops that ordering from costing the run its
			// cache when the signal is the thing that broke.
			expect(exit._tag).toBe("Success");
			expect(saves).toEqual([{ paths: missed.paths, key: missed.primaryKey }]);
			expect(logs.join("\n")).toContain("Turbo cache server teardown failed for pid 4242");
			expect(logs.join("\n")).toContain("kill exploded");
		}),
	);

	it.effect("saves the cache even when the reap fails typed", () =>
		Effect.gen(function* () {
			const saves: Array<Saved> = [];
			const exit = yield* postReaping(() =>
				Effect.fail(new DetachedProcessError({ reason: "signalFailed", pid: 4242 })),
			).pipe(
				Effect.provide(
					Layer.mergeAll(
						ActionState.layerTest({
							getOptional: ((key: string) =>
								Effect.succeed(
									key === STATE_KEYS.cache ? Option.some(missed) : Option.some(server),
								)) as ActionState["Service"]["getOptional"],
						}),
						cacheTest(saves),
						ActionLogger.layerSilent,
					),
				),
				Effect.exit,
			);
			expect(exit._tag).toBe("Success");
			expect(saves).toEqual([{ paths: missed.paths, key: missed.primaryKey }]);
		}),
	);

	it.effect("saves the cache even when the server state is unreadable", () =>
		Effect.gen(function* () {
			const saves: Array<Saved> = [];
			const logs: Array<string> = [];
			const exit = yield* postReaping(() => Effect.succeed(true)).pipe(
				Effect.provide(
					Layer.mergeAll(
						ActionState.layerTest({
							getOptional: ((key: string) =>
								key === STATE_KEYS.cache
									? Effect.succeed(Option.some(missed))
									: Effect.fail(
											new ActionStateError({ reason: "malformed", key }),
										)) as ActionState["Service"]["getOptional"],
						}),
						cacheTest(saves),
						Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
					),
				),
				Effect.exit,
			);
			// A `main` that died mid-write leaves state that decodes as malformed.
			// That says nothing about whether this run's dependencies are worth
			// archiving, and there is no pid to signal either way.
			expect(exit._tag).toBe("Success");
			expect(saves).toEqual([{ paths: missed.paths, key: missed.primaryKey }]);
			expect(logs.join("\n")).toContain("Turbo cache server state could not be read (malformed)");
		}),
	);

	it.effect("never fails the workflow when state is malformed", () =>
		Effect.gen(function* () {
			const exit = yield* post.pipe(
				Effect.provide(
					Layer.mergeAll(
						ActionState.layerTest({
							getOptional: ((key: string) =>
								Effect.fail(
									new ActionStateError({ reason: "malformed", key }),
								)) as ActionState["Service"]["getOptional"],
						}),
						ActionCache.layerTest({}),
						ActionLogger.layerSilent,
					),
				),
				Effect.exit,
			);
			expect(exit._tag).toBe("Success");
		}),
	);

	it.effect("never fails the workflow when reading state defects", () =>
		Effect.gen(function* () {
			const exit = yield* post.pipe(
				Effect.provide(
					Layer.mergeAll(
						ActionState.layerTest({
							getOptional: (() =>
								Effect.die(new Error("GITHUB_STATE unreadable"))) as ActionState["Service"]["getOptional"],
						}),
						ActionCache.layerTest({}),
						ActionLogger.layerSilent,
					),
				),
				Effect.exit,
			);
			expect(exit._tag).toBe("Success");
		}),
	);

	it.effect("never fails the workflow when the defect is not an Error", () =>
		Effect.gen(function* () {
			// The `String(defect)` half of the defect renderer: a thrown
			// non-`Error` is exactly what a bundled dependency tends to produce.
			const exit = yield* post.pipe(
				Effect.provide(
					Layer.mergeAll(
						ActionState.layerTest({
							getOptional: (() => Effect.die("GITHUB_STATE unreadable")) as ActionState["Service"]["getOptional"],
						}),
						ActionCache.layerTest({}),
						ActionLogger.layerSilent,
					),
				),
				Effect.exit,
			);
			expect(exit._tag).toBe("Success");
		}),
	);
});
