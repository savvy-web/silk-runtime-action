import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import type { BlobEnvelopeError, BlobStore, BlobStoreError } from "@effected/github-actions";
import { ActionEnvironment, GitHubCacheBlobStore } from "@effected/github-actions";
import { Layer, Result } from "effect";

/**
 * The environment variables the detached cache server is configured with.
 *
 * @remarks
 * Config reaches the server through the environment and nothing else (oracle
 * 28-30): it is spawned detached, with no channel back to the action, and a
 * command line would put the token in the process table. These names are the
 * contract between the step that builds the spawn specification and the entry
 * point that reads it, which is why they are a shared constant rather than two
 * lists of strings that could drift.
 *
 * `TURBOGHA_` is v1's prefix, kept so an operator reading a runner's process
 * list sees the same thing they always have.
 */
export const TURBO_SERVER_ENV = {
	port: "TURBOGHA_PORT",
	prefix: "TURBOGHA_PREFIX",
	token: "TURBOGHA_TOKEN",
	backend: "TURBOGHA_BACKEND",
} as const;

/**
 * The port the embedded server binds, fixed rather than negotiated.
 *
 * @remarks
 * Quirk 71, ruled kept: turbo reaches the server through `TURBO_API`, which
 * the action exports, so a negotiated port would work — but it would also mean
 * the action and the server disagreeing about the port whenever the handoff
 * fails, and there is nothing on a runner competing for this one. Ruling 71
 * adds the missing half instead: a listen that fails says so and exits.
 */
export const DEFAULT_TURBO_SERVER_PORT = 41_230;

/** The highest port a TCP listen accepts. */
const MAX_PORT = 65_535;

/**
 * What the detached server needs to know to run.
 *
 * @remarks
 * `backend` has one value. It stays a field because the worker says it in its
 * startup line and `post` reports it, and both read better naming the store
 * than assuming it.
 */
export interface TurboServerConfig {
	readonly port: number;
	readonly prefix: string;
	readonly token: string;
	readonly backend: "github";
}

/** The environment as `process.env` hands it over. */
type Environment = Readonly<Record<string, string | undefined>>;

/** A variable's value, with unset and empty the same case. */
const read = (env: Environment, name: string): string => env[name] ?? "";

/**
 * Reads the detached server's configuration out of an environment.
 *
 * @remarks
 * Fails — rather than booting degraded — when there is no token. v1 read an
 * absent `TURBOGHA_TOKEN` as an empty one, which the handler treats as
 * "authentication disabled" (quirk 72), so a spawn that lost its environment
 * left an **open** cache server listening on the runner. Ruling 72 closes it
 * here rather than at the handler, because the handler's permissive branch is
 * what a test needs and the worker's is what an operator needs: the step
 * always supplies a token, so a missing one means something is wrong and
 * exiting says so.
 *
 * A port that is not a whole number in `1..65535` falls back to
 * {@link DEFAULT_TURBO_SERVER_PORT}. The one value the step ever writes is
 * that port, so a garbage value means something else set it, and binding the
 * known port keeps the server reachable. The range check is load-bearing
 * rather than tidy: `listen` throws **synchronously** on a bad port, so the
 * `error` listener ruling 71 added never fires for exactly this case, and the
 * process would die with a stack trace instead of the one line it exists to
 * print.
 *
 * `TURBOGHA_BACKEND` is not read. The embedded server has one store, the
 * GitHub Actions cache, so whatever that variable says the answer is `github`;
 * the step still writes it, for an operator reading a runner's process list.
 */
export const readServerConfig = (env: Environment): Result.Result<TurboServerConfig, string> => {
	const token = read(env, TURBO_SERVER_ENV.token);
	if (token === "") {
		return Result.fail(`${TURBO_SERVER_ENV.token} is not set — refusing to start an unauthenticated cache server`);
	}
	const port = Number(read(env, TURBO_SERVER_ENV.port));
	return Result.succeed({
		port: Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : DEFAULT_TURBO_SERVER_PORT,
		prefix: read(env, TURBO_SERVER_ENV.prefix),
		token,
		backend: "github",
	});
};

/**
 * Everything the store needs that is not the store: the platform services the
 * GitHub cache backend is built over.
 *
 * @remarks
 * The action's own layers come from `ActionRuntime`, which this process does
 * not have — a detached worker composes its own. `ActionEnvironment` is here
 * because the backend reads the runner's cache url and runtime token from it.
 *
 * There is deliberately no `ActionOutputs` in a worker. It is detached, so its
 * stdout is a file in the temp directory (oracle 27, 31) that no runner parses:
 * a workflow command written here, a mask included, would spell its argument
 * into that file in the clear. Nothing the GitHub backend does needs one.
 */
const platform = Layer.mergeAll(
	NodeHttpClient.layerUndici,
	ActionEnvironment.layer.pipe(Layer.provide(NodeFileSystem.layer)),
);

/**
 * The blob backend the server stores artifacts in: the GitHub Actions cache.
 *
 * @remarks
 * A `BlobStore` layer, which is the seam the handler is written against —
 * nothing above it knows which store it got, so a second backend would again
 * be a layer and nothing else.
 */
export const serverBlobStoreLayer: Layer.Layer<BlobStore> = GitHubCacheBlobStore.layer.pipe(Layer.provide(platform));

/**
 * Whether a store failure looks like an authentication problem.
 *
 * @remarks
 * Ruling 70's classifier. The GitHub backend captures `ACTIONS_RUNTIME_TOKEN`
 * when the server starts and that token is a short-lived JWT, so on a long job
 * the last cache writes can come back 401 while everything before them
 * succeeded. The limitation stands — there is no refresh channel into a
 * detached process — but it is now *diagnosable*: the worker logs a distinct
 * line for this shape, so a run that quietly stopped caching says why.
 *
 * A `refused` with no status counts: the backend answered unhappily, which for
 * a cache write is the same class of fault.
 */
export const isAuthShapedFailure = (error: BlobStoreError | BlobEnvelopeError): boolean =>
	error._tag === "BlobStoreError" && (error.status === 401 || error.reason === "refused");
