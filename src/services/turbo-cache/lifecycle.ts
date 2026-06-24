import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schedule } from "effect";
import type { TurboCacheResolution } from "./activation.js";

/** Default localhost port for the turbo cache server. */
export const DEFAULT_TURBO_PORT = 41230;

/** Deterministic log-file path for the detached server on a given port. */
export const serverLogPath = (port: number): string => join(tmpdir(), `turbogha-${port}.log`);

/** A fully-resolved spawn description for the detached server process. */
export interface SpawnSpec {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly env: Record<string, string>;
	readonly port: number;
}

/** Build the spawn spec (env carries config to the detached child). */
export const buildSpawnSpec = (
	serverEntry: string,
	resolution: Extract<TurboCacheResolution, { mode: "embedded" }>,
	opts: { port: number; prefix: string; token: string },
): SpawnSpec => {
	const env: Record<string, string> = {
		TURBOGHA_PORT: String(opts.port),
		TURBOGHA_PREFIX: opts.prefix,
		TURBOGHA_TOKEN: opts.token,
		TURBOGHA_BACKEND: resolution.backend,
	};
	if (resolution.backend === "s3") {
		env.TURBOGHA_S3_BUCKET = resolution.s3.bucket;
		env.TURBOGHA_S3_REGION = resolution.s3.region;
		env.TURBOGHA_S3_ENDPOINT = resolution.s3.endpoint;
		env.TURBOGHA_S3_ACCESS_KEY_ID = resolution.s3.accessKeyId;
		env.TURBOGHA_S3_SECRET_ACCESS_KEY = resolution.s3.secretAccessKey;
		env.TURBOGHA_S3_SESSION_TOKEN = resolution.s3.sessionToken;
		env.TURBOGHA_S3_PREFIX = resolution.s3.prefix;
	}
	return { command: process.execPath, args: [serverEntry], env, port: opts.port };
};

/** Spawn the server detached and unref'd; returns its pid. Child stdout/stderr
 * go to a log file (NOT "ignore") so a startup failure is diagnosable. The fds
 * are still fully detached from the parent's pipes, so the Actions step does not
 * hang. */
export const spawnTurboServer = (spec: SpawnSpec): Effect.Effect<number, never> =>
	/* v8 ignore start -- spawns a real detached process; exercised by the e2e fixture */
	Effect.sync(() => {
		const out = openSync(serverLogPath(spec.port), "a");
		const child = spawn(spec.command, [...spec.args], {
			detached: true,
			stdio: ["ignore", out, out],
			env: { ...process.env, ...spec.env },
		});
		child.unref();
		return child.pid ?? -1;
	});
/* v8 ignore stop */

/**
 * Poll the server's status endpoint until it responds 200 or the budget is
 * exhausted. Returns whether the server became ready. Never fails — a false
 * return is the caller's signal to degrade (do not export a dead TURBO_API).
 */
export const waitForServer = (
	port: number,
	opts: { attempts?: number; delayMillis?: number } = {},
): Effect.Effect<boolean, never> => {
	const probe = Effect.tryPromise({
		try: () =>
			fetch(`http://127.0.0.1:${port}/v8/artifacts/status`).then((r) => {
				if (!r.ok) throw new Error(`status ${r.status}`);
				return true as const;
			}),
		catch: () => new Error("not ready"),
	});
	return probe.pipe(
		Effect.retry(
			Schedule.intersect(
				Schedule.spaced(`${opts.delayMillis ?? 150} millis`),
				Schedule.recurs((opts.attempts ?? 40) - 1),
			),
		),
		Effect.catchAll(() => Effect.succeed(false)),
	);
};

/** Kill a pid with SIGTERM, swallowing "already gone" errors. */
export const killProcess = (pid: number, kill: (pid: number, signal?: string) => void = process.kill): void => {
	// Never signal a non-positive pid. process.kill(-1, ...) / kill(0, ...) target
	// the caller's whole process group, and spawnTurboServer returns -1 when the
	// child never got a pid — signalling the group would take out the runner.
	if (pid <= 0) return;
	try {
		kill(pid, "SIGTERM");
	} catch {
		// process already exited — nothing to do
	}
};
