import { ActionLogger, ActionOutputs, ToolInstaller } from "@effected/github-actions";
import { Data, Effect, Option, Path, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { bun } from "../descriptors/bun.js";
import { deno } from "../descriptors/deno.js";
import type { RuntimeDescriptor } from "../descriptors/descriptor.js";
import { node } from "../descriptors/node.js";
import type { RuntimeConfig, RuntimeName, RuntimeSpec } from "../schema/domain.js";

/**
 * Raised when a `devEngines.runtime` entry cannot be resolved, downloaded,
 * extracted, or cached into the runner's tool cache.
 *
 * @remarks
 * `verify` covers everything after the tool is in the cache: publishing its bin
 * directory to `PATH` and running the binary once. Both are the same class of
 * failure to a caller — the runtime is installed but unusable — and neither is
 * worth its own literal.
 */
export class RuntimeInstallError extends Data.TaggedError("RuntimeInstallError")<{
	readonly reason: "download" | "extract" | "cache" | "unsupported-platform" | "verify";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** One runtime, on the runner, with the directory that was published to `PATH`. */
export interface InstalledRuntime {
	readonly name: RuntimeName;
	readonly version: string;
	readonly path: string;
}

/** The runner's operating system and architecture. */
export interface Host {
	readonly platform: string;
	readonly arch: string;
}

/**
 * The host, read from the process.
 *
 * @remarks
 * The **only** place this step touches `process`. Descriptors take the host as
 * arguments, so every platform is exercisable without monkey-patching the
 * process — legacy read `process.platform` inside the installer and
 * `os.platform()` inside the Biome descriptor, and neither was testable
 * (`legacy-v1/services/runtime-installer.ts:89,93`).
 */
export const currentHost = (): Host => ({ platform: process.platform, arch: process.arch });

const DESCRIPTORS: Record<RuntimeName, RuntimeDescriptor> = { node, bun, deno };

/** A descriptor refusing a host. Carries the prose the installer reports. */
class PlanError extends Data.TaggedError("PlanError")<{ readonly message: string }> {}

/** The installed binary would not run. */
class VerifyError extends Data.TaggedError("VerifyError")<{ readonly message: string }> {}

/**
 * A human-readable reason for any thrown or failed value.
 *
 * @remarks
 * Ported from `legacy-v1/services/runtime-installer.ts:12-22` with the first
 * two branches **swapped**: a `message` now wins over a `reason`. Legacy's
 * order made sense against a kit whose errors carried prose in `reason`; the
 * `@effected` errors carry a discriminant there (`downloadFailed`) and the
 * prose in a `message` getter beside it ("Could not download <url> (HTTP
 * 404)"). Under the legacy order every install failure rendered as one word.
 *
 * This is prose for a human reading a failed job. {@link classify} reads
 * `reason` instead, and the two deliberately stay separate: one is the
 * discriminant, the other is the sentence.
 */
const extractErrorReason = (error: unknown): string => {
	if (error !== null && typeof error === "object") {
		const candidate = error as Record<string, unknown>;
		if (typeof candidate.message === "string" && candidate.message !== "") return candidate.message;
		if (typeof candidate.reason === "string" && candidate.reason !== "") return candidate.reason;
		if (typeof candidate._tag === "string") return candidate._tag;
	}
	if (error instanceof Error && error.message !== "") return error.message;
	const rendered = String(error);
	return rendered === "" ? "Unknown error" : rendered;
};

/**
 * Which stage a failure belongs to, for a caller that branches on the reason.
 *
 * @remarks
 * Reads the error's `reason` **discriminant**, not the prose
 * {@link extractErrorReason} renders. Unifying the two would tie a routing
 * decision to a message string.
 */
const classify = (error: unknown): RuntimeInstallError["reason"] => {
	if (error === null || typeof error !== "object") return "verify";
	const candidate = error as { readonly _tag?: unknown; readonly reason?: unknown };
	if (candidate._tag === "PlanError") return "unsupported-platform";
	if (candidate._tag === "ToolInstallerError") {
		if (candidate.reason === "downloadFailed") return "download";
		if (candidate.reason === "extractFailed") return "extract";
		if (candidate.reason === "cacheFailed") return "cache";
	}
	return "verify";
};

/**
 * Installs one runtime: find, then download/extract/cache on a miss, then
 * publish to `PATH` and run it once.
 */
const installOne = (spec: RuntimeSpec, host: Host) =>
	Effect.gen(function* () {
		const installer = yield* ToolInstaller;
		const outputs = yield* ActionOutputs;
		const path = yield* Path.Path;
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

		const planned = DESCRIPTORS[spec.name].plan(spec.version, host.platform, host.arch);
		if (Result.isFailure(planned)) return yield* new PlanError({ message: planned.failure });
		const plan = planned.success;
		yield* Effect.logDebug(`${spec.name} ${spec.version}: ${plan.url}`);

		// A runner that already has this exact version skips the download
		// entirely. Legacy had no such check and re-downloaded every run
		// (oracle 13); the tool cache is keyed by tool and version, so a hit is
		// the same bytes the download would have produced.
		const cached = yield* installer.find(spec.name, spec.version);
		const root = Option.isSome(cached)
			? cached.value
			: yield* Effect.gen(function* () {
					const archive = yield* installer.download(plan.url);
					const extracted =
						plan.archive === "zip"
							? yield* installer.extractZip(archive)
							: yield* installer.extractTar(archive, { flags: plan.tarFlags });
					// The archive's own wrapper directory is stripped *before* the
					// cache write, so the cached root is the canonical
					// `<tool>/<version>/<arch>` layout every other writer of that
					// cache uses. Caching the wrapper instead would make the hit path
					// unable to find the binary: a hit returns the cached root with no
					// extracted archive left to descend into.
					const source = plan.archiveSubPath === undefined ? extracted : path.join(extracted, plan.archiveSubPath);
					return yield* installer.cacheDir(source, spec.name, spec.version);
				});
		yield* Effect.logDebug(`${spec.name} ${spec.version}: cached at ${root}`);

		// Joined through `Path`, not interpolated with a literal separator as in
		// legacy (`:112`). Only segments genuinely inside the cached tool belong
		// here — node's `bin` on Unix — so a hit and a miss resolve identically.
		const toolPath = plan.binSubPath === undefined ? root : path.join(root, plan.binSubPath);
		yield* outputs.addPath(toolPath);

		// `addPath` writes `GITHUB_PATH`, which only takes effect in *later*
		// steps, so the probe runs the binary by absolute path. Legacy invoked the
		// bare name and therefore verified whatever the runner already had.
		//
		// `exitCode` leaves stdout and stderr undrained, which is safe for
		// `--version` — a line or two fits the pipe buffer and the process exits.
		// A chattier command would fill the buffer and block forever; anything
		// verbose belongs on a member that drains, such as `string` or `lines`.
		const binary = path.join(toolPath, plan.binary);
		const exitCode = yield* spawner.exitCode(ChildProcess.make(binary, ["--version"]));
		if (exitCode !== 0) return yield* new VerifyError({ message: `${binary} --version exited ${exitCode}` });

		return { name: spec.name, version: spec.version, path: toolPath } satisfies InstalledRuntime;
	}).pipe(
		// One collapse for every stage, so a caller sees a single error class with
		// the runtime and version in its message (oracle 29).
		Effect.catch((error) =>
			Effect.fail(
				new RuntimeInstallError({
					reason: classify(error),
					message: `Failed to install ${spec.name}@${spec.version}: ${extractErrorReason(error)}`,
					cause: error,
				}),
			),
		),
	);

/**
 * Installs every runtime in `config.runtimes` into the runner's tool cache.
 *
 * @remarks
 * Sequential, in `devEngines` declaration order, and fatal on the first failure
 * — a later runtime is not attempted (oracle 15, 34). Duplicates are not
 * deduplicated: a manifest that declares the same runtime twice installs it
 * twice, which is v1 behavior (oracle 42), and the tool-cache hit makes the
 * second pass cheap.
 *
 * `ActionOutputs` is in `R` because `ToolInstaller` deliberately stops at the
 * tool cache — putting an installed runtime's `bin` on `PATH` is
 * `ActionOutputs.addPath` (dossier §A8). `Path` joins the bin subdirectory,
 * and `ChildProcessSpawner` runs the verify probe.
 *
 * `host` defaults to the process and is a parameter for one reason: it is what
 * lets a test exercise the Windows layout and a platform a runtime publishes no
 * build for. Callers pass one argument.
 */
export const installRuntimes = (
	config: RuntimeConfig,
	host: Host = currentHost(),
): Effect.Effect<
	ReadonlyArray<InstalledRuntime>,
	RuntimeInstallError,
	ToolInstaller | ActionOutputs | ActionLogger | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const logger = yield* ActionLogger;
		return yield* Effect.forEach(config.runtimes, (spec) =>
			// The transcript is held and discarded on success, so a green run is one
			// line per runtime and a failure still spills the url and cache path.
			logger
				.withBuffer(spec.name, installOne(spec, host), { onSuccess: "discard" })
				.pipe(Effect.tap((installed) => Effect.logInfo(`${installed.name} ${installed.version}`))),
		);
	});
