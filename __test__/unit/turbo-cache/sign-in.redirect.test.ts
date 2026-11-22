import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { assert, describe, it } from "@effect/vitest";
import { ActionOutputs, OidcTokenIssuer } from "@effected/github-actions";
import { Cause, Effect, Exit, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { SignInError, signInAt } from "../../../src/turbo-cache/sign-in.js";

/**
 * Sign-in over the real `FetchHttpClient`, against real loopback listeners.
 *
 * @remarks
 * The stubbed client in `sign-in.test.ts` answers whatever status it is told
 * to, so it cannot say what the runtime's client does with a redirect: fetch
 * follows one by default, and would hand sign-in the *target's* answer. These
 * cases run the request through the client `Action.run` composes.
 *
 * The seam is `signInAt`, the half of sign-in below the https check: a
 * loopback listener speaks plain http, and `signIn` refuses that before it
 * sends anything. Everything from the mint to the mask is the same code.
 *
 * `it.live` because the sockets are real and the 10-second bound should run on
 * the real clock.
 */

const OIDC_TOKEN = "oidc-header.oidc-payload.oidc-signature";
const CACHE_TOKEN = "cache-header.cache-payload.cache-signature";

/** One request a listener received. */
interface Hit {
	readonly method: string;
	readonly url: string;
	readonly authorization: string | undefined;
}

/** A loopback listener, closed with the scope, recording what reaches it. */
const listen = (handler: (request: IncomingMessage, response: ServerResponse) => void) =>
	Effect.acquireRelease(
		Effect.callback<{ readonly origin: string; readonly hits: Array<Hit> }>((resume) => {
			const hits: Array<Hit> = [];
			const server: Server = createServer((request, response) => {
				hits.push({
					method: request.method ?? "",
					url: request.url ?? "",
					authorization: request.headers.authorization,
				});
				request.resume();
				handler(request, response);
			});
			server.listen(0, "127.0.0.1", () => {
				const { port } = server.address() as AddressInfo;
				resume(Effect.succeed({ origin: `http://127.0.0.1:${port}`, hits, server }));
			});
		}),
		(listener) =>
			Effect.callback<void>((resume) => {
				const { server } = listener as unknown as { readonly server: Server };
				server.closeAllConnections();
				server.close(() => resume(Effect.void));
			}),
	);

const answerToken = (_request: IncomingMessage, response: ServerResponse): void => {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ token: CACHE_TOKEN, expiresAt: 1_800_000_000 }));
};

const services = (masked: Array<string>): Layer.Layer<OidcTokenIssuer | ActionOutputs> =>
	Layer.mergeAll(
		OidcTokenIssuer.layerTest({ token: () => Effect.succeed(Redacted.make(OIDC_TOKEN)) }),
		ActionOutputs.layerTest({ setSecret: (value) => Effect.sync(() => void masked.push(value)) }),
	);

describe("signInAt over the real fetch client", () => {
	it.live("a 200 signs in end to end", () =>
		Effect.gen(function* () {
			const service = yield* listen(answerToken);
			const masked: Array<string> = [];

			const hosted = yield* signInAt({ api: service.origin, audience: service.origin }).pipe(
				Effect.provide(FetchHttpClient.layer),
				Effect.provide(services(masked)),
			);

			assert.strictEqual(hosted.api, service.origin);
			assert.strictEqual(hosted.expiresAt, 1_800_000_000);
			assert.deepStrictEqual(masked, [CACHE_TOKEN]);
			assert.deepStrictEqual(service.hits, [
				{ method: "POST", url: "/auth/github", authorization: `Bearer ${OIDC_TOKEN}` },
			]);
		}).pipe(Effect.scoped),
	);

	for (const status of [301, 302, 303, 307, 308]) {
		it.live(`a ${status} is refused, and its target is never asked`, () =>
			Effect.gen(function* () {
				// The target would answer a perfectly valid sign-in. Followed, its
				// token would be exported while `TURBO_API` still named the first host.
				const target = yield* listen(answerToken);
				const service = yield* listen((_request, response) => {
					response.writeHead(status, { location: `${target.origin}/auth/github` });
					response.end();
				});
				const masked: Array<string> = [];

				const exit = yield* signInAt({ api: service.origin, audience: service.origin }).pipe(
					Effect.exit,
					Effect.provide(FetchHttpClient.layer),
					Effect.provide(services(masked)),
				);

				const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
				if (error === undefined || error._tag === "None") return assert.fail("expected sign-in to be refused");
				assert.instanceOf(error.value, SignInError);
				assert.strictEqual(error.value.reason, "refused");
				assert.strictEqual(error.value.detail, String(status));
				assert.lengthOf(service.hits, 1);
				assert.deepStrictEqual(target.hits, []);
				assert.deepStrictEqual(masked, []);
			}).pipe(Effect.scoped),
		);
	}
});
