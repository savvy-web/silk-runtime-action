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
	OidcTokenError,
	OidcTokenIssuer,
	ProcessId,
} from "@effected/github-actions";
import { Effect, Fiber, FileSystem, Layer, Logger, Option, Redacted } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

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
	turboApi: Option.none(),
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
	/** The subset of `logs` emitted at warning level. */
	readonly warnings: Array<string>;
	/** Audiences an OIDC token was minted for, in order. */
	readonly audiences: Array<string | undefined>;
	/** Requests the step itself issued (sign-in), as `METHOD url`, in order. */
	readonly requests: Array<string>;
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
	warnings: [],
	audiences: [],
	requests: [],
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

/** The hosted service a shared workflow names. */
const HOSTED_API = "https://cache.savvyweb.systems";

/** The job's OIDC token, which nothing this step logs or returns may contain. */
const OIDC_TOKEN = "oidc-header.oidc-payload.oidc-signature";

/** The cache token a successful sign-in answers with. */
const CACHE_TOKEN = "cache-header.cache-payload.cache-signature";

/** A marker a refusal's body carries, so a test can prove the body went nowhere. */
const BODY_MARKER = "body-marker-4c1e";

/**
 * How the hosted service answers the step's sign-in.
 *
 * @remarks
 * Absent, the step is expected to issue no request at all and the client dies
 * if it does: the embedded and passthrough paths never run the readiness probe
 * themselves (they hand it to `awaitReady`, which this suite's seam captures
 * without running), and `off` sends nothing by definition.
 */
type HostedAnswer =
	| { readonly kind: "ok" }
	| { readonly kind: "status"; readonly status: number }
	| { readonly kind: "malformed" }
	| { readonly kind: "refused-connection" }
	| { readonly kind: "never" };

/** What a hosted test wires: the issuer's answer and the service's. */
interface HostedDoubles {
	readonly token?: Effect.Effect<Redacted.Redacted<string>, OidcTokenError>;
	readonly answer?: HostedAnswer;
}

const signInClient = (recorded: Recorded, answer: HostedAnswer | undefined): Layer.Layer<HttpClient.HttpClient> =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request, url) => {
			recorded.requests.push(`${request.method} ${url.toString()}`);
			recorded.order.push("request");
			if (answer === undefined) {
				return Effect.die(new Error("the step issued an HTTP request; only the captured probe should"));
			}
			const respond = (status: number, body: unknown) =>
				Effect.succeed(HttpClientResponse.fromWeb(request, new Response(JSON.stringify(body), { status })));
			switch (answer.kind) {
				case "ok":
					return respond(200, { token: CACHE_TOKEN, expiresAt: 1_800_000_000 });
				case "status":
					return respond(answer.status, { code: "refused", message: BODY_MARKER });
				case "malformed":
					return respond(200, { message: BODY_MARKER });
				case "never":
					return Effect.never;
				case "refused-connection":
					return Effect.fail(
						new HttpClientError.HttpClientError({
							reason: new HttpClientError.TransportError({
								request,
								cause: new Error(`connect ECONNREFUSED while sending Bearer ${OIDC_TOKEN}`),
							}),
						}),
					);
			}
		}),
	);

/** The services `startTurboCache` needs, all recording into `recorded`. */
const layer = (
	recorded: Recorded,
	options: { readonly save?: Effect.Effect<void, ActionStateError>; readonly hosted?: HostedDoubles } = {},
): Layer.Layer<ActionOutputs | ActionState | HttpClient.HttpClient | OidcTokenIssuer> =>
	Layer.mergeAll(
		ActionOutputs.layerTest({
			exportVariable: (name, value) =>
				Effect.sync(() => {
					recorded.exported.push([name, value]);
					recorded.order.push(`export:${name}`);
				}),
			setSecret: (value) =>
				Effect.sync(() => {
					recorded.masked.push(value);
					recorded.order.push(`mask:${value}`);
				}),
		}),
		ActionState.layerTest({
			save: ((key: string, value: TurboServerState) =>
				Effect.suspend(() => {
					recorded.saved.push([key, value]);
					recorded.order.push("save");
					return options.save ?? Effect.void;
				})) as ActionState["Service"]["save"],
		}),
		Logger.layer([
			Logger.make(({ message, logLevel }) => {
				recorded.logs.push(String(message));
				if (logLevel === "Warn") recorded.warnings.push(String(message));
			}),
		]),
		signInClient(recorded, options.hosted?.answer),
		// With no hosted doubles the issuer is the kit's bare double, whose `token`
		// dies naming itself: a run that was not meant to sign in must not mint.
		options.hosted === undefined
			? OidcTokenIssuer.layerTest()
			: OidcTokenIssuer.layerTest({
					token: (audience) =>
						Effect.suspend(() => {
							recorded.audiences.push(audience);
							recorded.order.push("mint");
							return options.hosted?.token ?? Effect.succeed(Redacted.make(OIDC_TOKEN));
						}),
				}),
	);

/** Runs the step over recording doubles and hands back both halves. */
const run = (
	args: {
		readonly inputs?: Inputs;
		readonly turbo?: boolean;
		readonly detached?: DetachedProcessOps;
		readonly save?: Effect.Effect<void, ActionStateError>;
		readonly port?: number;
		readonly hosted?: HostedDoubles;
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
			Effect.provide(
				layer(recorded, {
					...(args.save === undefined ? {} : { save: args.save }),
					...(args.hosted === undefined ? {} : { hosted: args.hosted }),
				}),
			),
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
			// Oracle 7: masking precedes the activation table, because a secret a
			// workflow set is worth redacting whether or not this resolution uses it
			// — and this one uses none of them.
			const { recorded } = yield* run({
				turbo: false,
				inputs: inputs({ turboToken: Option.some(Redacted.make("vercel-token")) }),
			});

			assert.include(recorded.masked, "vercel-token");
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

	it.effect("reports the same two variables it exported, for a child of this run", () =>
		Effect.gen(function* () {
			const { started } = yield* run({ inputs: passthroughInputs });
			// What the dependency install is handed: `exportVariable` configures later
			// workflow steps, never a process this one spawns.
			assert.deepStrictEqual(started.environment, { TURBO_TOKEN: "vercel-token", TURBO_TEAM: "acme" });
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

describe("startTurboCache: hosted", () => {
	const hostedInputs = (overrides: Partial<Inputs> = {}): Inputs =>
		inputs({ turboApi: Option.some(`${HOSTED_API}/`), ...overrides });

	it.effect("hosted: exports the three variables and starts no server", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({ inputs: hostedInputs(), hosted: { answer: { kind: "ok" } } });

			assert.deepStrictEqual(recorded.exported, [
				["TURBO_API", HOSTED_API],
				["TURBO_TOKEN", CACHE_TOKEN],
				["TURBO_TEAM", "silk"],
			]);
			assert.deepStrictEqual(recorded.spawns, []);
			assert.deepStrictEqual(recorded.saved, []);
			assert.strictEqual(started.backend, "hosted");
			assert.strictEqual(Option.isNone(started.port), true);
			assert.strictEqual(Option.isNone(started.state), true);
			assert.deepStrictEqual(started.host, Option.some("cache.savvyweb.systems"));
			// One token, minted for the origin; one request, the trade.
			assert.deepStrictEqual(recorded.audiences, [HOSTED_API]);
			assert.deepStrictEqual(recorded.requests, [`POST ${HOSTED_API}/auth/github`]);
		}),
	);

	it.effect("hosted: the same variables are handed to the install child", () =>
		Effect.gen(function* () {
			const { started } = yield* run({ inputs: hostedInputs(), hosted: { answer: { kind: "ok" } } });
			assert.deepStrictEqual(started.environment, {
				TURBO_API: HOSTED_API,
				TURBO_TOKEN: CACHE_TOKEN,
				TURBO_TEAM: "silk",
			});
		}),
	);

	it.effect("hosted: the cache token is masked before anything is exported", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: hostedInputs(), hosted: { answer: { kind: "ok" } } });

			const masked = recorded.order.indexOf(`mask:${CACHE_TOKEN}`);
			assert.isAtLeast(masked, 0);
			for (const name of ["TURBO_API", "TURBO_TOKEN", "TURBO_TEAM"]) {
				assert.isBelow(masked, recorded.order.indexOf(`export:${name}`), name);
			}
			// And after the trade it came from: there is no earlier point to mask at.
			assert.isBelow(recorded.order.indexOf("request"), masked);
		}),
	);

	it.effect("hosted: says where the cache is, in the panel's own words", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: hostedInputs(), hosted: { answer: { kind: "ok" } } });
			assert.include(recorded.logs, "hosted (cache.savvyweb.systems)");
			assert.deepStrictEqual(recorded.warnings, []);
		}),
	);

	it.effect("hosted: never logs the cache token or the OIDC token on success", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({ inputs: hostedInputs(), hosted: { answer: { kind: "ok" } } });
			const text = recorded.logs.join("\n");
			assert.notInclude(text, CACHE_TOKEN);
			assert.notInclude(text, OIDC_TOKEN);
		}),
	);

	/** Every way sign-in fails, with the words its warning has to carry. */
	const failures: ReadonlyArray<{
		readonly name: string;
		readonly inputs: Inputs;
		readonly hosted: HostedDoubles;
		readonly words: ReadonlyArray<string>;
		/** Requests the step is allowed to have issued before giving up. */
		readonly requests: number;
	}> = [
		{
			name: "notHttps",
			inputs: inputs({ turboApi: Option.some("http://cache.savvyweb.systems") }),
			hosted: { answer: { kind: "ok" } },
			words: ["notHttps"],
			requests: 0,
		},
		{
			name: "notHttps (not a URL)",
			inputs: inputs({ turboApi: Option.some("cache.savvyweb.systems") }),
			hosted: { answer: { kind: "ok" } },
			words: ["notHttps"],
			requests: 0,
		},
		{
			name: "oidc",
			inputs: hostedInputs(),
			hosted: { token: Effect.fail(new OidcTokenError({ reason: "unavailable", detail: BODY_MARKER })) },
			words: ["oidc", "unavailable"],
			requests: 0,
		},
		{
			name: "refused",
			inputs: hostedInputs(),
			hosted: { answer: { kind: "status", status: 403 } },
			words: ["refused", "403"],
			requests: 1,
		},
		{
			name: "malformed",
			inputs: hostedInputs(),
			hosted: { answer: { kind: "malformed" } },
			words: ["malformed"],
			requests: 1,
		},
		{
			name: "transport",
			inputs: hostedInputs(),
			hosted: { answer: { kind: "refused-connection" } },
			words: ["transport"],
			requests: 1,
		},
	];

	for (const failure of failures) {
		it.effect(
			`hosted: sign-in fails (${failure.name}) → one warning naming the reason, then the embedded server as before`,
			() =>
				Effect.gen(function* () {
					const { started, recorded } = yield* run({ inputs: failure.inputs, hosted: failure.hosted });

					assert.lengthOf(recorded.warnings, 1);
					for (const word of failure.words) assert.include(recorded.warnings[0], word);
					assert.include(recorded.warnings[0], "embedded cache server");
					assert.lengthOf(recorded.requests, failure.requests);

					// The embedded server, exactly as a run with no turbo-api gets it.
					assert.lengthOf(recorded.spawns, 1);
					assert.strictEqual(started.backend, "github");
					assert.strictEqual(Option.getOrThrow(started.port), 41230);
					assert.strictEqual(Option.isNone(started.host), true);
					assert.strictEqual(exported(recorded, "TURBO_API"), "http://127.0.0.1:41230");
					const credential = (recorded.spawns[0] as DetachedSpawnOptions).env?.TURBOGHA_TOKEN;
					assert.strictEqual(exported(recorded, "TURBO_TOKEN"), credential);
					assert.strictEqual(exported(recorded, "TURBO_TEAM"), credential);
					assert.lengthOf(recorded.saved, 1);
					assert.include(recorded.logs, "github · server ready (:41230)");
				}),
		);
	}

	it.effect("hosted: sign-in fails (timeout) → one warning naming the reason, then the embedded server as before", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const fiber = yield* startTurboCache({
				inputs: hostedInputs(),
				turbo: { enabled: true },
				detached: detachedTest(recorded),
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded, { hosted: { answer: { kind: "never" } } })), Effect.forkChild);

			// A hung service holds the step, and nothing is started, for the bound…
			yield* TestClock.adjust("9999 millis");
			assert.isUndefined(fiber.pollUnsafe());
			assert.deepStrictEqual(recorded.spawns, []);

			// …and not a millisecond longer.
			yield* TestClock.adjust("1 millis");
			const started = yield* Fiber.join(fiber);
			assert.lengthOf(recorded.warnings, 1);
			assert.include(recorded.warnings[0], "timeout");
			assert.lengthOf(recorded.spawns, 1);
			assert.strictEqual(started.backend, "github");
		}),
	);

	it.effect("hosted: the warning carries no token", () =>
		Effect.gen(function* () {
			for (const failure of failures) {
				const { recorded } = yield* run({ inputs: failure.inputs, hosted: failure.hosted });

				const text = recorded.logs.join("\n");
				assert.notInclude(text, OIDC_TOKEN, failure.name);
				assert.notInclude(text, "oidc-payload", failure.name);
				assert.notInclude(text, CACHE_TOKEN, failure.name);
				// Nor what the far side wrote, nor the request it was written to.
				assert.notInclude(text, BODY_MARKER, failure.name);
				assert.notInclude(text, "Bearer", failure.name);
				assert.notInclude(text, "ECONNREFUSED", failure.name);
			}
		}),
	);

	it.effect("hosted: the warning does not repeat the turbo-api input", () =>
		Effect.gen(function* () {
			// The input is the caller's string, and a URL can carry a userinfo.
			const { recorded } = yield* run({
				inputs: inputs({ turboApi: Option.some("http://user:hunter2@cache.savvyweb.systems") }),
				hosted: { answer: { kind: "ok" } },
			});
			assert.lengthOf(recorded.warnings, 1);
			assert.notInclude(recorded.logs.join("\n"), "hunter2");
		}),
	);

	it.effect("hosted: a defect while signing in still ends in the embedded server", () =>
		Effect.gen(function* () {
			// The bare issuer double dies when asked for a token. Whatever a defect
			// says is not this step's to print, so the warning names it as a defect
			// and nothing more.
			const recorded = recorder();
			const started = yield* startTurboCache({
				inputs: hostedInputs(),
				turbo: { enabled: true },
				detached: detachedTest(recorded),
				serverEntry: SERVER_ENTRY,
			}).pipe(Effect.provide(layer(recorded)));

			assert.strictEqual(started.backend, "github");
			assert.lengthOf(recorded.spawns, 1);
			assert.lengthOf(recorded.warnings, 1);
			assert.include(recorded.warnings[0], "defect");
			assert.notInclude(recorded.warnings[0], "OidcTokenIssuer");
		}),
	);

	it.effect("off with turbo-api set: nothing minted, fetched, exported or started", () =>
		Effect.gen(function* () {
			for (const args of [
				{ inputs: hostedInputs({ turboCache: "off" }), turbo: true },
				{ inputs: hostedInputs(), turbo: false },
			]) {
				const { started, recorded } = yield* run({ ...args, hosted: { answer: { kind: "ok" } } });

				assert.deepStrictEqual(recorded.audiences, []);
				assert.deepStrictEqual(recorded.requests, []);
				assert.deepStrictEqual(recorded.exported, []);
				assert.deepStrictEqual(recorded.spawns, []);
				assert.deepStrictEqual(recorded.saved, []);
				assert.deepStrictEqual(recorded.masked, []);
				assert.deepStrictEqual(recorded.warnings, []);
				assert.strictEqual(started.backend, "none");
				assert.deepStrictEqual(started.environment, {});
			}
		}),
	);

	it.effect("hosted: wins over a Vercel token and team, whose token is still masked", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({
				inputs: hostedInputs({
					turboToken: Option.some(Redacted.make("vercel-token")),
					turboTeam: Option.some("acme"),
				}),
				hosted: { answer: { kind: "ok" } },
			});

			assert.strictEqual(started.backend, "hosted");
			assert.strictEqual(exported(recorded, "TURBO_TOKEN"), CACHE_TOKEN);
			assert.strictEqual(exported(recorded, "TURBO_TEAM"), "silk");
			assert.include(recorded.masked, "vercel-token");
		}),
	);

	it.effect("hosted: says nothing about half a Vercel credential", () =>
		Effect.gen(function* () {
			// That warning promises the embedded server because Vercel was meant and
			// missed. A run that named a hosted service did not mean Vercel.
			for (const hosted of [{ answer: { kind: "ok" } }, { answer: { kind: "status", status: 500 } }] as const) {
				const { recorded } = yield* run({ inputs: hostedInputs({ turboTeam: Option.some("acme") }), hosted });
				assert.notInclude(recorded.logs.join("\n"), "Both turbo-token and turbo-team are required");
			}
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
			// Those four and nothing else: no setting rides along that the worker
			// does not parse.
			assert.deepStrictEqual(Object.keys(env).sort(), [
				"TURBOGHA_BACKEND",
				"TURBOGHA_PORT",
				"TURBOGHA_PREFIX",
				"TURBOGHA_TOKEN",
			]);
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

	it.effect("masks the embedded server's credential before it is exported", () =>
		Effect.gen(function* () {
			const { recorded } = yield* run({});

			// The value is per-run and loopback-only, but every later step echoes
			// TURBO_TOKEN in its env block, so it is masked like any other secret.
			const credential = (recorded.spawns[0] as DetachedSpawnOptions).env?.TURBOGHA_TOKEN ?? "";
			assert.include(recorded.masked, credential);
		}),
	);

	it.effect("reports exactly the variables it exported, for a child of this run", () =>
		Effect.gen(function* () {
			const { started, recorded } = yield* run({});

			assert.strictEqual(started.environment.TURBO_API, "http://127.0.0.1:41230");
			assert.strictEqual(started.environment.TURBO_TOKEN, exported(recorded, "TURBO_TOKEN"));
			assert.strictEqual(started.environment.TURBO_TEAM, exported(recorded, "TURBO_TEAM"));
			assert.lengthOf(Object.keys(started.environment), recorded.exported.length);
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
			// And nothing is handed to the install's children either, for the same reason.
			assert.deepStrictEqual(started.environment, {});
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
				inputs: inputs(),
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
						signInClient(recorder(), undefined),
						OidcTokenIssuer.layerTest(),
					),
				),
			);

			const written = yield* fs.readFileString(file);
			const restored = yield* Effect.flatMap(ActionState, (state) =>
				state.get(STATE_KEYS.turboServer, TurboServerState),
			).pipe(Effect.provide(realState(republish(written))));

			assert.deepStrictEqual(restored, Option.getOrThrow(started.state));
			assert.strictEqual(restored.pid, ProcessId.make(31_337));
			assert.strictEqual(restored.backend, "github");
			// The encoded form has to be plain JSON, on one line.
			assert.notInclude(written, "_id");
		}).pipe(Effect.provide(NodeFileSystem.layer), Effect.scoped),
	);
});
