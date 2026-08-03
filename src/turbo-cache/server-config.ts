import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import type { BlobEnvelopeError, BlobStoreError, S3Config } from "@effected/github-actions";
import { ActionEnvironment, ActionOutputs, BlobStore, GitHubCacheBlobStore } from "@effected/github-actions";
import { Layer, Redacted, Result } from "effect";

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
	s3Bucket: "TURBOGHA_S3_BUCKET",
	s3Region: "TURBOGHA_S3_REGION",
	s3Endpoint: "TURBOGHA_S3_ENDPOINT",
	s3AccessKeyId: "TURBOGHA_S3_ACCESS_KEY_ID",
	s3SecretAccessKey: "TURBOGHA_S3_SECRET_ACCESS_KEY",
	s3SessionToken: "TURBOGHA_S3_SESSION_TOKEN",
	s3Prefix: "TURBOGHA_S3_PREFIX",
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

/** What the detached server needs to know to run. */
export type TurboServerConfig = {
	readonly port: number;
	readonly prefix: string;
	readonly token: string;
} & ({ readonly backend: "github" } | { readonly backend: "s3"; readonly s3: S3Config });

/** The environment as `process.env` hands it over. */
type Environment = Readonly<Record<string, string | undefined>>;

/** A variable's value, with unset and empty the same case. */
const read = (env: Environment, name: string): string => env[name] ?? "";

/**
 * The S3 settings, assembled the way the backend wants them.
 *
 * @remarks
 * Oracle 48: the three optional fields are spread in **only when nonempty**.
 * `exactOptionalPropertyTypes` makes that a spread rather than an assignment,
 * and the distinction is real — an empty endpoint would point the signer at
 * nothing rather than at AWS, and an empty prefix would namespace every key
 * under a leading separator.
 *
 * A missing bucket or credential is read as empty rather than refused. The S3
 * backend reports its own misconfiguration, carrying the bucket and the status
 * a failed request came back with; a guess here would be a worse message for
 * the same fault.
 */
const s3ConfigFrom = (env: Environment): S3Config => {
	const endpoint = read(env, TURBO_SERVER_ENV.s3Endpoint);
	const sessionToken = read(env, TURBO_SERVER_ENV.s3SessionToken);
	const prefix = read(env, TURBO_SERVER_ENV.s3Prefix);
	return {
		bucket: read(env, TURBO_SERVER_ENV.s3Bucket),
		region: read(env, TURBO_SERVER_ENV.s3Region),
		accessKeyId: read(env, TURBO_SERVER_ENV.s3AccessKeyId),
		secretAccessKey: Redacted.make(read(env, TURBO_SERVER_ENV.s3SecretAccessKey)),
		...(endpoint === "" ? {} : { endpoint }),
		...(sessionToken === "" ? {} : { sessionToken: Redacted.make(sessionToken) }),
		...(prefix === "" ? {} : { prefix }),
	};
};

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
 * Any backend name other than `s3` is the GitHub Actions cache, matching v1's
 * `backend === "s3" ? … : github`.
 */
export const readServerConfig = (env: Environment): Result.Result<TurboServerConfig, string> => {
	const token = read(env, TURBO_SERVER_ENV.token);
	if (token === "") {
		return Result.fail(`${TURBO_SERVER_ENV.token} is not set — refusing to start an unauthenticated cache server`);
	}
	const port = Number(read(env, TURBO_SERVER_ENV.port));
	const common = {
		port: Number.isInteger(port) && port > 0 && port <= MAX_PORT ? port : DEFAULT_TURBO_SERVER_PORT,
		prefix: read(env, TURBO_SERVER_ENV.prefix),
		token,
	};
	return Result.succeed(
		read(env, TURBO_SERVER_ENV.backend) === "s3"
			? { ...common, backend: "s3", s3: s3ConfigFrom(env) }
			: { ...common, backend: "github" },
	);
};

/**
 * Everything the store needs that is not the store: the platform services both
 * backends are built over.
 *
 * @remarks
 * The action's own layers come from `ActionRuntime`, which this process does
 * not have — a detached worker composes its own. `ActionEnvironment` is here
 * because the GitHub backend reads the runner's cache url and runtime token
 * from it; `ActionOutputs` because the S3 backend requires it.
 *
 * `layerDetached` rather than the real `ActionOutputs.layer`, and **this is a
 * leak fix rather than a tidiness one**. The S3 backend declassifies its
 * signing key through `Secret.forSigning`, which masks first — and masking is
 * `::add-mask::<plaintext>` on stdout, a workflow command the runner parses out
 * of a *step's* log. This process is not a step: it is detached, and its stdout
 * is a file in the temp directory (oracle 27, 31) that no runner reads. The
 * real layer therefore writes the S3 secret in plaintext into a file `post`
 * prints the path of — which this action shipped for exactly one round.
 *
 * The kit's layer replaces the interim double this repo hand-built for that
 * fix, and improves on it in two ways worth naming: its `R` is `never`, so a
 * worker composing it *structurally cannot* write a runner file, and the
 * members that configure the parent job's later steps fail typed with
 * `reason: "detached"` rather than throwing an unstubbed-member defect.
 */
const platform = (() => {
	const fileSystem = NodeFileSystem.layer;
	const environment = ActionEnvironment.layer.pipe(Layer.provide(fileSystem));
	return Layer.mergeAll(NodeHttpClient.layerUndici, environment, ActionOutputs.layerDetached);
})();

/**
 * The blob backend a configuration selects (oracle 48).
 *
 * @remarks
 * Both backends are `BlobStore` — the choice is a layer and nothing above it
 * knows which one it got, which is the whole reason the handler is written
 * against the service rather than against either client.
 */
export const serverBlobStoreLayer = (config: TurboServerConfig): Layer.Layer<BlobStore> =>
	config.backend === "s3"
		? BlobStore.layerS3(config.s3).pipe(Layer.provide(platform))
		: GitHubCacheBlobStore.layer.pipe(Layer.provide(platform));

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
