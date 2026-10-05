/**
 * The embedded cache server's access log: what one line says, and what a whole
 * log adds up to.
 *
 * @remarks
 * The server is a detached child writing to a file in the temp directory, so
 * nothing it says reaches the workflow log on its own — and until this module
 * it said nothing per request at all. A job whose turbo tasks all missed and a
 * job whose turbo never reached the server looked the same from outside: turbo
 * printing misses. The two halves here close that gap from both ends. The
 * server writes one {@link accessLine} per artifact request, and `post` reads
 * the file back, prints it, and heads it with the {@link tallyAccessLog} totals.
 *
 * Both halves are pure and live together so the writer and the reader cannot
 * drift: the tally counts the outcome words the line formatter emits, and one
 * test round-trips them.
 *
 * @module turbo-cache/access-log
 */

import type { TurboRequest, TurboResponse } from "./handler.js";
import { artifactHashOf } from "./handler.js";

/** What every line the server writes starts with, so a shared file stays readable. */
export const SERVER_LOG_PREFIX = "turbo-server: ";

/** How one artifact request ended, as the single word its line carries. */
export type AccessOutcome = "hit" | "miss" | "stored" | "exists" | "absent" | "unauthorized" | "error" | "rejected";

/**
 * The outcome word for a method and the status the handler answered with.
 *
 * @remarks
 * `GET` and `HEAD` get different words for the same statuses on purpose: a
 * `HEAD` is turbo asking whether an artifact exists before it uploads, not a
 * restore, and counting it as a hit would overstate what the cache served.
 */
export const accessOutcome = (method: string, status: number): AccessOutcome => {
	if (status === 401) return "unauthorized";
	if (status >= 500) return "error";
	if (method === "GET") return status === 200 ? "hit" : status === 404 ? "miss" : "rejected";
	if (method === "HEAD") return status === 200 ? "exists" : status === 404 ? "absent" : "rejected";
	if (method === "PUT") return status === 202 ? "stored" : "rejected";
	return "rejected";
};

/** A byte count in the largest unit that keeps it readable. */
const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * The line for one request, or `null` for a request that is not about an
 * artifact.
 *
 * @remarks
 * The readiness probe and turbo's telemetry sink are left out: the spawning
 * step polls `/status` up to forty times, and a log that opens with forty
 * identical lines buries the ones worth reading.
 *
 * The size is the artifact's — the response body on a hit, the request body on
 * an upload — and is omitted where there is none. Nothing here is secret: the
 * hash is turbo's task hash, which turbo prints itself, and the bearer token is
 * never part of the line.
 */
export const accessLine = (request: TurboRequest, response: TurboResponse, elapsedMs: number): string | null => {
	const hash = artifactHashOf(request.path);
	if (hash === null) return null;
	const outcome = accessOutcome(request.method, response.status);
	const bytes =
		outcome === "hit" ? (response.body?.byteLength ?? 0) : outcome === "stored" ? request.body.byteLength : null;
	const size = bytes === null ? "" : ` ${formatBytes(bytes)}`;
	return `${request.method} ${hash} ${response.status} ${outcome}${size} ${Math.round(elapsedMs)}ms`;
};

/** What a whole access log adds up to. */
export interface AccessTally {
	/** `GET`s answered with an artifact. */
	readonly hits: number;
	/** `GET`s answered 404 — nothing stored under that hash, or an unreadable entry. */
	readonly misses: number;
	/** `PUT`s the backend accepted. */
	readonly uploads: number;
	/** Requests that ended in a backend failure or a rejected credential. */
	readonly errors: number;
}

const ACCESS_LINE = /^(?:GET|HEAD|PUT|POST|DELETE|PATCH|OPTIONS) \S+ \d{3} (\w+)/;

/**
 * Counts the outcomes in a server log.
 *
 * @remarks
 * Lines that are not access lines — the listening line, a backend failure's
 * explanation, a stray stack trace — are skipped rather than counted, so the
 * tally is of requests and nothing else. An `unauthorized` counts as an error:
 * the only client is this run's own turbo with this run's own token, so a 401
 * is a wiring fault, not a stranger.
 */
export const tallyAccessLog = (log: string): AccessTally => {
	const tally = { hits: 0, misses: 0, uploads: 0, errors: 0 };
	for (const raw of log.split("\n")) {
		const line = raw.startsWith(SERVER_LOG_PREFIX) ? raw.slice(SERVER_LOG_PREFIX.length) : raw;
		const outcome = ACCESS_LINE.exec(line)?.[1];
		if (outcome === "hit") tally.hits += 1;
		else if (outcome === "miss") tally.misses += 1;
		else if (outcome === "stored") tally.uploads += 1;
		else if (outcome === "error" || outcome === "unauthorized") tally.errors += 1;
	}
	return tally;
};

const plural = (count: number, noun: string, plural = `${noun}s`): string => `${count} ${count === 1 ? noun : plural}`;

/** The tally as the one line `post` heads the activity group with. */
export const formatAccessTally = (tally: AccessTally): string =>
	[
		plural(tally.hits, "hit"),
		plural(tally.misses, "miss", "misses"),
		plural(tally.uploads, "upload"),
		plural(tally.errors, "error"),
	].join(", ");
