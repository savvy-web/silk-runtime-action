import { ActionOutputs, ActionState } from "@savvy-web/github-action-effects";
import { Effect } from "effect";
import { STATE_KEYS, TurboServerState } from "../../state.js";
import type { TurboCacheResolution } from "./activation.js";
import type { SpawnSpec } from "./lifecycle.js";
import { DEFAULT_TURBO_PORT, buildSpawnSpec, serverLogPath } from "./lifecycle.js";

/** Dummy Turbo credential used for the local embedded server. */
export const DUMMY_TURBO_CRED = "silk-runtime-action";

/** Result summary for action outputs. */
export interface TurboApplyResult {
	readonly backend: "github" | "s3" | "remote" | "none";
	readonly port: number | null;
}

/**
 * Apply the resolved turbo cache strategy: export the env Turbo needs, spawn the
 * embedded server when applicable, and persist its state for the post phase.
 */
export const applyTurboCache = (
	resolution: TurboCacheResolution,
	deps: {
		serverEntry: string;
		prefix: string;
		spawn: (spec: SpawnSpec) => Effect.Effect<number, never>;
		waitForReady: (port: number) => Effect.Effect<boolean, never>;
	},
): Effect.Effect<TurboApplyResult, never, ActionOutputs | ActionState> =>
	Effect.gen(function* () {
		const outputs = yield* ActionOutputs;

		if (resolution.mode === "off") return { backend: "none" as const, port: null };

		if (resolution.mode === "passthrough") {
			yield* outputs.exportVariable("TURBO_TOKEN", resolution.token);
			yield* outputs.exportVariable("TURBO_TEAM", resolution.team);
			return { backend: "remote" as const, port: null };
		}

		// embedded — spawn, then save state immediately so post can always reap the pid
		const port = DEFAULT_TURBO_PORT;
		const spec = buildSpawnSpec(deps.serverEntry, resolution, { port, prefix: deps.prefix, token: DUMMY_TURBO_CRED });
		const pid = yield* deps.spawn(spec);
		const state = yield* ActionState;
		yield* state.save(
			STATE_KEYS.turboServerState,
			new TurboServerState({ pid, port, backend: resolution.backend }),
			TurboServerState,
		);

		// readiness probe — only wire turbo to the server once it answers
		const up = yield* deps.waitForReady(port);
		if (!up) {
			yield* Effect.logError(
				`Turbo cache server (pid=${pid}) did not become ready on 127.0.0.1:${port}; ` +
					`continuing WITHOUT a remote cache. See ${serverLogPath(port)} for server output.`,
			);
			return { backend: "none" as const, port: null };
		}

		yield* outputs.exportVariable("TURBO_API", `http://127.0.0.1:${port}`);
		yield* outputs.exportVariable("TURBO_TOKEN", DUMMY_TURBO_CRED);
		yield* outputs.exportVariable("TURBO_TEAM", DUMMY_TURBO_CRED);

		return { backend: resolution.backend as TurboApplyResult["backend"], port };
	}).pipe(
		// Turbo cache is an enhancement: never let its setup error fail the action.
		// `ActionState.save` / `exportVariable` carry ActionStateError/ActionOutputError;
		// demote any to a warning and fall back to "none".
		Effect.catch((e) =>
			Effect.logWarning(`Turbo cache setup error: ${e instanceof Error ? e.message : String(e)}`).pipe(
				Effect.as<TurboApplyResult>({ backend: "none", port: null }),
			),
		),
	);
