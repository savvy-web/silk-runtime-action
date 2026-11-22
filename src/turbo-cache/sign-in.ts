import type { ActionOutputs } from "@effected/github-actions";
import { OidcTokenIssuer, Secret } from "@effected/github-actions";
import type { Duration } from "effect";
import { Data, Effect, Option, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

/**
 * A hosted remote cache this job has signed in to.
 *
 * @remarks
 * `api` is the `turbo-api` input reduced to what turbo is pointed at: scheme,
 * host and any base path, with no trailing slash and no userinfo, query or
 * fragment. `token` is the cache token the service issued, already registered
 * with the runner's log filter, and still `Redacted`: it becomes a string in
 * `Secret` and nowhere else. `expiresAt` is the service's own expiry, in epoch
 * seconds.
 */
export interface HostedCache {
	readonly api: string;
	readonly token: Redacted.Redacted<string>;
	readonly expiresAt: number;
}

/**
 * Raised when a job cannot sign in to a hosted cache.
 *
 * @remarks
 * **Failure posture: degrade-to-warning.** Nothing handles this by failing the
 * job; the step that calls {@link signIn} logs the reason and starts the
 * embedded server instead.
 *
 * A closed `reason` union, since every reason carries the same fields:
 *
 * - `notHttps`: the api is not a parseable `https:` URL. Nothing was minted and
 *   nothing was sent.
 * - `oidc`: the runner issued no token. `detail` is the issuer's own reason
 *   (`unavailable` is a job without `id-token: write`).
 * - `refused`: the service answered outside 2xx. `detail` is the status.
 * - `timeout`: sign-in as a whole took longer than {@link SIGN_IN_TIMEOUT}.
 * - `malformed`: a 2xx answer that is not `{ token, expiresAt }`.
 * - `transport`: the request never got an answer.
 *
 * **There is no `cause`, and `detail` is never free text.** A transport error
 * from core's `HttpClient` holds the request it was sending, bearer token
 * included, and a refusal's body is whatever the far side chose to write. So
 * `detail` is only ever one of the issuer's five reason literals or a status
 * code, both of which this module spells itself, and everything else about a
 * failure is dropped here rather than trusted not to be logged later.
 */
export class SignInError extends Data.TaggedError("SignInError")<{
	readonly reason: "notHttps" | "oidc" | "refused" | "timeout" | "malformed" | "transport";
	readonly detail?: string;
}> {}

/**
 * How long sign-in may take in total: minting the OIDC token, the trade and
 * reading the answer.
 *
 * @remarks
 * One bound over all of it rather than one per request, because what it
 * protects is the job: a cache that hangs must cost a build ten seconds and a
 * warning, not its time limit.
 */
export const SIGN_IN_TIMEOUT: Duration.Input = "10 seconds";

/** The service's sign-in route, relative to the api. */
const SIGN_IN_PATH = "/auth/github";

/** What a successful sign-in answers with. `expiresAt` is epoch seconds. */
const SignInResponse = Schema.Struct({
	token: Schema.NonEmptyString,
	expiresAt: Schema.Number,
});

const decodeSignInResponse = Schema.decodeUnknownEffect(SignInResponse);

/** The two strings sign-in derives from the input: where to send, and who the token is for. */
interface Target {
	/** Scheme, host and base path, with no trailing slash. */
	readonly api: string;
	/** The token's audience: the origin, which is what the service verifies against. */
	readonly audience: string;
}

/**
 * Reads the `turbo-api` input as an https URL, or not at all.
 *
 * @remarks
 * Https or nothing, with no exception for loopback: the request carries a
 * token that proves which repository and ref a job runs for, and the answer is
 * a credential turbo then sends with every artifact.
 *
 * The api is rebuilt from the origin and the path rather than trimmed out of
 * the input, so a userinfo, a query or a fragment in the input reaches neither
 * the request nor the `TURBO_API` every later step echoes.
 */
const targetOf = (input: string): Option.Option<Target> => {
	if (!URL.canParse(input)) return Option.none();
	const url = new URL(input);
	if (url.protocol !== "https:") return Option.none();
	return Option.some({ api: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, audience: url.origin });
};

/**
 * Signs this job in to a hosted remote cache with its GitHub OIDC token.
 *
 * @remarks
 * Mints a token whose audience is the api's origin, trades it at
 * `POST <api>/auth/github`, and returns the cache token the service issued.
 *
 * The cache token is masked **here**, before it is returned, so no caller can
 * hold it unmasked: the mask is registered while the value is still a local of
 * this function. The OIDC token is never unwrapped at all; core's
 * `bearerToken` takes the `Redacted` and the live issuer masked it at issuance.
 *
 * Every failure is a {@link SignInError} carrying a reason and at most a
 * status or an issuer reason. See its remarks for why nothing else survives.
 *
 * `R` is annotated rather than inferred: `OidcTokenIssuer` for the token,
 * `HttpClient` for the trade, `ActionOutputs` for the mask.
 */
export const signIn = (
	input: string,
): Effect.Effect<HostedCache, SignInError, OidcTokenIssuer | HttpClient.HttpClient | ActionOutputs> =>
	Option.match(targetOf(input), {
		onNone: () => Effect.fail(new SignInError({ reason: "notHttps" })),
		onSome: (target) =>
			Effect.gen(function* () {
				const issuer = yield* OidcTokenIssuer;
				const client = yield* HttpClient.HttpClient;

				const identity = yield* issuer
					.token(target.audience)
					.pipe(Effect.mapError((error) => new SignInError({ reason: "oidc", detail: error.reason })));

				const response = yield* client
					.execute(HttpClientRequest.post(`${target.api}${SIGN_IN_PATH}`).pipe(HttpClientRequest.bearerToken(identity)))
					.pipe(Effect.mapError(() => new SignInError({ reason: "transport" })));
				if (response.status < 200 || response.status >= 300) {
					return yield* new SignInError({ reason: "refused", detail: String(response.status) });
				}

				const answer = yield* response.json.pipe(
					Effect.flatMap(decodeSignInResponse),
					Effect.mapError(() => new SignInError({ reason: "malformed" })),
				);
				const token = Redacted.make(answer.token);
				yield* Secret.mask(token);

				const hosted: HostedCache = { api: target.api, token, expiresAt: answer.expiresAt };
				return hosted;
			}).pipe(
				Effect.timeoutOrElse({
					duration: SIGN_IN_TIMEOUT,
					orElse: () => Effect.fail(new SignInError({ reason: "timeout" })),
				}),
			),
	});
