import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ActionOutputError } from "@effected/github-actions";
import { ActionOutputs, ActionState, DetachedProcess, Secret } from "@effected/github-actions";
import type { Redacted } from "effect";
import { Data, Effect, Option } from "effect";

import type { Inputs } from "../schema/inputs.js";
import { STATE_KEYS, TurboServerState } from "../state.js";
import { formatTurboLine } from "../summary/format.js";
import type { TurboCacheResolution } from "../turbo-cache/activation.js";
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

/**
 * The two `DetachedProcess` operations the `main` phase performs, as an
 * injectable seam.
 *
 * @remarks
 * `DetachedProcess`' members are **statics on a class**, not a service, so
 * there is no layer to swap and no `R` position to inject through. That is the
 * right shape for the kit — a detached child has no scope to hang a service off
 * — but it leaves this step with two operations a unit test must not perform
 * for real: `spawn` starts a node process that outlives the test run, and
 * `awaitReady` polls a port for six seconds before giving up.
 *
 * The seam is therefore a **defaulted field on the params object**, matching
 * `installRuntimes`' `host` and `installDependencies`' `platform`: no caller
 * passes it, the production path is the kit's own statics, and `R` is
 * unchanged — which is the point. A service wrapper would have put a
 * repository-local service into every consumer's layer composition and into
 * `PostLive` as well, to make two functions overridable.
 *
 * `reap` is absent because it belongs to the *other* phase; `post.ts` carries
 * its own seam for the same reason.
 */
export interface DetachedProcessOps {
	readonly spawn: typeof DetachedProcess.spawn;
	readonly awaitReady: typeof DetachedProcess.awaitReady;
}

/** Everything {@link startTurboCache} decides from. */
export interface StartTurboCacheArgs {
	readonly inputs: Inputs;
	/** Whether `turbo.json` was detected — rule R1's first half. */
	readonly turbo: { readonly enabled: boolean };
	/** The detached-process operations, defaulting to the kit's. See {@link DetachedProcessOps}. */
	readonly detached?: DetachedProcessOps;
	/** The server bundle to run, defaulting to the sibling of this bundle. See {@link defaultServerEntry}. */
	readonly serverEntry?: string;
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
}

/** No server, no environment, nothing for `post` to do. */
const DISABLED: StartedTurboCache = { backend: "none", port: Option.none(), state: Option.none() };

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
 * Whether the embedded server is answering on `port` yet.
 *
 * @remarks
 * **False rather than failed on a refused connection** (ruling 63). The kit's
 * `awaitReady` propagates probe *failures* — a probe that cannot run is a
 * different situation from a child that is not up yet, and retrying the first
 * for six seconds hides a misconfiguration behind a timeout. But a connection
 * refused by a server that has not finished binding is precisely "not up yet",
 * so it has to arrive as `false`; the same is true of a non-2xx answer, which
 * is a server that is listening but not serving.
 *
 * That leaves the error channel `never`, and the only failure `awaitReady` can
 * then produce is its own exhaustion — which the caller degrades on.
 */
export const readinessProbe = (port: number): Effect.Effect<boolean> =>
	Effect.tryPromise(() => fetch(`http://127.0.0.1:${port}${STATUS_PATH}`).then((response) => response.ok)).pipe(
		Effect.catch(() => Effect.succeed(false)),
	);

/**
 * Registers every secret this run was handed with the runner's log filter.
 *
 * @remarks
 * Unconditional, and *before* the activation table runs (oracle 7): a secret a
 * workflow supplied is a secret worth redacting whether or not the resolution
 * ends up using it. A run that sets `turbo-s3-secret-access-key` alongside
 * passthrough credentials resolves to Vercel and never touches S3 — and would,
 * without this, carry an unmasked key through a job that logs its environment.
 *
 * `turbo-s3-access-key-id` is masked too, which v1 did not do (ruling 78). It
 * is the least sensitive of the four and pairing it with the secret it
 * authenticates alongside costs nothing.
 *
 * The two `Redacted` values go through `Secret.forSigning` rather than
 * `Redacted.value`: declassification is the kit's seam and masking is what it
 * does first, so this call *is* the mask — the returned plaintext is
 * deliberately discarded.
 */
const maskSuppliedSecrets = (inputs: Inputs) =>
	Effect.gen(function* () {
		const outputs = yield* ActionOutputs;
		for (const redacted of [inputs.turboToken, inputs.turboS3SecretAccessKey, inputs.turboS3SessionToken]) {
			if (Option.isSome(redacted)) yield* Secret.forSigning(redacted.value);
		}
		if (Option.isSome(inputs.turboS3AccessKeyId)) yield* outputs.setSecret(inputs.turboS3AccessKeyId.value);
	});

/** `{ [name]: value }` when the option holds one, and nothing when it does not. */
const whenSome = (name: string, value: Option.Option<string>): Record<string, string> =>
	Option.match(value, { onNone: () => ({}), onSome: (present) => ({ [name]: present }) });

/**
 * The environment the detached server is configured through.
 *
 * @remarks
 * Environment and nothing else (oracle 28-30) — the names come from
 * `TURBO_SERVER_ENV`, which the worker parses with, so the two halves of the
 * handoff cannot drift. `DetachedProcess.spawn` merges this **over** the
 * parent's environment, which is what carries `ACTIONS_RUNTIME_TOKEN` through
 * to the GitHub backend without this step ever reading it.
 *
 * Absent optional settings are omitted rather than written empty. The worker
 * reads unset and empty as the same case, and an omitted variable is the
 * clearer thing to find in a process listing.
 *
 * The two S3 secrets travel through `Secret.forChildEnv`, which masks the whole
 * set before returning any plaintext — the one sanctioned way a `Redacted`
 * becomes a child's environment variable (oracle 67).
 */
const spawnEnvironment = (
	resolution: Extract<TurboCacheResolution, { mode: "embedded" }>,
	options: { readonly port: number; readonly prefix: string; readonly token: string },
): Effect.Effect<Record<string, string>, never, ActionOutputs> =>
	Effect.gen(function* () {
		const base: Record<string, string> = {
			[TURBO_SERVER_ENV.port]: String(options.port),
			[TURBO_SERVER_ENV.prefix]: options.prefix,
			[TURBO_SERVER_ENV.token]: options.token,
			[TURBO_SERVER_ENV.backend]: resolution.backend,
		};
		if (resolution.backend !== "s3") return base;

		const { s3 } = resolution;
		const secrets: Record<string, Redacted.Redacted<string>> = {
			...(Option.isSome(s3.secretAccessKey) ? { [TURBO_SERVER_ENV.s3SecretAccessKey]: s3.secretAccessKey.value } : {}),
			...(Option.isSome(s3.sessionToken) ? { [TURBO_SERVER_ENV.s3SessionToken]: s3.sessionToken.value } : {}),
		};
		return {
			...base,
			[TURBO_SERVER_ENV.s3Bucket]: s3.bucket,
			...whenSome(TURBO_SERVER_ENV.s3Region, s3.region),
			...whenSome(TURBO_SERVER_ENV.s3Endpoint, s3.endpoint),
			...whenSome(TURBO_SERVER_ENV.s3AccessKeyId, s3.accessKeyId),
			...whenSome(TURBO_SERVER_ENV.s3Prefix, s3.prefix),
			...(yield* Secret.forChildEnv(secrets)),
		};
	});

/**
 * Starts and wires the embedded server for an `embedded` resolution.
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
	resolution: Extract<TurboCacheResolution, { mode: "embedded" }>,
	args: StartTurboCacheArgs,
): Effect.Effect<StartedTurboCache, TurboCacheError | ActionOutputError, ActionOutputs | ActionState> =>
	Effect.gen(function* () {
		const outputs = yield* ActionOutputs;
		const detached = args.detached ?? DetachedProcess;
		const port = DEFAULT_TURBO_SERVER_PORT;
		const logFile = serverLogPath(port);
		const credential = randomUUID();
		const environment = yield* spawnEnvironment(resolution, {
			port,
			prefix: args.inputs.turboCachePrefix,
			token: credential,
		});

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
							message: `Turbo cache server could not be started (${cause.reason}): ${cause.message}`,
							cause,
						}),
					),
				),
			);

		const saved = TurboServerState.make({ pid, port, backend: resolution.backend, logFile });
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
		yield* Effect.logDebug(`Turbo cache server started: pid=${pid}, backend=${resolution.backend}, log=${logFile}`);

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
			const degraded: StartedTurboCache = { backend: "none", port: Option.none(), state: Option.some(saved) };
			return degraded;
		}

		yield* outputs.exportVariable("TURBO_API", `http://127.0.0.1:${port}`);
		yield* outputs.exportVariable("TURBO_TOKEN", credential);
		yield* outputs.exportVariable("TURBO_TEAM", credential);
		// The step's own line, in the same words the job summary's row uses — one
		// formatter renders both, so the log and the panel cannot disagree about
		// what the cache ended up being (oracle 30).
		yield* Effect.logInfo(formatTurboLine(resolution.backend, Option.some(port)));
		const started: StartedTurboCache = {
			backend: resolution.backend,
			port: Option.some(port),
			state: Option.some(saved),
		};
		return started;
	});

/**
 * Resolves the turbo remote cache strategy and applies it: masks what was
 * supplied, exports what turbo reads, and starts the embedded server when the
 * table selects one.
 *
 * @remarks
 * Runs **last** in the pipeline, and deliberately so: nothing earlier consumes
 * the turbo environment, and starting the server here rather than before the
 * cache restore shortens the window in which the runner's short-lived
 * `ACTIONS_RUNTIME_TOKEN` is held by a detached child (a ruled deviation from
 * v1, which started it first).
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
): Effect.Effect<StartedTurboCache, TurboCacheError, ActionState | ActionOutputs> =>
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
			yield* outputs.exportVariable("TURBO_TOKEN", yield* Secret.forRunnerFile(resolution.token));
			yield* outputs.exportVariable("TURBO_TEAM", resolution.team);
			yield* Effect.logDebug(`Turbo remote cache: passthrough to team ${resolution.team}`);
			yield* Effect.logInfo(formatTurboLine("remote", Option.none()));
			const passthrough: StartedTurboCache = { backend: "remote", port: Option.none(), state: Option.none() };
			return passthrough;
		}
		return yield* startEmbeddedServer(resolution, args);
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
