import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ActionOutputError, DetachedProcessOps } from "@effected/github-actions";
import { ActionOutputs, ActionState, DetachedProcess, Secret } from "@effected/github-actions";
import { Data, Effect, Option, Redacted } from "effect";
import type { HttpClient } from "effect/http";

import type { Inputs } from "../schema/inputs.js";
import { STATE_KEYS, TurboServerState } from "../state.js";
import { formatTurboLine } from "../summary/format.js";
import { hasPartialPassthroughCredentials, resolveTurboCache } from "../turbo-cache/activation.js";
import { DEFAULT_TURBO_SERVER_PORT, TURBO_SERVER_ENV } from "../turbo-cache/server-config.js";

/**
 * Raised when the embedded turbo remote-cache server cannot be spawned, or is
 * spawned and never becomes ready.
 *
 * @remarks
 * Shaped, then logged — never raised. The turbo remote cache is an
 * optimization layered on a build that works without it, so every failure here
 * degrades to a cacheless run (oracle 42). The two reasons exist so a log grep
 * can tell them apart: `spawn` is a child that never started, and `readiness`
 * is a child that started and never answered.
 *
 * A third literal, `backend`, was declared for "a configuration that names no
 * reachable store" and never got a producer — the activation table resolves
 * every input combination to one of its four rows, so there is no such state to
 * raise from (ruling 43). It is dropped rather than left as a reason a
 * `catchTag` would have to handle and never see; re-adding it later is additive.
 */
export class TurboCacheError extends Data.TaggedError("TurboCacheError")<{
	readonly reason: "spawn" | "readiness";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** Everything {@link startTurboCache} decides from. */
export interface StartTurboCacheArgs {
	readonly inputs: Inputs;
	/** Whether `turbo.json` was detected — rule R1's first half. */
	readonly turbo: { readonly enabled: boolean };
	/**
	 * The detached-process operations, defaulting to `DetachedProcess.ops`.
	 *
	 * @remarks
	 * The kit's own seam now (effected#240), replacing the two-member interface
	 * this module used to declare. `DetachedProcess`' members are statics on a
	 * class rather than a service — the right shape, since a child that outlives
	 * the process holding its handle has no scope to hang a service off — so
	 * there is no layer to swap and the seam has to be parameter injection.
	 *
	 * Still a **defaulted field on the params object**, matching
	 * `installRuntimes`' `host` and `installDependencies`' `platform`: no
	 * production caller passes it, and `R` is unchanged by the seam itself.
	 *
	 * A test passes `DetachedProcess.makeTestOps({ … })` with only the members it
	 * means to observe; the rest die naming themselves. That is strictly better
	 * than the local interface it replaces, which had to be satisfied in full and
	 * so let a test supply a real static by omission — the hazard being a unit
	 * test that spawns a node process outliving the run, or signals a live pid.
	 */
	readonly detached?: DetachedProcessOps;
	/** The server bundle to run, defaulting to the sibling of this bundle. See {@link defaultServerEntry}. */
	readonly serverEntry?: string;
	/**
	 * The port to spawn the server on, defaulting to
	 * {@link DEFAULT_TURBO_SERVER_PORT}.
	 *
	 * @remarks
	 * A test seam like the two above, and one this repository's own CI makes
	 * necessary: the job that runs the unit suite is set up by *this very
	 * action*, so a real cache server already holds the default port. A test
	 * that needs to stand a listener on the step's port must be able to point
	 * the step somewhere it owns.
	 */
	readonly port?: number;
}

/** What the `main` phase learned about the turbo remote cache. */
export interface StartedTurboCache {
	/** The `turbo-cache-backend` output's value (oracle 40's vocabulary). */
	readonly backend: "github" | "s3" | "remote" | "none";
	/** The port the embedded server bound, when one was started *and* answered. */
	readonly port: Option.Option<number>;
	/**
	 * What was persisted for the post phase to reap.
	 *
	 * @remarks
	 * Present whenever a child was spawned — **including when it never became
	 * ready**. `backend` and `port` report what turbo can use; this reports what
	 * `post` has to clean up, and the degraded case is exactly the one where the
	 * two answers differ (oracle 34, 39 row 4).
	 */
	readonly state: Option.Option<TurboServerState>;
	/**
	 * The variables this step exported for turbo, by name — empty when it
	 * exported none.
	 *
	 * @remarks
	 * `ActionOutputs.exportVariable` writes `GITHUB_ENV`, which configures the
	 * job's *later* steps and never this process. So a child this run spawns
	 * itself — the dependency install, whose `prepare` scripts are where a Silk
	 * workspace runs one turbo build per package — sees none of it unless it is
	 * handed the same values directly. This is that handoff: the exact set that
	 * was exported, so the install's children and the consumer's later steps
	 * cannot be configured differently.
	 *
	 * Plaintext by necessity, the passthrough `TURBO_TOKEN` included: it is the
	 * same string `Secret.forRunnerFile` already declassified for the export, so
	 * it is masked in the log before it exists here.
	 */
	readonly environment: Readonly<Record<string, string>>;
}

/** No server, no environment, nothing for `post` to do. */
const DISABLED: StartedTurboCache = { backend: "none", port: Option.none(), state: Option.none(), environment: {} };

/**
 * Where the detached server writes its stdout and stderr.
 *
 * @remarks
 * Derived from the port rather than randomized (oracle 27), so three separate
 * places name the same file without passing it between them: the spawn, the
 * failed-readiness error, and `post`'s teardown debug line. A run whose server
 * misbehaved is diagnosed by reading it.
 */
export const serverLogPath = (port: number): string => join(tmpdir(), `turbogha-${port}.log`);

/**
 * The server bundle, resolved as a sibling of the bundle this code is in.
 *
 * @remarks
 * The build emits `dist/main.js` and `dist/turbo-server.js` side by side, and
 * this module is bundled into the former — so `import.meta.url` is the main
 * bundle and its directory holds the worker (oracle 43). The value is
 * meaningful *only* in the built artifact: run from source, it points at a
 * `turbo-server.js` beside `src/steps/`, which is why every test supplies
 * {@link StartTurboCacheArgs.serverEntry} instead of exercising this.
 */
export const defaultServerEntry = (): string => join(dirname(fileURLToPath(import.meta.url)), "turbo-server.js");

/** Turbo's status route, which the embedded server answers without auth (ruling 73). */
const STATUS_PATH = "/v8/artifacts/status";

/**
 * The readiness probe `awaitReady` polls: whether the embedded server is
 * answering on `port` yet.
 *
 * @remarks
 * `DetachedProcess.httpProbe` now carries ruling 63 for us, on the kit's own
 * terms and in the same words: a refused connection, a transport error and a
 * non-2xx answer all arrive as `false`, because every failure an HTTP readiness
 * check can see means "not up yet". That leaves the error channel `never`, so
 * the only failure `awaitReady` can produce is its own exhaustion — which the
 * caller degrades on. The fifteen lines of local reasoning this replaces said
 * exactly that and are gone (effected#240).
 *
 * The trade the kit's TSDoc names is one this repo had already accepted: a
 * typo'd port is indistinguishable from a slow start and surfaces as
 * not-ready-after-budget rather than as a configuration error.
 */
const readinessProbe = (port: number) => DetachedProcess.httpProbe(`http://127.0.0.1:${port}${STATUS_PATH}`);

/**
 * Registers every secret this run was handed with the runner's log filter.
 *
 * @remarks
 * Unconditional, and *before* the activation table runs (oracle 7): a secret a
 * workflow supplied is a secret worth redacting whether or not the resolution
 * ends up using it. A run that sets `turbo-token` alongside `turbo-cache: off`
 * never talks to Vercel — and would, without this, carry an unmasked token
 * through a job that logs its environment.
 *
 * The `Redacted` value goes through `Secret.mask`, which registers with the log
 * filter and returns nothing. This site is the reason that member exists
 * (effected#239's sibling): it previously called `Secret.forSigning` purely for
 * the mask and threw the plaintext away, which recorded "declassified for
 * signing" in the kit's audit seam about values that never sign. The kit's
 * invariant now reads *masking is the floor, declassification implies it*, and
 * the honest call for a site that only masks is the one that only masks.
 */
const maskSuppliedSecrets = (inputs: Inputs) =>
	Effect.gen(function* () {
		if (Option.isSome(inputs.turboToken)) yield* Secret.mask(inputs.turboToken.value);
	});

/** The one store the embedded server is built over: the GitHub Actions cache. */
const EMBEDDED_BACKEND = "github";

/**
 * The environment the detached server is configured through.
 *
 * @remarks
 * Environment and nothing else (oracle 28-30) — the names come from
 * `TURBO_SERVER_ENV`, which the worker parses with, so the two halves of the
 * handoff cannot drift. `DetachedProcess.spawn` merges this **over** the
 * parent's environment, which is what carries `ACTIONS_RUNTIME_TOKEN` through
 * to the GitHub backend without this step ever reading it.
 */
const spawnEnvironment = (options: {
	readonly port: number;
	readonly prefix: string;
	readonly token: string;
}): Record<string, string> => ({
	[TURBO_SERVER_ENV.port]: String(options.port),
	[TURBO_SERVER_ENV.prefix]: options.prefix,
	[TURBO_SERVER_ENV.token]: options.token,
	[TURBO_SERVER_ENV.backend]: EMBEDDED_BACKEND,
});

/**
 * Starts and wires the embedded server.
 *
 * @remarks
 * The order is the contract. The state is persisted **between** the spawn and
 * the readiness wait (oracle 34), so a child that hangs half-started is still
 * reapable by `post` — the window where a leaked process would survive the job
 * is the width of one `ActionState.save` rather than of the whole six-second
 * readiness budget.
 *
 * The credential is a fresh `randomUUID` per run (ruling 76), replacing v1's
 * constant compiled into the source. It is the server's `expectedToken` and the
 * `TURBO_TOKEN` turbo authenticates with, so both sides come from this one
 * value and a leaked build no longer discloses every runner's cache
 * credential.
 *
 * A server that never answers is an error line naming the pid, the address and
 * the log file, and a run that continues without a remote cache (oracle 39 row
 * 4, 41). Nothing is exported in that case: a `TURBO_API` pointing at a dead
 * port would turn every later cache operation into a connection error.
 */
const startEmbeddedServer = (
	args: StartTurboCacheArgs,
): Effect.Effect<
	StartedTurboCache,
	TurboCacheError | ActionOutputError,
	ActionOutputs | ActionState | HttpClient.HttpClient
> =>
	Effect.gen(function* () {
		const outputs = yield* ActionOutputs;
		const detached = args.detached ?? DetachedProcess.ops;
		const port = args.port ?? DEFAULT_TURBO_SERVER_PORT;
		const logFile = serverLogPath(port);
		// Masked before the spawn: every later step echoes TURBO_TOKEN in its env
		// block, and a per-run loopback credential is still a credential.
		const credential = yield* Secret.forRunnerFile(Redacted.make(randomUUID()));
		const environment = spawnEnvironment({ port, prefix: args.inputs.turboCachePrefix, token: credential });

		const pid = yield* detached
			.spawn({
				command: process.execPath,
				args: [args.serverEntry ?? defaultServerEntry()],
				logFile,
				env: environment,
			})
			.pipe(
				Effect.catch((cause) =>
					Effect.fail(
						new TurboCacheError({
							reason: "spawn",
							message: `Turbo cache server could not be started (${cause._tag}): ${cause.message}`,
							cause,
						}),
					),
				),
			);

		const saved = TurboServerState.make({ pid, port, backend: EMBEDDED_BACKEND, logFile });
		yield* (yield* ActionState).save(STATE_KEYS.turboServer, saved, TurboServerState).pipe(
			Effect.catch((cause) =>
				Effect.logWarning(
					new TurboCacheError({
						reason: "spawn",
						message: `Turbo cache server state could not be saved (${cause.reason}); pid ${pid} will not be reaped by the post phase`,
						cause,
					}).message,
				),
			),
		);
		yield* Effect.logDebug(`Turbo cache server started: pid=${pid}, backend=${EMBEDDED_BACKEND}, log=${logFile}`);

		const ready = yield* detached.awaitReady(readinessProbe(port)).pipe(
			Effect.as(true),
			Effect.catch((cause) =>
				Effect.logError(
					new TurboCacheError({
						reason: "readiness",
						message:
							`Turbo cache server (pid=${pid}) did not become ready on 127.0.0.1:${port}; ` +
							`continuing WITHOUT a remote cache. See ${logFile} for server output.`,
						cause,
					}).message,
				).pipe(Effect.as(false)),
			),
		);
		if (!ready) {
			const degraded: StartedTurboCache = {
				backend: "none",
				port: Option.none(),
				state: Option.some(saved),
				environment: {},
			};
			return degraded;
		}

		const exported = {
			TURBO_API: `http://127.0.0.1:${port}`,
			TURBO_TOKEN: credential,
			TURBO_TEAM: credential,
		};
		for (const [name, value] of Object.entries(exported)) yield* outputs.exportVariable(name, value);
		// The step's own line, in the same words the job summary's row uses — one
		// formatter renders both, so the log and the panel cannot disagree about
		// what the cache ended up being (oracle 30).
		yield* Effect.logInfo(formatTurboLine(EMBEDDED_BACKEND, Option.some(port)));
		const started: StartedTurboCache = {
			backend: EMBEDDED_BACKEND,
			port: Option.some(port),
			state: Option.some(saved),
			environment: exported,
		};
		return started;
	});

/**
 * Resolves the turbo remote cache strategy and applies it: masks what was
 * supplied, exports what turbo reads, and starts the embedded server when the
 * table selects one.
 *
 * @remarks
 * Runs as late as its consumers allow, and `program.ts` decides which of two
 * positions that is. Starting the server late shortens the window in which the
 * runner's short-lived `ACTIONS_RUNTIME_TOKEN` is held by a detached child (a
 * ruled deviation from v1, which started it before the cache restore), so the
 * default position is **last**. The one earlier consumer is a dependency
 * install that runs lifecycle scripts — a `prepare` that calls `turbo run` is a
 * turbo build like any other — and on those runs the step moves to just before
 * the install, which is handed {@link StartedTurboCache.environment}.
 *
 * **It cannot fail.** The declared `TurboCacheError` is the shape a failure
 * takes before it is logged, not something a caller handles: the typed channel
 * and defects are both caught here and answered with {@link DISABLED}, which is
 * the inner half of the double catch v1 relied on (oracle 42). A cache that
 * would not start is not a reason to fail a build that never needed it.
 *
 * The four resolutions map exactly as v1's did (oracle 39):
 *
 * | resolution | environment exported | backend | port |
 * | --- | --- | --- | --- |
 * | off | none | `none` | absent |
 * | passthrough | `TURBO_TOKEN`, `TURBO_TEAM` | `remote` | absent |
 * | embedded, ready | `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM` | `github`/`s3` | bound |
 * | embedded, not ready | none | `none` | absent |
 *
 * Passthrough exports no `TURBO_API` on purpose — turbo's own default is
 * Vercel's endpoint, and naming it here would pin a URL this action does not
 * own. The `passthrough` → `remote` rename happens at this boundary because
 * `remote` is the *output* vocabulary (`action.yml`'s enum) and the activation
 * table names what was decided, not what is reported.
 */
export const startTurboCache = (
	args: StartTurboCacheArgs,
): Effect.Effect<StartedTurboCache, TurboCacheError, ActionState | ActionOutputs | HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const outputs = yield* ActionOutputs;
		yield* maskSuppliedSecrets(args.inputs);

		const resolution = resolveTurboCache({ turboDetected: args.turbo.enabled, inputs: args.inputs });
		if (resolution.mode === "off") {
			yield* Effect.logDebug("Turbo remote cache is off");
			return DISABLED;
		}
		// Ruling 77, and it fires *here* rather than before the table because this
		// is where its text is true. v1 said nothing at all when a workflow set one
		// credential, and the run silently started an embedded server instead of
		// talking to Vercel — indistinguishable in the log from a workflow that
		// configured no passthrough at all. Partial credentials cannot reach the
		// passthrough branch (rule R2 needs both), so past the `off` return the only
		// thing left to fall through to is the embedded server, and the warning can
		// say so.
		if (hasPartialPassthroughCredentials(args.inputs)) {
			yield* Effect.logWarning(
				"Both turbo-token and turbo-team are required for an external remote cache; " +
					"only one was supplied, so the embedded cache server is being used instead.",
			);
		}
		if (resolution.mode === "passthrough") {
			const exported = { TURBO_TOKEN: yield* Secret.forRunnerFile(resolution.token), TURBO_TEAM: resolution.team };
			for (const [name, value] of Object.entries(exported)) yield* outputs.exportVariable(name, value);
			yield* Effect.logDebug(`Turbo remote cache: passthrough to team ${resolution.team}`);
			yield* Effect.logInfo(formatTurboLine("remote", Option.none()));
			const passthrough: StartedTurboCache = {
				backend: "remote",
				port: Option.none(),
				state: Option.none(),
				environment: exported,
			};
			return passthrough;
		}
		// A `hosted` resolution lands here too: the embedded server is where a
		// hosted run ends up whenever sign-in is not possible, and until the step
		// signs in that is every hosted run.
		return yield* startEmbeddedServer(args);
	}).pipe(
		Effect.catch((error) => Effect.logWarning(`Turbo cache setup error: ${error.message}`).pipe(Effect.as(DISABLED))),
		// Defense in depth, matching post's posture: a defect anywhere in the spawn
		// path must not fail a job whose build does not depend on the cache.
		Effect.catchDefect((defect) =>
			Effect.logWarning(`Turbo cache setup defect: ${defect instanceof Error ? defect.message : String(defect)}`).pipe(
				Effect.as(DISABLED),
			),
		),
	);
