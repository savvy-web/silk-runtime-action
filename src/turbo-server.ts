/**
 * Detached turbo remote-cache server entry point.
 *
 * @remarks
 * Spawned by the action's `startTurboCache` step with its whole configuration
 * in the environment (see `turbo-cache/server-config.ts`), and reachable by
 * turbo through the `TURBO_API` variable the same step exports. It outlives
 * the step that started it and is stopped by `post`, which sends it a
 * `SIGTERM`.
 *
 * Everything here is plumbing: read the environment, build the backend, buffer
 * a request, hand it to the handler, write what comes back. The decisions —
 * routes, keys, metadata, backend selection — live in `turbo-cache/` where
 * they are reachable from a test. This file is not imported by anything.
 *
 * @module turbo-server
 */

import { createServer } from "node:http";
import { ManagedRuntime, Result } from "effect";

import type { TurboRequest } from "./turbo-cache/handler.js";
import { makeTurboHandler } from "./turbo-cache/handler.js";
import { isAuthShapedFailure, readServerConfig, serverBlobStoreLayer } from "./turbo-cache/server-config.js";

/* v8 ignore start -- detached process entry; exercised by the e2e workflow */

/** How long a shutdown waits for in-flight requests before exiting anyway. */
const SHUTDOWN_DEADLINE_MS = 2_000;

/** Everything this process says, so a shared log file stays readable. */
const say = (message: string): void => {
	console.error(`turbo-server: ${message}`);
};

const configured = readServerConfig(process.env);
if (Result.isFailure(configured)) {
	// Ruling 72: no token, no server. The step always supplies one, so this is
	// a spawn whose environment did not survive — starting anyway would leave an
	// unauthenticated cache server listening on the runner.
	say(configured.failure);
	process.exit(1);
}

const config = configured.success;
const runtime = ManagedRuntime.make(serverBlobStoreLayer(config));

const handler = makeTurboHandler({
	prefix: config.prefix,
	expectedToken: config.token,
	onStoreFailure: (error) => {
		// Ruling 70: the documented `ACTIONS_RUNTIME_TOKEN` limitation stands, but
		// its symptom is now named. Without this a job that ran long enough for the
		// token to expire simply stops caching, and the only trace is turbo
		// reporting misses.
		if (config.backend === "github" && isAuthShapedFailure(error)) {
			say(
				"the Actions cache refused a request — ACTIONS_RUNTIME_TOKEN has most likely expired, so cache writes from here on are lost",
			);
			return;
		}
		say(`the ${config.backend} backend failed: ${error.message}`);
	},
});

const server = createServer((req, res) => {
	// The whole body is buffered, with no size cap (quirk 75, kept): turbo sends
	// a complete artifact per request and a cap invented here would fail a large
	// monorepo's build rather than slow it down.
	const chunks: Array<Buffer> = [];
	req.on("data", (chunk: Buffer) => {
		chunks.push(chunk);
	});
	req.on("end", () => {
		const duration = req.headers["x-artifact-duration"];
		const tag = req.headers["x-artifact-tag"];
		const request: TurboRequest = {
			method: req.method ?? "GET",
			path: req.url ?? "/",
			authorization: req.headers.authorization,
			artifactTag: typeof tag === "string" ? tag : undefined,
			artifactDuration: typeof duration === "string" ? Number(duration) || 0 : 0,
			body: new Uint8Array(Buffer.concat(chunks)),
		};
		runtime.runPromise(handler(request)).then(
			(response) => {
				res.writeHead(response.status, response.headers);
				res.end(response.body ? Buffer.from(response.body) : undefined);
			},
			() => {
				// The handler answers 500 for everything it can name; a rejection here
				// is a defect, and turbo needs an answer either way.
				res.writeHead(500);
				res.end();
			},
		);
	});
});

// Ruling 71: v1 left this unhandled, so a port collision killed the server with
// an unhandled exception into a log nobody reads and the action waited out its
// full readiness budget before degrading. One line, then exit.
server.on("error", (error: NodeJS.ErrnoException) => {
	say(
		error.code === "EADDRINUSE"
			? `port ${config.port} is already in use — another cache server is running on this runner`
			: `cannot listen on 127.0.0.1:${config.port}: ${error.message}`,
	);
	process.exit(1);
});

// Ruling 74: v1 had no shutdown path at all, so `post`'s SIGTERM killed the
// process mid-request and lost whichever artifact turbo was writing. `close`
// stops accepting and waits for what is in flight; disposing the runtime
// releases the backend's client.
//
// The deadline is what keeps "waits for what is in flight" from becoming
// "outlives the job": `close` never calls back while a request hangs, and
// `post` does not wait after signalling. `unref` keeps it from holding the
// process open on the normal path, where the callback wins the race.
process.on("SIGTERM", () => {
	setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();
	server.close(() => {
		void runtime.dispose().then(
			() => process.exit(0),
			() => process.exit(0),
		);
	});
});

// Loopback only: the cache server is for this runner's turbo and nothing else.
server.listen(config.port, "127.0.0.1");

/* v8 ignore stop */
