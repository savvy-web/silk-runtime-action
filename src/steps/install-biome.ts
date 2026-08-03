import type { ActionLogger, ToolInstallerError } from "@effected/github-actions";
import { ActionOutputs, ToolInstaller } from "@effected/github-actions";
import type { FileSystem } from "effect";
import { Data, Effect, Option, Result } from "effect";

import { biome } from "../descriptors/biome.js";
import type { Host } from "./install-runtimes.js";
import { currentHost } from "./install-runtimes.js";

/**
 * Raised when the configured Biome version cannot be detected, downloaded, or
 * cached into the runner's tool cache.
 *
 * @remarks
 * Three reasons where v1 had none: its install body flattened every typed
 * failure into `Error("Biome install failed: " + error)`, which rendered a
 * structured error as `[object Object]` (oracle 28). `detect` is the host
 * having no published asset — a permanent condition retrying cannot fix —
 * while `download` and `cache` are the provisioner's own two.
 */
export class BiomeInstallError extends Data.TaggedError("BiomeInstallError")<{
	readonly reason: "detect" | "download" | "cache";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/**
 * Which of this step's reasons a provisioner failure belongs to.
 *
 * @remarks
 * `extractFailed` is unreachable here — `provisionFile` downloads a bare
 * executable and never extracts anything — but it is spelled out rather than
 * folded into a fallback, because a fallback would classify it, and any reason
 * added upstream later, as whichever literal happened to be the else branch.
 *
 * The switch has **no default**, and the return type is annotated: a fourth
 * reason upstream leaves a path that returns nothing, which is a typecheck
 * failure here rather than a silent `cache` in a workflow log. Same shape as
 * `cache-config`'s per-manager switches and the same intent as
 * `setup-package-manager`'s `never` branch.
 */
const classify = (error: ToolInstallerError): BiomeInstallError["reason"] => {
	switch (error.reason) {
		case "downloadFailed":
			return "download";
		case "extractFailed":
		case "cacheFailed":
			return "cache";
	}
};

/**
 * Installs Biome at `version`, when present.
 *
 * @remarks
 * `version` is the **resolved** version produced by `detectBiome` — the
 * `biome-version` input override or the version derived from a Biome config
 * file — not the raw input. `Option.none()` means there is nothing to install,
 * and the step is then a no-op that touches neither the tool cache nor `PATH`.
 *
 * The whole install is one `ToolInstaller.provisionFile` call: cache lookup,
 * download, the executable bit and the cache write are the provisioner's, and
 * so is the cache-hit short-circuit v1 never had (oracle 18 — v1 re-downloaded
 * Biome on every run). What stays here is everything host- or action-specific:
 * the asset table and url template in `descriptors/biome.ts`, publishing the
 * provisioned directory to `PATH`, and the error taxonomy.
 *
 * The returned `path` is the provisioner's `binDir`, which for a single binary
 * is the cached directory itself — the same value handed to `addPath`, so a
 * caller reporting where Biome went reports where it actually is.
 *
 * There is no verify probe, matching v1 (oracle 22) and unlike the runtime
 * installs. A runtime is verified because it is what everything after it runs
 * on; Biome is a lint tool a later workflow step either invokes or does not.
 *
 * `host` defaults to the process and is a parameter for the same reason as
 * `installRuntimes`': it is what lets a test exercise the Windows asset. v1
 * read `os.platform()` inside the step and was untestable for it (oracle 13).
 *
 * `FileSystem` and `ActionLogger` stay in `R` though nothing here touches them
 * — the chmod they were needed for is `provisionFile`'s now. The step contract
 * was frozen in Phase A and narrowing `R` is a contract change, so they stay,
 * as `Path` does on `loadConfig`.
 */
export const installBiome = (
	version: Option.Option<string>,
	host: Host = currentHost(),
): Effect.Effect<
	Option.Option<{ readonly version: string; readonly path: string }>,
	BiomeInstallError,
	ToolInstaller | ActionOutputs | FileSystem.FileSystem | ActionLogger
> =>
	Effect.gen(function* () {
		if (Option.isNone(version)) return Option.none();
		const requested = version.value;

		const planned = biome.plan(requested, host.platform, host.arch);
		if (Result.isFailure(planned)) {
			return yield* new BiomeInstallError({ reason: "detect", message: planned.failure });
		}
		const plan = planned.success;

		const installer = yield* ToolInstaller;
		const outputs = yield* ActionOutputs;

		yield* Effect.logDebug(`biome ${requested}: ${plan.url}`);
		const provisioned = yield* installer
			.provisionFile({ tool: "biome", version: requested, url: plan.url, binary: plan.binary })
			.pipe(
				// The provisioner's own prose is carried verbatim rather than wrapped:
				// the call site adds the one prefix a reader needs, where v1 stacked
				// two and lost the structure between them (oracle 28).
				Effect.catch((error) =>
					Effect.fail(new BiomeInstallError({ reason: classify(error), message: error.message, cause: error })),
				),
			);

		// A publish failure joins `cache`: the tool is in the tool cache and this
		// run could not make it reachable, which is the same thing to a caller as
		// a cache write that did not land — the version asked for is not usable.
		// v1 swept `addPath` into the same catch as everything else (oracle 32),
		// and the reason union is the step's frozen contract.
		yield* outputs.addPath(provisioned.binDir).pipe(
			Effect.catch((error) =>
				Effect.fail(
					new BiomeInstallError({
						reason: "cache",
						message: `Biome ${requested} could not be published to PATH: ${error.message}`,
						cause: error,
					}),
				),
			),
		);
		yield* Effect.logInfo(`Biome ${requested}`);
		return Option.some({ version: requested, path: provisioned.binDir });
	});
