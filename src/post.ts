/**
 * Post-action entry point.
 *
 * Runs after main (even on failure). Saves the dependency cache if main did not
 * achieve an exact hit. Post-action failures never fail the workflow.
 *
 * @module post
 */

import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import { Action, ActionCacheLive, ActionState, ActionStateLive, Step } from "@savvy-web/github-action-effects";
import { Effect, Layer, Option } from "effect";
import { saveCache } from "./services/cache.js";
import { killProcess, serverLogPath } from "./services/turbo-cache/lifecycle.js";
import { CacheState, STATE_KEYS, TurboServerState } from "./state.js";

export const makePost = (kill: (pid: number) => void = killProcess) =>
	Effect.gen(function* () {
		yield* Effect.logDebug("Running post-action script");
		const state = yield* ActionState;

		// Turbo teardown runs unconditionally — before any cache early-returns.
		const turboStateOpt = yield* state.getOptional(STATE_KEYS.turboServerState, TurboServerState);
		if (Option.isSome(turboStateOpt)) {
			const { pid, port } = turboStateOpt.value;
			yield* Effect.logDebug(`Stopping turbo cache server pid=${pid} (log: ${serverLogPath(port)})`);
			yield* Effect.sync(() => kill(pid));
		}

		const cacheStateOpt = yield* state.getOptional(STATE_KEYS.cacheState, CacheState);
		if (Option.isNone(cacheStateOpt)) {
			yield* Effect.logDebug("No cache state from main; nothing to save");
			return;
		}
		if (cacheStateOpt.value.restored) {
			yield* Effect.logInfo("Cache was an exact hit — skipping save");
			return;
		}
		yield* Step.groupStep("Cache save", saveCache());
	}).pipe(
		// Post-action never fails the workflow — log typed errors as warnings.
		Effect.catch((error) =>
			Effect.logWarning(`Post-action error: ${error instanceof Error ? error.message : String(error)}`),
		),
		// Defense-in-depth: also swallow programming defects.
		Effect.catchDefect((defect) =>
			Effect.logWarning(`Post-action defect: ${defect instanceof Error ? defect.message : String(defect)}`),
		),
	);

export const post = makePost();

/**
 * Domain layers for post-action. ActionStateLive needs FileSystem.
 * ActionCacheLive needs NodeHttpClient for the V2 Twirp cache protocol.
 */
export const PostLive = Layer.mergeAll(
	ActionCacheLive.pipe(Layer.provide(NodeHttpClient.layerUndici)),
	ActionStateLive.pipe(Layer.provide(NodeFileSystem.layer)),
);

/* v8 ignore next 3 -- entry-point guard, only runs in GitHub Actions */
if (process.env.GITHUB_ACTIONS) {
	await Action.run(post, { layer: PostLive });
}
