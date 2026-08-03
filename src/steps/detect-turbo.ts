import { Data, Effect, FileSystem } from "effect";

/**
 * Raised when `turbo.json` cannot be read.
 */
export class TurboDetectError extends Data.TaggedError("TurboDetectError")<{
	readonly reason: "read";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** The one file turbo detection looks for, relative to the working directory. */
const TURBO_CONFIG = "turbo.json";

/**
 * Detects whether a `turbo.json` is present in the working directory.
 *
 * @remarks
 * Presence, and nothing else (oracle 24-25). The file is never opened, so an
 * invalid or empty `turbo.json` still counts — which is v1's answer and the
 * right one: what this decides is whether turbo's artifact directory joins the
 * cache and whether the embedded remote cache is allowed to start, and both
 * questions are about the repository using turbo at all, not about its config
 * being well-formed. There is no `turbo.jsonc` fallback and no `package.json`
 * key, again matching v1.
 *
 * The path is **working-directory relative**, as in v1. The cache restore
 * resolves the checkout from `GITHUB_WORKSPACE` and this does not, which is a
 * real difference on a job that changes directory — kept deliberately, because
 * turbo itself resolves its config from the working directory and this must
 * agree with turbo rather than with the cache step.
 *
 * `TurboDetectError` stays on the signature and is never raised: a probe that
 * fails for any reason at all — absent, unreadable, a broken mount — answers
 * `false`, because there is nothing else a caller could do with the
 * distinction.
 */
export const detectTurbo: Effect.Effect<{ readonly enabled: boolean }, TurboDetectError, FileSystem.FileSystem> =
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const enabled = yield* fs.access(TURBO_CONFIG).pipe(
			Effect.as(true),
			Effect.catch(() => Effect.succeed(false)),
		);
		if (enabled) yield* Effect.logInfo("Detected Turbo configuration");
		return { enabled };
	});
