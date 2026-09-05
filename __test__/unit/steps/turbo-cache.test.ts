import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import type { DetachedProcessError, DetachedProcessOps, DetachedSpawnOptions } from "@effected/github-actions";
import {
	ActionEnvironment,
	ActionOutputs,
	ActionState,
	ActionStateError,
	DetachedNotReadyError,
	DetachedProcess,
	DetachedSpawnFailedError,
	ProcessId,
} from "@effected/github-actions";
import { Effect, FileSystem, Layer, Logger, Option, Redacted } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { Inputs } from "../../../src/schema/inputs.js";
import { STATE_KEYS, TurboServerState } from "../../../src/state.js";
import type { StartedTurboCache, TurboCacheError } from "../../../src/steps/turbo-cache.js";
import { defaultServerEntry, serverLogPath, startTurboCache } from "../../../src/steps/turbo-cache.js";

/** Every URL the readiness probe asked for, in order. */
interface Probed {
	readonly urls: Array<string>;
}

/**
 * An `HttpClient` answering every request with `status`, or refusing to connect.
 *
 * @remarks
 * Replaces the loopback `createServer` this suite used to stand up for the
 * readiness cases. The probe is `DetachedProcess.httpProbe` now (effected#240),
 * so `HttpClient` is the seam — which is the upgrade the swap buys: these cases
 * used to need a real listener on a real port, in a job that is *itself* set up
 * by this action and therefore may already hold one.
 *
 * `refused` fails the way a transport error arrives rather than answering a
 * status, because "the child has not finished binding" is the case ruling 63
 * exists for and it is not reachable by any status code.
 */
const httpClientStub = (
	probed: Probed,
	options: { readonly status?: number; readonly refused?: boolean } = {},
): Layer.Layer<HttpClient.HttpClient> =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request, url) => {
			probed.urls.push(url.toString());
			return options.refused === true
				? Effect.fail(
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								cause: new Error("connect ECONNREFUSED"),
							}),
						}),
					)
				: Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: options.status ?? 200 })));
		}),
	);

/** Every optional input absent, every default applied. */
const BASE_INPUTS: Inputs = {
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
	ignoreScripts: false,
	bats: "auto",
	kcov: "auto",
	cacheBust: Option.none(),
	additionalLockfiles: [],
	additionalCachePaths: [],
};

const inputs = (overrides: Partial<Inputs> = {}): Inputs => ({ ...BASE_INPUTS, ...overrides });

/** The server bundle every test names, so no test resolves the real one. */
const SERVER_ENTRY = "/opt/action/dist/turbo-server.js";

/** Everything one `startTurboCache` run did, as this suite cares about it. */
interface Recorded {
	/** Variables exported for later workflow steps, in order. */
	readonly exported: Array<readonly [string, string]>;
	/** Values registered with the runner's log mask. */
	readonly masked: Array<string>;
	/** The spawn specifications the step handed the kit. */
	readonly spawns: Array<DetachedSpawnOptions>;
	/** State keys written, in order. */
	readonly saved: Array<readonly [string, TurboServerState]>;
	/** Every operation that happened, in the order it happened. */
	readonly order: Array<string>;
	/** Every log line the step emitted. */
	readonly logs: Array<string>;
	/**
	 * The readiness probes handed to `awaitReady`.
	 *
	 * @remarks
	 * Captured rather than run. Running one here would reach the network from a
	 * unit test; keeping it lets a test that *supplies* a server run it, which is
	 * the difference between asserting a probe was passed and asserting the right
	 * one was.
	 */
	readonly probes: Array<Effect.Effect<boolean, never, HttpClient.HttpClient>>;
}

const recorder = (): Recorded => ({
	exported: [],
	masked: [],
	spawns: [],
	saved: [],
	order: [],
	logs: [],
	probes: [],
});

/** The exported value of `name`, if the run exported one. */
const exported = (recorded: Recorded, name: string): string | undefined =>
	recorded.exported.find(([key]) => key === name)?.[1];

/**
 * A `DetachedProcess` seam recording its calls and answering as `options` says.
 *
 * @remarks
 * Built through `DetachedProcess.makeTestOps` (effected#240) rather than as an
 * object literal, which is what makes the omission meaningful: `reap` belongs to
 * the post phase and is never called here, so leaving it unstubbed should be an
 * assertion rather than a gap. The kit's unstubbed members die naming themselves
 * — where the local interface this replaces had to be satisfied in full, so the
 * only way to leave a member out was to hand over the real static, which for
 * `reap` means signalling whatever process owns a made-up pid.
 */
const detachedTest = (
	recorded: Recorded,
	options: {
		readonly pid?: number;
		readonly spawn?: Effect.Effect<ChildProcessSpawner.ProcessId, DetachedProcessError>;
		readonly ready?: Effect.Effect<void, DetachedProcessError>;
	} = {},
): DetachedProcessOps =>
	DetachedProcess.makeTestOps({
		spawn: (spec) =>
			Effect.suspend(() => {
				recorded.spawns.push(spec);
				recorded.order.push("spawn");
				return options.spawn ?? Effect.succeed(ChildProcessSpawner.ProcessId(options.pid ?? 4242));
			}),
		// The probe is captured, never run here: a unit test must not reach the
		// network by default. The cases that exercise it run the *captured* probe
		// against `httpClientStub`.
		awaitReady: ((probe: Effect.Effect<boolean, never, HttpClient.HttpClient>) =>
			Effect.suspend(() => {
				recorded.probes.push(probe);
				recorded.order.push("awaitReady");
				return options.ready ?? Effect.void;
			})) as unknown as DetachedProcessOps["awaitReady"],
	});

/**
 * An `HttpClient` that dies if the step itself issues a request.
 *
 * @remarks
 * The step never runs the probe — it hands it to `awaitReady`, which this
 * suite's seam captures without running. So `HttpClient` is in the step's `R`
 * statically and unused dynamically, and the honest default is a client that
 * fails loudly rather than one that answers. The cases that exercise the probe
 * run the captured value themselves, against `httpClientStub`.
 */
const httpClientUnused: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
	HttpClient.HttpClient,
	HttpClient.make(() => Effect.die(new Error("the step issued an HTTP request; only the captured probe should"))),
);

/** The services `startTurboCache` needs, all recording into `recorded`. */
const layer = (
	recorded: Recorded,
	options: { readonly save?: Effect.Effect<void, ActionStateError> } = {},
): Layer.Layer<ActionOutputs | ActionState | HttpClient.HttpClient> =>
	Layer.mergeAll(
		ActionOutputs.layerTest({
			exportVariable: (name, value) =>
				Effect.sync(() => {
					recorded.exported.push([name, value]);
					recorded.order.push(`export:${name}`);
				}),
			setSecret: (value) => Effect.sync(() => void recorded.masked.push(value)),
		}),
		ActionState.layerTest({
			save: ((key: string, value: TurboServerState) =>
				Effect.suspend(() => {
					recorded.saved.push([key, value]);
					recorded.order.push("save");
					return options.save ?? Effect.void;
				})) as ActionState["Service"]["save"],
		}),
		Logger.layer([Logger.make(({ message }) => void recorded.logs.push(String(message)))]),
		httpClientUnused,
	);

/** Runs the step over recording doubles and hands back both halves. */
const run = (
	args: {
		readonly inputs?: Inputs;
		readonly turbo?: boolean;
		readonly detached?: DetachedProcessOps;
		readonly save?: Effect.Effect<void, ActionStateError>;
		readonly port?: number;
	} = {},
): Effect.Effect<{ readonly started: StartedTurboCache; readonly recorded: Recorded }, TurboCacheError> =>
	Effect.suspend(() => {
		const recorded = recorder();
		return startTurboCache({
			inputs: args.inputs ?? inputs(),
			turbo: { enabled: args.turbo ?? true },
			detached: args.detached ?? detachedTest(recorded),
			serverEntry: SERVER_ENTRY,
			...(args.port === undefined ? {} : { port: args.port }),
		}).pipe(
			Effect.map((started) => ({ started, recorded })),
			Effect.provide(layer(recorded, args.save === undefined ? {} : { save: args.save })),
		);
	});

describe("serverLogPath", () => {
	it("derives one path per port, in the temp directory", () => {
		// Three call sites name this file without passing it between them: the
		// spawn, the failed-readiness error and post's teardown log line.
		assert.strictEqual(serverLogPath(41230), join(tmpdir(), "turbogha-41230.log"));
		assert.notStrictEqual(serverLogPath(9080), serverLogPath(41230));
	});
});

describe("defaultServerEntry", () => {
	it("names the worker bundle beside the bundle it is called from", () => {
		const entry = defaultServerEntry();
		assert.strictEqual(basename(entry), "turbo-server.js");
		// The build emits `dist/main.js` and `dist/turbo-server.js` side by side,
		// so the directory is whatever holds the caller — here, the source tree.
		// `fileURLToPath` rather than `URL.pathname`, which is percent-encoded and
		// carries a leading slash before a Windows drive letter.
		assert.strictEqual(
			dirname(entry),
			dirname(fileURLToPath(new URL("../../../src/steps/turbo-cache.ts", import.meta.url))),
		);
	});
});

describe("the readiness probe the step hands awaitReady", () => {
	/** Runs the probe the step captured, against a stubbed client. */
	const probeAgainst = (options: { readonly status?: number; readonly refused?: boolean } = {}) =>
		Effect.gen(function* () {
			const probed: Probed = { urls: [] };
			const { recorded } = yield* run({ port: 41999 });
			assert.lengthOf(recorded.probes, 1);
			const answer = yield* (recorded.probes[0] as Effect.Effect<boolean, never, HttpClient.HttpClient>).pipe(
				Effect.provide(httpClientStub(probed, options)),
			);
			return { answer, probed };
		});

	it.effect("asks the server's own status route, on the port it was spawned for", () =>
		Effect.gen(function* () {
			const { probed } = yield* probeAgainst();
			// The one assertion that is genuinely this repo's rather than the kit's:
			// `httpProbe` is handed the right URL. Ruling 73 — the status route
			// answers without auth, which is what makes it usable as a probe.
			assert.deepStrictEqual(probed.urls, ["http://127.0.0.1:41999/v8/artifacts/status"]);
		}),
	);

	it.effect("is true when the server answers its status route", () =>
		Effect.gen(function* () {
			assert.strictEqual((yield* probeAgainst({ status: 200 })).answer, true);
		}),
	);

	it.effect("is false when the server is listening but not serving", () =>
		Effect.gen(function* () {
			// A server that answers unhappily is not ready either — turbo would get
			// the same answer for its own requests.
			assert.strictEqual((yield* probeAgainst({ status: 503 })).answer, false);
		}),
	);

	it.effect("is false rather than failed when the connection is refused", () =>
		Effect.gen(function* () {
			// Ruling 63, now the kit's guarantee and pinned here because this step's
			// degradation depends on it: `awaitReady` propagates probe *failures*, so
			// a child that has not finished binding has to arrive as `false` —
			// otherwise the very first poll aborts the wait it exists to perform.
			const { answer } = yield* probeAgainst({ refused: true });
			assert.strictEqual(answer, false);
		}),
	);
});

describe("startTurboCache: off", () => {
	it.effect("reports no cache and touches nothing when turbo is not detected", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({ turbo: false });

			assert.strictEqual(started.backend, "none");
			assert.strictEqual(Option.isNone(started.port), true);
			assert.strictEqual(Option.isNone(started.state), true);
			assert.deepStrictEqual(recorded.spawns, []);
			assert.deepStrictEqual(recorded.exported, []);
			assert.deepStrictEqual(recorded.saved, []);
		}),
	);

	it.effect("reports no cache when the workflow asked for turbo-cache: off", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({ inputs: inputs({ turboCache: "off" }) });

			assert.strictEqual(started.backend, "none");
			assert.deepStrictEqual(recorded.spawns, []);
			assert.deepStrictEqual(recorded.exported, []);
		}),
	);

	it.effect("still masks every secret the workflow supplied", () =>
		Effect.gen(function* () {
			// Oracle 7 + ruling 78: masking precedes the activation table, because a
			// secret a workflow set is worth redacting whether or not this
			// resolution uses it — and this one uses none of them.
			const { recorded } = yield* run({
				turbo: false,
				inputs: inputs({
					turboToken: Option.some(Redacted.make("vercel-token")),
					turboS3AccessKeyId: Option.some("AKIAEXAMPLE"),
					turboS3SecretAccessKey: Option.some(Redacted.make("s3-secret")),
					turboS3SessionToken: Option.some(Redacted.make("s3-session")),
				}),
			});

			assert.include(recorded.masked, "vercel-token");
			assert.include(recorded.masked, "AKIAEXAMPLE");
			assert.include(recorded.masked, "s3-secret");
			assert.include(recorded.masked, "s3-session");
		}),
	);
});

describe("startTurboCache: passthrough", () => {
	const passthroughInputs = inputs({
		turboToken: Option.some(Redacted.make("vercel-token")),
		turboTeam: Option.some("acme"),
	});

	it.effect("exports the workflow's own credentials and reports the remote backend", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({ inputs: passthroughInputs });

			assert.strictEqual(started.backend, "remote");
			assert.strictEqual(Option.isNone(started.port), true);
			assert.strictEqual(Option.isNone(started.state), true);
			assert.strictEqual(exported(recorded, "TURBO_TOKEN"), "vercel-token");
			assert.strictEqual(exported(recorded, "TURBO_TEAM"), "acme");
		}),
	);

	it.effect("says what the cache resolved to, in the panel's own words", () =>
		Effect.gen(function* () {
			// Oracle 30: the step emitted debug lines only, so a run's log said
			// nothing about the cache the job summary went on to describe. One
			// formatter renders both, so the two cannot disagree.
			const { recorded } = yield* run({ inputs: passthroughInputs });
			assert.include(recorded.logs, "passthrough (Vercel)");
		}),
	);

	it.effect("exports no TURBO_API, leaving turbo pointed at its own default", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: passthroughInputs });
			// Naming an endpoint here would pin a URL this action does not own.
			assert.isUndefined(exported(recorded, "TURBO_API"));
		}),
	);

	it.effect("starts no server", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: passthroughInputs });
			assert.deepStrictEqual(recorded.spawns, []);
			assert.deepStrictEqual(recorded.saved, []);
		}),
	);

	it.effect("beats an S3 bucket configured alongside it", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({
				inputs: inputs({ ...passthroughInputs, turboS3Bucket: Option.some("turbo-cache") }),
			});

			assert.strictEqual(started.backend, "remote");
			assert.deepStrictEqual(recorded.spawns, []);
		}),
	);

	it.effect("warns and falls through to the embedded server on half a credential", () =>
		Effect.gen(function* () {
			// Ruling 77. v1 fell through silently, which looks identical in the log
			// to a workflow that configured no passthrough at all.
			const { started, recorded } = yield* run({
				inputs: inputs({ turboToken: Option.some(Redacted.make("vercel-token")) }),
			});

			assert.strictEqual(started.backend, "github");
			assert.include(recorded.logs.join("\n"), "Both turbo-token and turbo-team are required");
		}),
	);

	it.effect("warns when only the team is set", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({ inputs: inputs({ turboTeam: Option.some("acme") }) });

			assert.strictEqual(started.backend, "github");
			assert.include(recorded.logs.join("\n"), "Both turbo-token and turbo-team are required");
		}),
	);

	it.effect("says nothing when both credentials are absent", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({});
			assert.notInclude(recorded.logs.join("\n"), "Both turbo-token and turbo-team are required");
		}),
	);

	it.effect("says nothing about falling through when the cache is off entirely", () =>
		Effect.gen(function* () {
			// The warning promises an embedded server, so it must not fire on a run
			// that starts none. `turbo-cache: off` and half a credential is a real
			// combination — a workflow disabling the cache does not first go and
			// delete its Vercel token.
			const { started, recorded } = yield* run({
				inputs: inputs({ turboCache: "off", turboToken: Option.some(Redacted.make("vercel-token")) }),
			});

			assert.strictEqual(started.backend, "none");
			assert.deepStrictEqual(recorded.spawns, []);
			assert.notInclude(recorded.logs.join("\n"), "Both turbo-token and turbo-team are required");
		}),
	);

	it.effect("says nothing about falling through when turbo was never detected", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({
				turbo: false,
				inputs: inputs({ turboTeam: Option.some("acme") }),
			});

			assert.strictEqual(started.backend, "none");
			assert.notInclude(recorded.logs.join("\n"), "Both turbo-token and turbo-team are required");
		}),
	);
});

describe("startTurboCache: embedded", () => {
	it.effect("spawns this runtime on the server bundle, logging to the port's file", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({});

			assert.strictEqual(started.backend, "github");
			assert.strictEqual(Option.getOrThrow(started.port), 41230);
			assert.lengthOf(recorded.spawns, 1);
			const spec = recorded.spawns[0] as DetachedSpawnOptions;
			assert.strictEqual(spec.command, process.execPath);
			assert.deepStrictEqual(spec.args, [SERVER_ENTRY]);
			assert.strictEqual(spec.logFile, serverLogPath(41230));
		}),
	);

	it.effect("names the backend and the bound port once the server answers", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({});
			assert.include(recorded.logs, "github · server ready (:41230)");
		}),
	);

	it.effect("configures the worker through the TURBOGHA_ names the worker parses", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: inputs({ turboCachePrefix: "pr-42/" }) });

			const env = (recorded.spawns[0] as DetachedSpawnOptions).env ?? {};
			assert.strictEqual(env.TURBOGHA_PORT, "41230");
			assert.strictEqual(env.TURBOGHA_PREFIX, "pr-42/");
			assert.strictEqual(env.TURBOGHA_BACKEND, "github");
			// No S3 variable belongs in a GitHub-backend spawn.
			assert.deepStrictEqual(
				Object.keys(env).filter((name) => name.startsWith("TURBOGHA_S3_")),
				[],
			);
		}),
	);

	it.effect("authenticates the server with a credential minted for this run alone", () =>
		Effect.gen(function* () {
			// Ruling 76: v1 compiled a constant into the source, so a leaked build
			// disclosed every runner's cache credential.
			const first = yield* run({});
			const second = yield* run({});

			const credentialOf = (recorded: Recorded): string =>
				(recorded.spawns[0] as DetachedSpawnOptions).env?.TURBOGHA_TOKEN ?? "";
			assert.match(credentialOf(first.recorded), /^[0-9a-f-]{36}$/);
			assert.notStrictEqual(credentialOf(first.recorded), "silk-runtime-action");
			assert.notStrictEqual(credentialOf(second.recorded), credentialOf(first.recorded));
		}),
	);

	it.effect("exports the loopback API and both credentials once the server answers", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({});

			assert.strictEqual(exported(recorded, "TURBO_API"), "http://127.0.0.1:41230");
			const credential = (recorded.spawns[0] as DetachedSpawnOptions).env?.TURBOGHA_TOKEN;
			assert.strictEqual(exported(recorded, "TURBO_TOKEN"), credential);
			assert.strictEqual(exported(recorded, "TURBO_TEAM"), credential);
		}),
	);

	it.effect("saves the server's state before waiting for it to be ready", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({});

			// Oracle 34: a child that hangs half-started is still reapable, because
			// the pid was persisted before anything waited on it.
			assert.isBelow(recorded.order.indexOf("save"), recorded.order.indexOf("awaitReady"));
			assert.isBelow(recorded.order.indexOf("spawn"), recorded.order.indexOf("save"));
			assert.lengthOf(recorded.saved, 1);
			const [key, saved] = recorded.saved[0] as readonly [string, TurboServerState];
			assert.strictEqual(key, STATE_KEYS.turboServer);
			assert.strictEqual(saved.pid, 4242);
			assert.strictEqual(saved.port, 41230);
			assert.strictEqual(saved.backend, "github");
			assert.strictEqual(saved.logFile, serverLogPath(41230));
			assert.deepStrictEqual(Option.getOrThrow(started.state), saved);
		}),
	);

	it.effect("exports nothing before the server answers", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({});
			// A `TURBO_API` exported ahead of readiness would point turbo at a port
			// nothing is listening on yet.
			assert.isBelow(recorded.order.indexOf("awaitReady"), recorded.order.indexOf("export:TURBO_API"));
		}),
	);

	it.effect("waits on a probe aimed at the same address it exports", () =>
		Effect.gen(function* () {
			// What this separates: "a probe was passed" from "the *right* probe was
			// passed". A probe aimed at the wrong port, host or route would answer
			// `false` identically to no server at all, and the exported `TURBO_API`
			// would then name an address readiness never actually checked. So the
			// probe's URL and the exported one are asserted against each other.
			//
			// This used to bind a real loopback server on port 0 and run the captured
			// probe against it — necessary when the probe called `fetch` directly and
			// offered no seam, and awkward in this repository's own CI, where the job
			// running this suite is set up by this very action and a real cache server
			// already holds the default port. `httpProbe` goes through `HttpClient`,
			// so the stub does the same job without a listener (effected#240).
			const probed: Probed = { urls: [] };
			const { started, recorded } = yield* run({ port: 41777 });

			assert.strictEqual(Option.getOrThrow(started.port), 41777);
			assert.lengthOf(recorded.probes, 1);
			const up = yield* (recorded.probes[0] as Effect.Effect<boolean, never, HttpClient.HttpClient>).pipe(
				Effect.provide(httpClientStub(probed, { status: 200 })),
			);

			assert.strictEqual(up, true);
			const api = exported(recorded, "TURBO_API");
			assert.strictEqual(api, "http://127.0.0.1:41777");
			// The probe's own URL is that address plus the status route — not a
			// coincidence of two independently-correct constants.
			assert.deepStrictEqual(probed.urls, [`${api}/v8/artifacts/status`]);
		}),
	);
});

describe("startTurboCache: S3 backend", () => {
	const s3Inputs = inputs({
		turboS3Bucket: Option.some("turbo-cache"),
		turboS3Region: Option.some("us-east-1"),
		turboS3Endpoint: Option.some("http://127.0.0.1:9000"),
		turboS3AccessKeyId: Option.some("minioadmin"),
		turboS3SecretAccessKey: Option.some(Redacted.make("miniosecret")),
		turboS3SessionToken: Option.some(Redacted.make("miniosession")),
		turboS3Prefix: Option.some("builds/"),
	});

	it.effect("carries every S3 setting into the worker's environment", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({ inputs: s3Inputs });

			assert.strictEqual(started.backend, "s3");
			const env = (recorded.spawns[0] as DetachedSpawnOptions).env ?? {};
			assert.strictEqual(env.TURBOGHA_BACKEND, "s3");
			assert.strictEqual(env.TURBOGHA_S3_BUCKET, "turbo-cache");
			assert.strictEqual(env.TURBOGHA_S3_REGION, "us-east-1");
			assert.strictEqual(env.TURBOGHA_S3_ENDPOINT, "http://127.0.0.1:9000");
			assert.strictEqual(env.TURBOGHA_S3_ACCESS_KEY_ID, "minioadmin");
			assert.strictEqual(env.TURBOGHA_S3_SECRET_ACCESS_KEY, "miniosecret");
			assert.strictEqual(env.TURBOGHA_S3_SESSION_TOKEN, "miniosession");
			assert.strictEqual(env.TURBOGHA_S3_PREFIX, "builds/");
		}),
	);

	it.effect("masks both S3 secrets before either reaches the child", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: s3Inputs });

			// `Secret.forChildEnv` is the only sanctioned way a `Redacted` becomes a
			// child's environment variable, and it masks the whole set first.
			assert.include(recorded.masked, "miniosecret");
			assert.include(recorded.masked, "miniosession");
			assert.include(recorded.masked, "minioadmin");
		}),
	);

	it.effect("omits the optional settings the workflow left unset", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: inputs({ turboS3Bucket: Option.some("turbo-cache") }) });

			const env = (recorded.spawns[0] as DetachedSpawnOptions).env ?? {};
			assert.strictEqual(env.TURBOGHA_S3_BUCKET, "turbo-cache");
			// The worker reads unset and empty as the same case; an omitted variable
			// is the clearer thing to find in a process listing.
			assert.strictEqual("TURBOGHA_S3_ENDPOINT" in env, false);
			assert.strictEqual("TURBOGHA_S3_SESSION_TOKEN" in env, false);
			assert.strictEqual("TURBOGHA_S3_PREFIX" in env, false);
		}),
	);

	it.effect("records s3 in the state the post phase reads", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: s3Inputs });
			const [, saved] = recorded.saved[0] as readonly [string, TurboServerState];
			assert.strictEqual(saved.backend, "s3");
		}),
	);
});

describe("startTurboCache: degraded", () => {
	it.effect("continues cacheless when the server never answers", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const started = yield* startTurboCache({
				inputs: inputs(),
				turbo: { enabled: true },
				detached: detachedTest(recorded, {
					ready: Effect.fail(new DetachedNotReadyError({})),
				}),
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded)));

			assert.strictEqual(started.backend, "none");
			assert.strictEqual(Option.isNone(started.port), true);
			// Oracle 39 row 4: nothing is exported, because a `TURBO_API` pointing at
			// a dead port turns every later cache operation into a connection error.
			assert.deepStrictEqual(recorded.exported, []);
			// The state was saved anyway, so post can still reap the half-started child.
			assert.lengthOf(recorded.saved, 1);
			assert.strictEqual(Option.isSome(started.state), true);
		}),
	);

	it.effect("names the pid, the address and the log file when readiness fails", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			yield* startTurboCache({
				inputs: inputs(),
				turbo: { enabled: true },
				detached: detachedTest(recorded, {
					pid: 7331,
					ready: Effect.fail(new DetachedNotReadyError({})),
				}),
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded)));

			// Oracle 41 — the log file is the only record a detached child leaves.
			const line = recorded.logs.join("\n");
			assert.include(line, "pid=7331");
			assert.include(line, "127.0.0.1:41230");
			assert.include(line, serverLogPath(41230));
			assert.include(line, "continuing WITHOUT a remote cache");
		}),
	);

	it.effect("warns rather than failing when the child cannot be started", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const started = yield* startTurboCache({
				inputs: inputs(),
				turbo: { enabled: true },
				detached: detachedTest(recorded, {
					spawn: Effect.fail(new DetachedSpawnFailedError({})),
				}),
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded)));

			assert.strictEqual(started.backend, "none");
			assert.strictEqual(Option.isNone(started.state), true);
			assert.deepStrictEqual(recorded.saved, []);
			assert.include(recorded.logs.join("\n"), "Turbo cache setup error");
			assert.include(recorded.logs.join("\n"), "DetachedSpawnFailedError");
		}),
	);

	it.effect("keeps going when the state write fails, so turbo still gets a cache", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({
				save: Effect.fail(new ActionStateError({ reason: "writeFailed", key: STATE_KEYS.turboServer })),
			});

			// The cost is a leaked child, which is strictly better than a run that
			// spawned a working server and then refused to use it.
			assert.strictEqual(started.backend, "github");
			assert.include(recorded.logs.join("\n"), "will not be reaped by the post phase");
		}),
	);

	it.effect("survives a defect anywhere in the spawn path", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const started = yield* startTurboCache({
				inputs: inputs(),
				turbo: { enabled: true },
				detached: DetachedProcess.makeTestOps({
					spawn: () => Effect.die(new Error("openSync EACCES")),
					awaitReady: (() => Effect.void) as DetachedProcessOps["awaitReady"],
				}),
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded)));

			assert.strictEqual(started.backend, "none");
			assert.include(recorded.logs.join("\n"), "Turbo cache setup defect");
			assert.include(recorded.logs.join("\n"), "openSync EACCES");
		}),
	);

	it.effect("survives a defect that is not an Error", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const started = yield* startTurboCache({
				inputs: inputs(),
				turbo: { enabled: true },
				detached: DetachedProcess.makeTestOps({
					spawn: () => Effect.die("boom"),
					awaitReady: (() => Effect.void) as DetachedProcessOps["awaitReady"],
				}),
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded)));

			assert.strictEqual(started.backend, "none");
			assert.include(recorded.logs.join("\n"), "boom");
		}),
	);
});

describe("the state startTurboCache saves", () => {
	/** `ActionState.layer` — the real one — over a state file or `STATE_*` variables. */
	const realState = (env: Record<string, string>): Layer.Layer<ActionState> =>
		ActionState.layer.pipe(
			Layer.provide(ActionEnvironment.layerFrom(env)),
			Layer.provide(ActionOutputs.layerTest()),
			Layer.provide(NodeFileSystem.layer),
		);

	/** What the runner does between phases: republish the state file as `STATE_*`. */
	const republish = (raw: string): Record<string, string> => {
		const lines = raw.split("\n");
		const env: Record<string, string> = {};
		for (let index = 0; index < lines.length; index++) {
			const header = /^(.+?)<<(.+)$/.exec(lines[index] ?? "");
			if (header === null) continue;
			const [, key, delimiter] = header as unknown as [string, string, string];
			const body: string[] = [];
			index++;
			while (index < lines.length && lines[index] !== delimiter) {
				body.push(lines[index] ?? "");
				index++;
			}
			env[`STATE_${key}`] = body.join("\n");
		}
		return env;
	};

	it.effect("survives the runner's text round trip exactly as the step wrote it", () =>
		Effect.gen(function* () {
			// The statefix rule: an in-memory double hands the encoded object
			// straight back and round-trips schemas JSON cannot. This is the *step's*
			// own value — a real pid, a real temp path — through the real service.
			const fs = yield* FileSystem.FileSystem;
			const directory = yield* fs.makeTempDirectoryScoped();
			const file = join(directory, "state.txt");
			yield* fs.writeFileString(file, "");

			const recorded = recorder();
			const started = yield* startTurboCache({
				inputs: inputs({ turboS3Bucket: Option.some("turbo-cache") }),
				turbo: { enabled: true },
				detached: detachedTest(recorded, { pid: 31_337 }),
				serverEntry: SERVER_ENTRY,
			}).pipe(
				Effect.provide(
					Layer.mergeAll(
						ActionOutputs.layerTest({
							exportVariable: () => Effect.void,
							setSecret: () => Effect.void,
						}),
						realState({ GITHUB_STATE: file }),
						Logger.layer([Logger.make(() => {})]),
						httpClientUnused,
					),
				),
			);

			const written = yield* fs.readFileString(file);
			const restored = yield* Effect.flatMap(ActionState, (state) =>
				state.get(STATE_KEYS.turboServer, TurboServerState),
			).pipe(Effect.provide(realState(republish(written))));

			assert.deepStrictEqual(restored, Option.getOrThrow(started.state));
			assert.strictEqual(restored.pid, ProcessId.make(31_337));
			assert.strictEqual(restored.backend, "s3");
			// The encoded form has to be plain JSON, on one line.
			assert.notInclude(written, "_id");
		}).pipe(Effect.provide(NodeFileSystem.layer), Effect.scoped),
	);
});
