import { assert, describe, it } from "@effect/vitest";
import { ActionOutputs, OidcTokenError, OidcTokenIssuer } from "@effected/github-actions";
import { Cause, Effect, Exit, Fiber, Layer, Redacted } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import type { HostedCache } from "../../../src/turbo-cache/sign-in.js";
import { SIGN_IN_TIMEOUT, SignInError, signIn } from "../../../src/turbo-cache/sign-in.js";

/** The service, as a shared workflow names it. */
const API = "https://cache.savvyweb.systems";

/** The job's OIDC token: the secret a failure must never carry. */
const OIDC_TOKEN = "oidc-header.oidc-payload.oidc-signature";

/** The cache token a successful sign-in answers with. */
const CACHE_TOKEN = "cache-header.cache-payload.cache-signature";

/** A marker a refusal's body carries, so a test can prove the body went nowhere. */
const BODY_MARKER = "body-marker-9f2c";

/** One request the stubbed service saw. */
interface Seen {
	readonly method: string;
	readonly url: string;
	readonly authorization: string | undefined;
}

/** Everything one `signIn` run did, as this suite cares about it. */
interface Recorded {
	/** Audiences the issuer was asked to mint for, in order. */
	readonly audiences: Array<string | undefined>;
	/** Requests the service received, in order. */
	readonly requests: Array<Seen>;
	/** Values registered with the runner's log mask, in order. */
	readonly masked: Array<string>;
}

const recorder = (): Recorded => ({ audiences: [], requests: [], masked: [] });

/** How the stubbed service answers. */
type Answer =
	| { readonly kind: "json"; readonly status: number; readonly body: unknown }
	| { readonly kind: "text"; readonly status: number; readonly body: string }
	| { readonly kind: "refused-connection" }
	| { readonly kind: "never" };

const OK: Answer = { kind: "json", status: 200, body: { token: CACHE_TOKEN, expiresAt: 1_800_000_000 } };

/**
 * The doubles `signIn` runs over.
 *
 * @remarks
 * The issuer is `layerTest` with a recording `token` rather than
 * `OidcTokenIssuer.recording`: that double takes a full claims value, whose
 * type lives in a package this repository does not depend on, and sign-in
 * never reads a claim — the audience is the only thing worth recording.
 */
const layer = (
	recorded: Recorded,
	options: {
		readonly answer?: Answer;
		readonly token?: Effect.Effect<Redacted.Redacted<string>, OidcTokenError>;
	} = {},
): Layer.Layer<OidcTokenIssuer | HttpClient.HttpClient | ActionOutputs> =>
	Layer.mergeAll(
		OidcTokenIssuer.layerTest({
			token: (audience) =>
				Effect.suspend(() => {
					recorded.audiences.push(audience);
					return options.token ?? Effect.succeed(Redacted.make(OIDC_TOKEN));
				}),
		}),
		Layer.succeed(
			HttpClient.HttpClient,
			HttpClient.make((request, url) => {
				recorded.requests.push({
					method: request.method,
					url: url.toString(),
					authorization: request.headers.authorization,
				});
				const answer = options.answer ?? OK;
				switch (answer.kind) {
					case "never":
						return Effect.never;
					case "refused-connection":
						return Effect.fail(
							new HttpClientError.HttpClientError({
								reason: new HttpClientError.TransportError({
									request,
									// What a real transport failure holds: the request, bearer included.
									cause: new Error(`connect ECONNREFUSED while sending Bearer ${OIDC_TOKEN}`),
								}),
							}),
						);
					case "text":
						return Effect.succeed(
							HttpClientResponse.fromWeb(request, new Response(answer.body, { status: answer.status })),
						);
					case "json":
						return Effect.succeed(
							HttpClientResponse.fromWeb(
								request,
								new Response(JSON.stringify(answer.body), {
									status: answer.status,
									headers: { "content-type": "application/json" },
								}),
							),
						);
				}
			}),
		),
		ActionOutputs.layerTest({
			setSecret: (value) => Effect.sync(() => void recorded.masked.push(value)),
		}),
	);

/** Runs `signIn` and hands back its exit beside what the doubles recorded. */
const attempt = (api: string, options: Parameters<typeof layer>[1] = {}) =>
	Effect.suspend(() => {
		const recorded = recorder();
		return signIn(api).pipe(
			Effect.exit,
			Effect.map((exit) => ({ exit, recorded })),
			Effect.provide(layer(recorded, options)),
		);
	});

/** The typed failure of an exit, or a test failure when there is none. */
const failureOf = (exit: Exit.Exit<HostedCache, SignInError>): SignInError => {
	if (Exit.isSuccess(exit)) return assert.fail("expected sign-in to fail, and it succeeded");
	const error = Cause.findErrorOption(exit.cause);
	if (error._tag === "None") return assert.fail(`expected a typed failure, got ${Cause.pretty(exit.cause)}`);
	assert.instanceOf(error.value, SignInError);
	return error.value;
};

/** Every way a failure can be turned into text. */
const rendered = (error: SignInError): string =>
	[JSON.stringify(error), String(error), error.message, error.stack ?? "", JSON.stringify(Object.entries(error))].join(
		"\n",
	);

describe("signIn", () => {
	it.effect("mints for the api's origin and trades it", () =>
		Effect.gen(function* () {
			const { exit, recorded } = yield* attempt(`${API}/`);

			assert.deepStrictEqual(recorded.audiences, [API]);
			assert.deepStrictEqual(recorded.requests, [
				{ method: "POST", url: `${API}/auth/github`, authorization: `Bearer ${OIDC_TOKEN}` },
			]);
			const hosted = Exit.isSuccess(exit) ? exit.value : assert.fail("sign-in failed");
			assert.strictEqual(hosted.api, API);
			assert.strictEqual(hosted.expiresAt, 1_800_000_000);
			assert.isTrue(Redacted.isRedacted(hosted.token));
		}),
	);

	it.effect("keeps a base path, and still mints for the origin alone", () =>
		Effect.gen(function* () {
			// The audience is the origin with no trailing slash, whatever path the
			// service is mounted under: that is the one string the service checks.
			const { exit, recorded } = yield* attempt(`${API}/cache//`);

			assert.deepStrictEqual(recorded.audiences, [API]);
			assert.strictEqual(recorded.requests[0]?.url, `${API}/cache/auth/github`);
			assert.strictEqual(Exit.isSuccess(exit) ? exit.value.api : "", `${API}/cache`);
		}),
	);

	it.effect("never carries a userinfo, query or fragment into the exported api", () =>
		Effect.gen(function* () {
			const { exit, recorded } = yield* attempt("https://user:hunter2@cache.savvyweb.systems/?key=1#frag");

			assert.strictEqual(Exit.isSuccess(exit) ? exit.value.api : "", API);
			assert.deepStrictEqual(recorded.audiences, [API]);
			assert.strictEqual(recorded.requests[0]?.url, `${API}/auth/github`);
		}),
	);

	it.effect("masks the cache token before returning it", () =>
		Effect.gen(function* () {
			const { exit, recorded } = yield* attempt(API);

			assert.isTrue(Exit.isSuccess(exit));
			assert.include(recorded.masked, CACHE_TOKEN);
		}),
	);

	it.effect("an api that is not https fails notHttps and sends nothing", () =>
		Effect.gen(function* () {
			for (const api of ["http://cache.savvyweb.systems", "not a url", "", "ftp://cache.savvyweb.systems", "//host"]) {
				const { exit, recorded } = yield* attempt(api);

				const error = failureOf(exit);
				assert.strictEqual(error.reason, "notHttps", api);
				assert.isUndefined(error.detail);
				// No token is minted for it and no request reaches it.
				assert.deepStrictEqual(recorded.audiences, [], api);
				assert.deepStrictEqual(recorded.requests, [], api);
			}
		}),
	);

	it.effect("no OIDC service fails oidc with the issuer's reason", () =>
		Effect.gen(function* () {
			for (const reason of ["unavailable", "requestFailed", "malformedResponse"] as const) {
				const { exit, recorded } = yield* attempt(API, {
					token: Effect.fail(new OidcTokenError({ reason, detail: `the runner said ${BODY_MARKER}`, status: 503 })),
				});

				const error = failureOf(exit);
				assert.strictEqual(error.reason, "oidc");
				assert.strictEqual(error.detail, reason);
				assert.deepStrictEqual(recorded.requests, []);
				assert.notInclude(rendered(error), BODY_MARKER);
			}
		}),
	);

	it.effect("401, 403 and 500 fail refused with the status", () =>
		Effect.gen(function* () {
			for (const status of [401, 403, 500, 302, 404]) {
				const { exit, recorded } = yield* attempt(API, {
					answer: { kind: "json", status, body: { code: "unauthorized", message: BODY_MARKER } },
				});

				const error = failureOf(exit);
				assert.strictEqual(error.reason, "refused");
				assert.strictEqual(error.detail, String(status));
				assert.deepStrictEqual(recorded.masked, []);
			}
		}),
	);

	it.effect("a refusal that happens to carry a token is still a refusal", () =>
		Effect.gen(function* () {
			const { exit } = yield* attempt(API, {
				answer: { kind: "json", status: 500, body: { token: CACHE_TOKEN, expiresAt: 1 } },
			});
			assert.strictEqual(failureOf(exit).reason, "refused");
		}),
	);

	it.effect("a body without a string token or a numeric expiresAt fails malformed", () =>
		Effect.gen(function* () {
			const bodies: ReadonlyArray<Answer> = [
				{ kind: "json", status: 200, body: { expiresAt: 1_800_000_000 } },
				{ kind: "json", status: 200, body: { token: 42, expiresAt: 1_800_000_000 } },
				{ kind: "json", status: 200, body: { token: "", expiresAt: 1_800_000_000 } },
				{ kind: "json", status: 200, body: { token: CACHE_TOKEN } },
				{ kind: "json", status: 200, body: { token: CACHE_TOKEN, expiresAt: "soon" } },
				{ kind: "json", status: 200, body: [CACHE_TOKEN] },
				{ kind: "json", status: 200, body: null },
				{ kind: "text", status: 200, body: `<html>${BODY_MARKER}</html>` },
				{ kind: "text", status: 200, body: "" },
			];
			for (const answer of bodies) {
				const { exit } = yield* attempt(API, { answer });

				const error = failureOf(exit);
				assert.strictEqual(error.reason, "malformed", JSON.stringify(answer));
				assert.isUndefined(error.detail);
			}
		}),
	);

	it.effect("a service that never answers fails timeout after 10 seconds", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const fiber = yield* signIn(API).pipe(
				Effect.exit,
				Effect.provide(layer(recorded, { answer: { kind: "never" } })),
				Effect.forkChild,
			);

			// One millisecond short of the bound, sign-in is still waiting.
			yield* TestClock.adjust("9999 millis");
			assert.isUndefined(fiber.pollUnsafe());

			yield* TestClock.adjust("1 millis");
			const error = failureOf(yield* Fiber.join(fiber));
			assert.strictEqual(error.reason, "timeout");
			assert.isUndefined(error.detail);
			assert.strictEqual(SIGN_IN_TIMEOUT, "10 seconds");
		}),
	);

	it.effect("an OIDC service that never answers is inside the same 10 seconds", () =>
		Effect.gen(function* () {
			// The bound is on sign-in as a whole, not on the trade alone: a runner
			// whose token service hangs must not stall the job either.
			const recorded = recorder();
			const fiber = yield* signIn(API).pipe(
				Effect.exit,
				Effect.provide(layer(recorded, { token: Effect.never })),
				Effect.forkChild,
			);

			yield* TestClock.adjust("10 seconds");
			assert.strictEqual(failureOf(yield* Fiber.join(fiber)).reason, "timeout");
			assert.deepStrictEqual(recorded.requests, []);
		}),
	);

	it.effect("a connection failure fails transport", () =>
		Effect.gen(function* () {
			const { exit } = yield* attempt(API, { answer: { kind: "refused-connection" } });

			const error = failureOf(exit);
			assert.strictEqual(error.reason, "transport");
			assert.isUndefined(error.detail);
		}),
	);

	it.effect("no failure carries the OIDC token or the response body", () =>
		Effect.gen(function* () {
			const failures: ReadonlyArray<Parameters<typeof layer>[1]> = [
				{ answer: { kind: "refused-connection" } },
				{ answer: { kind: "json", status: 403, body: { code: "forbidden", message: BODY_MARKER } } },
				{ answer: { kind: "text", status: 200, body: `${BODY_MARKER} ${CACHE_TOKEN}` } },
				{ answer: { kind: "json", status: 200, body: { token: 7, expiresAt: BODY_MARKER } } },
				{
					token: Effect.fail(
						new OidcTokenError({ reason: "requestFailed", detail: BODY_MARKER, cause: new Error(OIDC_TOKEN) }),
					),
				},
			];
			for (const options of failures) {
				const { exit } = yield* attempt(API, options);

				const text = rendered(failureOf(exit));
				assert.notInclude(text, OIDC_TOKEN);
				assert.notInclude(text, "oidc-payload");
				assert.notInclude(text, BODY_MARKER);
				assert.notInclude(text, CACHE_TOKEN);
				// Nothing structural rides along either: a reason, perhaps a detail.
				assert.notProperty(failureOf(exit), "cause");
			}
		}),
	);

	it.effect("a failure's detail is only ever an issuer reason or a status", () =>
		Effect.gen(function* () {
			const refused = failureOf((yield* attempt(API, { answer: { kind: "json", status: 401, body: {} } })).exit);
			assert.match(refused.detail ?? "", /^\d{3}$/);
			const oidc = failureOf(
				(yield* attempt(API, { token: Effect.fail(new OidcTokenError({ reason: "unavailable" })) })).exit,
			);
			assert.match(oidc.detail ?? "", /^[A-Za-z]+$/);
		}),
	);
});
