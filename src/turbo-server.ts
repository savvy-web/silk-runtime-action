// src/turbo-server.ts
/**
 * Detached turbo remote-cache server.
 *
 * Spawned by main (see services/turbo-cache/lifecycle.ts) with config in env.
 * Implements Turbo's /v8/artifacts contract over a library BlobStore backend.
 *
 * @module turbo-server
 */
import { createServer } from "node:http";
import { NodeHttpClient } from "@effect/platform-node";
import type { BlobStore } from "@savvy-web/github-action-effects";
import { GitHubBlobStoreLive, S3BlobStoreLive } from "@savvy-web/github-action-effects";
import { Layer, ManagedRuntime, Redacted } from "effect";
import type { TurboRequest } from "./services/turbo-cache/handler.js";
import { makeTurboHandler } from "./services/turbo-cache/handler.js";

/* v8 ignore start -- detached process entry; exercised by the e2e fixture */
const port = Number(process.env.TURBOGHA_PORT ?? "41230");
const prefix = process.env.TURBOGHA_PREFIX ?? "";
const token = process.env.TURBOGHA_TOKEN ?? "";
const backend = process.env.TURBOGHA_BACKEND ?? "github";

// Both backends need HttpClient; provide NodeHttpClient.layer exactly as
// src/layers/app.ts does for ActionCacheLive.
const liveLayer: Layer.Layer<BlobStore> =
	backend === "s3"
		? S3BlobStoreLive({
				bucket: process.env.TURBOGHA_S3_BUCKET ?? "",
				region: process.env.TURBOGHA_S3_REGION ?? "",
				accessKeyId: process.env.TURBOGHA_S3_ACCESS_KEY_ID ?? "",
				secretAccessKey: Redacted.make(process.env.TURBOGHA_S3_SECRET_ACCESS_KEY ?? ""),
				...(process.env.TURBOGHA_S3_ENDPOINT ? { endpoint: process.env.TURBOGHA_S3_ENDPOINT } : {}),
				...(process.env.TURBOGHA_S3_SESSION_TOKEN
					? { sessionToken: Redacted.make(process.env.TURBOGHA_S3_SESSION_TOKEN) }
					: {}),
				...(process.env.TURBOGHA_S3_PREFIX ? { prefix: process.env.TURBOGHA_S3_PREFIX } : {}),
			}).pipe(Layer.provide(NodeHttpClient.layerUndici))
		: GitHubBlobStoreLive.pipe(Layer.provide(NodeHttpClient.layerUndici));

const runtime = ManagedRuntime.make(liveLayer);
const handler = makeTurboHandler({ prefix, expectedToken: token });

const server = createServer((req, res) => {
	const chunks: Array<Buffer> = [];
	req.on("data", (c: Buffer) => chunks.push(c));
	req.on("end", () => {
		const durationHeader = req.headers["x-artifact-duration"];
		const artifactDuration = typeof durationHeader === "string" ? Number(durationHeader) || 0 : 0;
		const treq: TurboRequest = {
			method: req.method ?? "GET",
			path: req.url ?? "/",
			authorization: req.headers.authorization,
			artifactTag: typeof req.headers["x-artifact-tag"] === "string" ? req.headers["x-artifact-tag"] : undefined,
			artifactDuration,
			body: new Uint8Array(Buffer.concat(chunks)),
		};
		runtime
			.runPromise(handler(treq))
			.then((r) => {
				res.writeHead(r.status, r.headers);
				res.end(r.body ? Buffer.from(r.body) : undefined);
			})
			.catch(() => {
				res.writeHead(500);
				res.end();
			});
	});
});

server.listen(port, "127.0.0.1");
/* v8 ignore stop */
