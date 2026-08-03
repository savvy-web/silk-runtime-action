import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import type { DetachedSpawnOptions } from "@effected/github-actions";
import {
	ActionEnvironment,
	ActionOutputs,
	ActionState,
	ActionStateError,
	DetachedProcessError,
	ProcessId,
} from "@effected/github-actions";
import { Effect, FileSystem, Layer, Logger, Option, Redacted } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import type { Inputs } from "../../../src/schema/inputs.js";
import { STATE_KEYS, TurboServerState } from "../../../src/state.js";
import type { DetachedProcessOps, StartedTurboCache, TurboCacheError } from "../../../src/steps/turbo-cache.js";
import { defaultServerEntry, readinessProbe, serverLogPath, startTurboCache } from "../../../src/steps/turbo-cache.js";

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
	readonly probes: Array<Effect.Effect<boolean>>;
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

/** A `DetachedProcess` seam recording its calls and answering as `options` says. */
const detachedTest = (
	recorded: Recorded,
	options: {
		readonly pid?: number;
		readonly spawn?: Effect.Effect<ChildProcessSpawner.ProcessId, DetachedProcessError>;
		readonly ready?: Effect.Effect<void, DetachedProcessError>;
	} = {},
): DetachedProcessOps => ({
	spawn: (spec) =>
		Effect.suspend(() => {
			recorded.spawns.push(spec);
			recorded.order.push("spawn");
			return options.spawn ?? Effect.succeed(ChildProcessSpawner.ProcessId(options.pid ?? 4242));
		}),
	// The probe is captured, never run here: a unit test must not reach the
	// network by default. `readinessProbe` has its own tests against a real
	// server, and one case below runs the *captured* probe against one.
	awaitReady: ((probe: Effect.Effect<boolean, never, never>) =>
		Effect.suspend(() => {
			recorded.probes.push(probe);
			recorded.order.push("awaitReady");
			return options.ready ?? Effect.void;
		})) as unknown as DetachedProcessOps["awaitReady"],
});

/** The services `startTurboCache` needs, all recording into `recorded`. */
const layer = (
	recorded: Recorded,
	options: { readonly save?: Effect.Effect<void, ActionStateError> } = {},
): Layer.Layer<ActionOutputs | ActionState> =>
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
	);

/** Runs the step over recording doubles and hands back both halves. */
const run = (
	args: {
		readonly inputs?: Inputs;
		readonly turbo?: boolean;
		readonly detached?: DetachedProcessOps;
		readonly save?: Effect.Effect<void, ActionStateError>;
	} = {},
): Effect.Effect<{ readonly started: StartedTurboCache; readonly recorded: Recorded }, TurboCacheError> =>
	Effect.suspend(() => {
		const recorded = recorder();
		return startTurboCache({
			inputs: args.inputs ?? inputs(),
			turbo: { enabled: args.turbo ?? true },
			detached: args.detached ?? detachedTest(recorded),
			serverEntry: SERVER_ENTRY,
		}).pipe(
			Effect.map((started) => ({ started, recorded })),
			Effect.provide(layer(recorded, args.save === undefined ? {} : { save: args.save })),
		);
	});

describe("serverLogPath", () => {
	it("derives one path per port, in the temp directory", () => {
		// Three call sites name this file without passing it between them: the
		// spawn, the failed-readiness error and post's teardown log line.
		expect(serverLogPath(41230)).toBe(join(tmpdir(), "turbogha-41230.log"));
		expect(serverLogPath(9080)).not.toBe(serverLogPath(41230));
	});
});

describe("defaultServerEntry", () => {
	it("names the worker bundle beside the bundle it is called from", () => {
		const entry = defaultServerEntry();
		expect(basename(entry)).toBe("turbo-server.js");
		// The build emits `dist/main.js` and `dist/turbo-server.js` side by side,
		// so the directory is whatever holds the caller — here, the source tree.
		// `fileURLToPath` rather than `URL.pathname`, which is percent-encoded and
		// carries a leading slash before a Windows drive letter.
		expect(dirname(entry)).toBe(dirname(fileURLToPath(new URL("../../../src/steps/turbo-cache.ts", import.meta.url))));
	});
});

describe("readinessProbe", () => {
	/** A loopback server answering `/v8/artifacts/status` with `status`. */
	const withServer = <A, E, R>(status: number, use: (port: number) => Effect.Effect<A, E, R>) =>
		Effect.acquireUseRelease(
			Effect.callback<{ readonly port: number; readonly close: () => Promise<void> }>((resume) => {
				const server = createServer((request, response) => {
					response.writeHead(request.url?.startsWith("/v8/artifacts/status") === true ? status : 404);
					response.end();
				});
				server.listen(0, "127.0.0.1", () => {
					const address = server.address();
					resume(
						Effect.succeed({
							port: typeof address === "object" && address !== null ? address.port : 0,
							close: () => new Promise<void>((done) => server.close(() => done())),
						}),
					);
				});
			}),
			(server) => use(server.port),
			(server) => Effect.promise(() => server.close()),
		);

	it.effect("is true when the server answers its status route", () =>
		withServer(200, (port) =>
			Effect.gen(function* () {
				expect(yield* readinessProbe(port)).toBe(true);
			}),
		),
	);

	it.effect("is false when the server is listening but not serving", () =>
		withServer(503, (port) =>
			Effect.gen(function* () {
				// A server that answers unhappily is not ready either — turbo would
				// get the same answer for its own requests.
				expect(yield* readinessProbe(port)).toBe(false);
			}),
		),
	);

	it.effect("is false rather than failed when the connection is refused", () =>
		Effect.gen(function* () {
			// Ruling 63: `awaitReady` propagates probe *failures*, so a child that
			// has not finished binding has to arrive as `false` — otherwise the very
			// first poll aborts the wait it exists to perform.
			const port = yield* withServer(200, (bound) => Effect.succeed(bound));
			const exit = yield* Effect.exit(readinessProbe(port));
			expect(exit._tag).toBe("Success");
			expect(yield* readinessProbe(port)).toBe(false);
		}),
	);
});

describe("startTurboCache: off", () => {
	it.effect("reports no cache and touches nothing when turbo is not detected", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({ turbo: false });

			expect(started.backend).toBe("none");
			expect(Option.isNone(started.port)).toBe(true);
			expect(Option.isNone(started.state)).toBe(true);
			expect(recorded.spawns).toEqual([]);
			expect(recorded.exported).toEqual([]);
			expect(recorded.saved).toEqual([]);
		}),
	);

	it.effect("reports no cache when the workflow asked for turbo-cache: off", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({ inputs: inputs({ turboCache: "off" }) });

			expect(started.backend).toBe("none");
			expect(recorded.spawns).toEqual([]);
			expect(recorded.exported).toEqual([]);
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

			expect(recorded.masked).toContain("vercel-token");
			expect(recorded.masked).toContain("AKIAEXAMPLE");
			expect(recorded.masked).toContain("s3-secret");
			expect(recorded.masked).toContain("s3-session");
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

			expect(started.backend).toBe("remote");
			expect(Option.isNone(started.port)).toBe(true);
			expect(Option.isNone(started.state)).toBe(true);
			expect(exported(recorded, "TURBO_TOKEN")).toBe("vercel-token");
			expect(exported(recorded, "TURBO_TEAM")).toBe("acme");
		}),
	);

	it.effect("says what the cache resolved to, in the panel's own words", () =>
		Effect.gen(function* () {
			// Oracle 30: the step emitted debug lines only, so a run's log said
			// nothing about the cache the job summary went on to describe. One
			// formatter renders both, so the two cannot disagree.
			const { recorded } = yield* run({ inputs: passthroughInputs });
			expect(recorded.logs).toContain("passthrough (Vercel)");
		}),
	);

	it.effect("exports no TURBO_API, leaving turbo pointed at its own default", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: passthroughInputs });
			// Naming an endpoint here would pin a URL this action does not own.
			expect(exported(recorded, "TURBO_API")).toBeUndefined();
		}),
	);

	it.effect("starts no server", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: passthroughInputs });
			expect(recorded.spawns).toEqual([]);
			expect(recorded.saved).toEqual([]);
		}),
	);

	it.effect("beats an S3 bucket configured alongside it", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({
				inputs: inputs({ ...passthroughInputs, turboS3Bucket: Option.some("turbo-cache") }),
			});

			expect(started.backend).toBe("remote");
			expect(recorded.spawns).toEqual([]);
		}),
	);

	it.effect("warns and falls through to the embedded server on half a credential", () =>
		Effect.gen(function* () {
			// Ruling 77. v1 fell through silently, which looks identical in the log
			// to a workflow that configured no passthrough at all.
			const { started, recorded } = yield* run({
				inputs: inputs({ turboToken: Option.some(Redacted.make("vercel-token")) }),
			});

			expect(started.backend).toBe("github");
			expect(recorded.logs.join("\n")).toContain("Both turbo-token and turbo-team are required");
		}),
	);

	it.effect("warns when only the team is set", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({ inputs: inputs({ turboTeam: Option.some("acme") }) });

			expect(started.backend).toBe("github");
			expect(recorded.logs.join("\n")).toContain("Both turbo-token and turbo-team are required");
		}),
	);

	it.effect("says nothing when both credentials are absent", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({});
			expect(recorded.logs.join("\n")).not.toContain("Both turbo-token and turbo-team are required");
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

			expect(started.backend).toBe("none");
			expect(recorded.spawns).toEqual([]);
			expect(recorded.logs.join("\n")).not.toContain("Both turbo-token and turbo-team are required");
		}),
	);

	it.effect("says nothing about falling through when turbo was never detected", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({
				turbo: false,
				inputs: inputs({ turboTeam: Option.some("acme") }),
			});

			expect(started.backend).toBe("none");
			expect(recorded.logs.join("\n")).not.toContain("Both turbo-token and turbo-team are required");
		}),
	);
});

describe("startTurboCache: embedded", () => {
	it.effect("spawns this runtime on the server bundle, logging to the port's file", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({});

			expect(started.backend).toBe("github");
			expect(Option.getOrThrow(started.port)).toBe(41230);
			expect(recorded.spawns).toHaveLength(1);
			const spec = recorded.spawns[0] as DetachedSpawnOptions;
			expect(spec.command).toBe(process.execPath);
			expect(spec.args).toEqual([SERVER_ENTRY]);
			expect(spec.logFile).toBe(serverLogPath(41230));
		}),
	);

	it.effect("names the backend and the bound port once the server answers", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({});
			expect(recorded.logs).toContain("github · server ready (:41230)");
		}),
	);

	it.effect("configures the worker through the TURBOGHA_ names the worker parses", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: inputs({ turboCachePrefix: "pr-42/" }) });

			const env = (recorded.spawns[0] as DetachedSpawnOptions).env ?? {};
			expect(env.TURBOGHA_PORT).toBe("41230");
			expect(env.TURBOGHA_PREFIX).toBe("pr-42/");
			expect(env.TURBOGHA_BACKEND).toBe("github");
			// No S3 variable belongs in a GitHub-backend spawn.
			expect(Object.keys(env).filter((name) => name.startsWith("TURBOGHA_S3_"))).toEqual([]);
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
			expect(credentialOf(first.recorded)).toMatch(/^[0-9a-f-]{36}$/);
			expect(credentialOf(first.recorded)).not.toBe("silk-runtime-action");
			expect(credentialOf(second.recorded)).not.toBe(credentialOf(first.recorded));
		}),
	);

	it.effect("exports the loopback API and both credentials once the server answers", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({});

			expect(exported(recorded, "TURBO_API")).toBe("http://127.0.0.1:41230");
			const credential = (recorded.spawns[0] as DetachedSpawnOptions).env?.TURBOGHA_TOKEN;
			expect(exported(recorded, "TURBO_TOKEN")).toBe(credential);
			expect(exported(recorded, "TURBO_TEAM")).toBe(credential);
		}),
	);

	it.effect("saves the server's state before waiting for it to be ready", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({});

			// Oracle 34: a child that hangs half-started is still reapable, because
			// the pid was persisted before anything waited on it.
			expect(recorded.order.indexOf("save")).toBeLessThan(recorded.order.indexOf("awaitReady"));
			expect(recorded.order.indexOf("spawn")).toBeLessThan(recorded.order.indexOf("save"));
			expect(recorded.saved).toHaveLength(1);
			const [key, saved] = recorded.saved[0] as readonly [string, TurboServerState];
			expect(key).toBe(STATE_KEYS.turboServer);
			expect(saved.pid).toBe(4242);
			expect(saved.port).toBe(41230);
			expect(saved.backend).toBe("github");
			expect(saved.logFile).toBe(serverLogPath(41230));
			expect(Option.getOrThrow(started.state)).toEqual(saved);
		}),
	);

	it.effect("exports nothing before the server answers", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({});
			// A `TURBO_API` exported ahead of readiness would point turbo at a port
			// nothing is listening on yet.
			expect(recorded.order.indexOf("awaitReady")).toBeLessThan(recorded.order.indexOf("export:TURBO_API"));
		}),
	);

	it.effect("waits on a probe aimed at the port it spawned the server on", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({});
			const port = Option.getOrThrow(started.port);
			const probe = recorded.probes[0] as Effect.Effect<boolean>;
			expect(recorded.probes).toHaveLength(1);

			// Running the *captured* probe against a server the test controls is what
			// separates "a probe was passed" from "the right probe was passed". A
			// probe aimed at the wrong port, the wrong host or the wrong route answers
			// `false` against this server exactly as it would against no server, and
			// the exported `TURBO_API` would then name an address readiness never
			// actually checked.
			const answered = yield* Effect.acquireUseRelease(
				Effect.callback<{ readonly hits: Array<string>; readonly close: () => Promise<void> }>((resume) => {
					const hits: Array<string> = [];
					const server = createServer((request, response) => {
						hits.push(request.url ?? "");
						response.writeHead(request.url?.startsWith("/v8/artifacts/status") === true ? 200 : 404);
						response.end();
					});
					// This is the one server in the suite that binds a *fixed* port —
					// it has to, because the assertion is that the probe targets the
					// port the step chose. So it is also the one that can lose the
					// bind, and 41230 sits inside Linux's ephemeral range: a transient
					// *outbound* socket on a busy CI runner can hold it for the length
					// of one request (observed in CI as EADDRINUSE). Those clear in
					// milliseconds, so EADDRINUSE retries briefly before concluding a
					// real server leaked. Anything else — and exhaustion — dies with
					// the cause rather than as an opaque timeout naming nothing.
					let attempts = 0;
					server.on("error", (cause: NodeJS.ErrnoException) => {
						if (cause.code === "EADDRINUSE" && attempts < 10) {
							attempts++;
							setTimeout(() => server.listen(port, "127.0.0.1"), 200);
							return;
						}
						resume(Effect.die(cause));
					});
					server.listen(port, "127.0.0.1", () =>
						resume(Effect.succeed({ hits, close: () => new Promise<void>((done) => server.close(() => done())) })),
					);
				}),
				(serving) => Effect.map(probe, (up) => ({ up, hits: serving.hits })),
				(serving) => Effect.promise(() => serving.close()),
			);

			expect(answered.up).toBe(true);
			expect(answered.hits).toEqual(["/v8/artifacts/status"]);
			// And it is genuinely bound to that address rather than answering true
			// unconditionally: with the server gone, the same probe is false.
			expect(yield* probe).toBe(false);
			expect(exported(recorded, "TURBO_API")).toBe(`http://127.0.0.1:${port}`);
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

			expect(started.backend).toBe("s3");
			const env = (recorded.spawns[0] as DetachedSpawnOptions).env ?? {};
			expect(env.TURBOGHA_BACKEND).toBe("s3");
			expect(env.TURBOGHA_S3_BUCKET).toBe("turbo-cache");
			expect(env.TURBOGHA_S3_REGION).toBe("us-east-1");
			expect(env.TURBOGHA_S3_ENDPOINT).toBe("http://127.0.0.1:9000");
			expect(env.TURBOGHA_S3_ACCESS_KEY_ID).toBe("minioadmin");
			expect(env.TURBOGHA_S3_SECRET_ACCESS_KEY).toBe("miniosecret");
			expect(env.TURBOGHA_S3_SESSION_TOKEN).toBe("miniosession");
			expect(env.TURBOGHA_S3_PREFIX).toBe("builds/");
		}),
	);

	it.effect("masks both S3 secrets before either reaches the child", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: s3Inputs });

			// `Secret.forChildEnv` is the only sanctioned way a `Redacted` becomes a
			// child's environment variable, and it masks the whole set first.
			expect(recorded.masked).toContain("miniosecret");
			expect(recorded.masked).toContain("miniosession");
			expect(recorded.masked).toContain("minioadmin");
		}),
	);

	it.effect("omits the optional settings the workflow left unset", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: inputs({ turboS3Bucket: Option.some("turbo-cache") }) });

			const env = (recorded.spawns[0] as DetachedSpawnOptions).env ?? {};
			expect(env.TURBOGHA_S3_BUCKET).toBe("turbo-cache");
			// The worker reads unset and empty as the same case; an omitted variable
			// is the clearer thing to find in a process listing.
			expect("TURBOGHA_S3_ENDPOINT" in env).toBe(false);
			expect("TURBOGHA_S3_SESSION_TOKEN" in env).toBe(false);
			expect("TURBOGHA_S3_PREFIX" in env).toBe(false);
		}),
	);

	it.effect("records s3 in the state the post phase reads", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: s3Inputs });
			const [, saved] = recorded.saved[0] as readonly [string, TurboServerState];
			expect(saved.backend).toBe("s3");
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
					ready: Effect.fail(new DetachedProcessError({ reason: "notReady" })),
				}),
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded)));

			expect(started.backend).toBe("none");
			expect(Option.isNone(started.port)).toBe(true);
			// Oracle 39 row 4: nothing is exported, because a `TURBO_API` pointing at
			// a dead port turns every later cache operation into a connection error.
			expect(recorded.exported).toEqual([]);
			// The state was saved anyway, so post can still reap the half-started child.
			expect(recorded.saved).toHaveLength(1);
			expect(Option.isSome(started.state)).toBe(true);
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
					ready: Effect.fail(new DetachedProcessError({ reason: "notReady" })),
				}),
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded)));

			// Oracle 41 — the log file is the only record a detached child leaves.
			const line = recorded.logs.join("\n");
			expect(line).toContain("pid=7331");
			expect(line).toContain("127.0.0.1:41230");
			expect(line).toContain(serverLogPath(41230));
			expect(line).toContain("continuing WITHOUT a remote cache");
		}),
	);

	it.effect("warns rather than failing when the child cannot be started", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const started = yield* startTurboCache({
				inputs: inputs(),
				turbo: { enabled: true },
				detached: detachedTest(recorded, {
					spawn: Effect.fail(new DetachedProcessError({ reason: "spawnFailed", path: SERVER_ENTRY })),
				}),
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded)));

			expect(started.backend).toBe("none");
			expect(Option.isNone(started.state)).toBe(true);
			expect(recorded.saved).toEqual([]);
			expect(recorded.logs.join("\n")).toContain("Turbo cache setup error");
			expect(recorded.logs.join("\n")).toContain("spawnFailed");
		}),
	);

	it.effect("keeps going when the state write fails, so turbo still gets a cache", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({
				save: Effect.fail(new ActionStateError({ reason: "writeFailed", key: STATE_KEYS.turboServer })),
			});

			// The cost is a leaked child, which is strictly better than a run that
			// spawned a working server and then refused to use it.
			expect(started.backend).toBe("github");
			expect(recorded.logs.join("\n")).toContain("will not be reaped by the post phase");
		}),
	);

	it.effect("survives a defect anywhere in the spawn path", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const started = yield* startTurboCache({
				inputs: inputs(),
				turbo: { enabled: true },
				detached: {
					spawn: () => Effect.die(new Error("openSync EACCES")),
					awaitReady: (() => Effect.void) as DetachedProcessOps["awaitReady"],
				},
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded)));

			expect(started.backend).toBe("none");
			expect(recorded.logs.join("\n")).toContain("Turbo cache setup defect");
			expect(recorded.logs.join("\n")).toContain("openSync EACCES");
		}),
	);

	it.effect("survives a defect that is not an Error", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const started = yield* startTurboCache({
				inputs: inputs(),
				turbo: { enabled: true },
				detached: {
					spawn: () => Effect.die("boom"),
					awaitReady: (() => Effect.void) as DetachedProcessOps["awaitReady"],
				},
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded)));

			expect(started.backend).toBe("none");
			expect(recorded.logs.join("\n")).toContain("boom");
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
					),
				),
			);

			const written = yield* fs.readFileString(file);
			const restored = yield* Effect.flatMap(ActionState, (state) =>
				state.get(STATE_KEYS.turboServer, TurboServerState),
			).pipe(Effect.provide(realState(republish(written))));

			expect(restored).toEqual(Option.getOrThrow(started.state));
			expect(restored.pid).toBe(ProcessId.make(31_337));
			expect(restored.backend).toBe("s3");
			// The encoded form has to be plain JSON, on one line.
			expect(written).not.toContain("_id");
		}).pipe(Effect.provide(NodeFileSystem.layer), Effect.scoped),
	);
});
