/**
 * Post-action entry point.
 *
 * Runs after `main`, even when `main` failed. It reads the three pieces of
 * cross-phase state `main` may have saved — the dependency cache state, the
 * kcov cache state, and the embedded turbo cache server state — and acts on
 * each only when present.
 *
 * The detached-server reap runs **first and unconditionally**, ahead of every
 * cache branch that can return early (oracle 35): a leaked cache server outlives
 * the job, and whether this run's dependencies are worth archiving has nothing
 * to do with it. What is load-bearing throughout is the failure posture — a
 * post-action failure must never fail the workflow, so both the typed channel
 * and defects are caught and logged.
 *
 * @module post
 */

import type { DetachedProcessOps } from "@effected/github-actions";
import { Action, ActionCache, ActionState, DetachedProcess } from "@effected/github-actions";
import { Effect, Option } from "effect";

import { PostLive } from "./layers/app.js";
import { CacheState, KcovCacheState, STATE_KEYS, TurboServerState, isExactHit } from "./state.js";
import { CacheError } from "./steps/restore-cache.js";

/**
 * Archives what `main` restored, when a save is still needed.
 *
 * @remarks
 * Saved on a partial restore as well as a miss, and always under the *primary*
 * key rather than whichever key matched: a partial restore left the archive
 * short of what this run installed, so the key this run asked for is the one
 * that has to end up populated. Only an exact hit skips — that archive is
 * already what this run would write, and cache entries are immutable anyway.
 *
 * Legacy read the state back and re-checked the same flag inside its save
 * (oracle 35); one guard, here, is the whole of it.
 *
 * A failure is warned about rather than raised — the job has already done its
 * work, and a cache that would not take it is not a reason to fail the run — and
 * it is caught *here* rather than left to the module's outer net so the branches
 * after this one still run.
 *
 * The known cost, carried over deliberately: `post` runs even when `main`
 * failed, so an install that died halfway can seal a half-populated
 * `node_modules` under the primary key. Fixing it needs `main` to leave a
 * completed marker behind, which is a hardening pass of its own.
 */
const saveDependencyCache = (saved: CacheState) =>
	Effect.gen(function* () {
		if (isExactHit(saved)) {
			yield* Effect.logInfo("Cache was an exact hit — skipping save");
			return;
		}
		if (saved.paths.length === 0) {
			yield* Effect.logInfo("No cache paths — skipping save");
			return;
		}

		const cache = yield* ActionCache;
		yield* Effect.logInfo(`Saving cache: key=${saved.primaryKey}, paths (${saved.paths.length})`);
		yield* cache.save(saved.paths, saved.primaryKey).pipe(
			Effect.tap(() => Effect.logInfo(`Cache saved: ${saved.primaryKey}`)),
			Effect.catch((cause) =>
				Effect.logWarning(
					new CacheError({
						reason: "save",
						message: `Failed to save cache with key ${saved.primaryKey} (${cause.reason}): ${cause.message}`,
						cause,
					}).message,
				),
			),
		);
	});

/**
 * Archives the kcov tree this run built.
 *
 * @remarks
 * A separate branch from {@link saveDependencyCache} rather than a generalized
 * one: the two entries are keyed on entirely different things, and only the
 * dependency cache has a partial-restore concept worth generalizing over. The
 * comparison here is a plain `===` rather than a shared `isExactHit` — that
 * helper is typed on `CacheState` and encodes its three-way exact/partial/miss
 * distinction on purpose; kcov's cache has only two outcomes, "some restored
 * key equals the primary" or not, so reusing it would mean contorting a
 * two-way decision through a three-way shape instead of writing the two-way
 * comparison directly.
 *
 * That comparison is **not** `Option.isNone` — the restore-key ladder Task 6
 * added means `restoredKey` is `some` on two different outcomes: an exact hit
 * on the primary (skip), and a prefix-rung hit that matched an *older* key
 * (still save, under the new primary). Only `some(primaryKey)` skips. Treating
 * every `some` as "skip" would silently disable the ladder's self-healing —
 * the whole reason a prefix-rung hit exists is so a rebuild after an image
 * bump lands under a fresh key instead of leaving one abandoned.
 *
 * Contained in its own `catch` for the same reason `reapCacheServer` is: three
 * independent jobs, three independent failures, and none of them may be the
 * thing that costs another its work.
 */
const saveKcovCache = (saved: KcovCacheState) =>
	Effect.gen(function* () {
		if (Option.isSome(saved.restoredKey) && saved.restoredKey.value === saved.primaryKey) {
			yield* Effect.logInfo("kcov was an exact hit — skipping save");
			return;
		}
		if (saved.paths.length === 0) {
			yield* Effect.logInfo("No kcov cache paths — skipping save");
			return;
		}

		const cache = yield* ActionCache;
		yield* Effect.logInfo(`Saving kcov cache: key=${saved.primaryKey}, paths (${saved.paths.length})`);
		yield* cache.save(saved.paths, saved.primaryKey).pipe(
			Effect.tap(() => Effect.logInfo(`kcov cache saved: ${saved.primaryKey}`)),
			Effect.catch((cause) =>
				Effect.logWarning(`Failed to save kcov cache with key ${saved.primaryKey}: ${cause.message}`),
			),
		);
	}).pipe(
		// The typed `ActionCacheError` channel is already closed by the inner
		// `Effect.catch` above, so only a defect remains to guard against here —
		// unlike `saveDependencyCache`, which lets its typed failure escape to
		// this level.
		Effect.catchDefect((defect) =>
			Effect.logWarning(`kcov cache save failed: ${defect instanceof Error ? defect.message : String(defect)}`),
		),
	);

/**
 * Stops the detached cache server `main` started.
 *
 * @remarks
 * `false` — the child is already gone — is the *normal* ending rather than a
 * failure: the server exits on its own SIGTERM handler, and a runner that tore
 * the process group down before `post` ran has done this job already. Either
 * way the log path is named, because that file is where a server that
 * misbehaved says why and nothing else points at it.
 *
 * There is no wait and no `SIGKILL` escalation. The signal is the whole of it:
 * the runner reclaims the machine moments later, and a post phase that blocked
 * on a child's exit would trade a bounded leak for an unbounded hang.
 *
 * **Failures are contained here rather than left to the module's outer net.**
 * Running teardown first buys a guarantee — the child is signalled before any
 * branch that can return early — and that guarantee inverts if a failed reap
 * ends the phase: the cache save is downstream of it, so a refused signal or a
 * defect in the injected reap would cost the run its archive as well as its
 * teardown. Two independent jobs, two independent failures. The outer net still
 * exists, and this is the layer that keeps it from ever being the thing that
 * skips the save.
 */
const reapCacheServer = (saved: TurboServerState, reap: DetachedProcessOps["reap"]) =>
	Effect.gen(function* () {
		yield* Effect.logDebug(`Stopping turbo cache server pid=${saved.pid} (log: ${saved.logFile})`);
		const signalled = yield* reap(saved.pid);
		yield* Effect.logDebug(
			signalled
				? `Turbo cache server pid=${saved.pid} signalled`
				: `Turbo cache server pid=${saved.pid} had already exited`,
		);
	}).pipe(
		Effect.catch((error) =>
			Effect.logWarning(
				`Turbo cache server teardown failed for pid ${saved.pid}: ${error instanceof Error ? error.message : String(error)}`,
			),
		),
		Effect.catchDefect((defect) =>
			Effect.logWarning(
				`Turbo cache server teardown failed for pid ${saved.pid}: ${defect instanceof Error ? defect.message : String(defect)}`,
			),
		),
	);

/**
 * The post phase, over the kit's injectable detached-process seam.
 *
 * @remarks
 * `makePost` exists only for that seam; {@link post} is the value the entry
 * point and every other caller use.
 *
 * The seam is `DetachedProcessOps` (effected#240), replacing a local `Reap`
 * function type. `DetachedProcess.reap` is a static rather than a service, so
 * injection has to be by parameter — and the edge here is sharper than
 * `startTurboCache`'s: a test that let the default through would send a real
 * `SIGTERM` to whatever process happens to own the pid its fixture made up.
 *
 * That is exactly why the kit's seam is the better one. A test supplies
 * `DetachedProcess.makeTestOps({ reap })` and the two members it did not stub
 * die naming themselves, where the old hand-rolled type could only be satisfied
 * in full — so an unstubbed operation fell through to the real static silently.
 * This phase only ever calls `reap`, but the guarantee now covers the other two
 * for free.
 */
export const makePost = (ops: DetachedProcessOps = DetachedProcess.ops) =>
	Effect.gen(function* () {
		const state = yield* ActionState;
		yield* Effect.logDebug("Running post-action script");

		// First, and before any branch that can return early: a detached child that
		// outlives the job is a worse outcome than an unsaved cache.
		//
		// The read is absorbed for the same reason the reap is: state written by a
		// `main` that died mid-write decodes as `malformed`, and neither that nor a
		// missing key says anything about whether this run's dependencies are worth
		// archiving. Unreadable server state means there is no pid to signal, which
		// is what `Option.none()` already means.
		const server = yield* state
			.getOptional(STATE_KEYS.turboServer, TurboServerState)
			.pipe(
				Effect.catch((error) =>
					Effect.logWarning(`Turbo cache server state could not be read (${error.reason}); nothing to reap`).pipe(
						Effect.as(Option.none<TurboServerState>()),
					),
				),
			);
		yield* Option.match(server, {
			onNone: () => Effect.logDebug("No embedded turbo cache server was started; nothing to reap"),
			onSome: (saved) => reapCacheServer(saved, ops.reap),
		});

		// Absorbed the same way the turbo-server read above is: state written by a
		// `main` that died mid-write decodes as `malformed`, and that says nothing
		// about whether *this* branch's cache is worth saving — an unreadable
		// dependency-cache state must not cost the kcov save its turn, and vice versa.
		const cache = yield* state
			.getOptional(STATE_KEYS.cache, CacheState)
			.pipe(
				Effect.catch((error) =>
					Effect.logWarning(`Dependency cache state could not be read (${error.reason}); nothing to save`).pipe(
						Effect.as(Option.none<CacheState>()),
					),
				),
			);
		yield* Option.match(cache, {
			onNone: () => Effect.logDebug("No dependency cache state was saved by main; nothing to save"),
			onSome: saveDependencyCache,
		});

		const kcovCache = yield* state
			.getOptional(STATE_KEYS.kcovCache, KcovCacheState)
			.pipe(
				Effect.catch((error) =>
					Effect.logWarning(`kcov cache state could not be read (${error.reason}); nothing to save`).pipe(
						Effect.as(Option.none<KcovCacheState>()),
					),
				),
			);
		yield* Option.match(kcovCache, {
			onNone: () => Effect.logDebug("No kcov cache state was saved by main; nothing to save"),
			onSome: saveKcovCache,
		});
	}).pipe(
		// The typed channel is fully absorbed above — every read and every save
		// branch catches its own — so only a defect can still reach here. Kept as
		// defense-in-depth: post-action failures must never fail the workflow.
		Effect.catchDefect((defect) =>
			Effect.logWarning(`Post-action warning: ${defect instanceof Error ? defect.message : String(defect)}`),
		),
	);

/** The post phase as the entry point runs it, reaping through the kit. */
export const post = makePost();

export { PostLive };

/* v8 ignore next 3 -- entry-point guard, only runs in GitHub Actions */
if (process.env.GITHUB_ACTIONS) {
	await Action.run(post, { layer: PostLive });
}
