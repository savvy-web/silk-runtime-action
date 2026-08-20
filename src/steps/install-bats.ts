/**
 * Provisions bats-core and its four helper libraries.
 *
 * @module steps/install-bats
 */

import { Run } from "@effected/commands";
import type { ActionLogger, ToolInstallerError } from "@effected/github-actions";
import { ActionOutputs, ToolInstaller } from "@effected/github-actions";
import { Data, Effect, FileSystem, Option, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ChildProcess } from "effect/unstable/process";

import type { BatsLibraryPlan } from "../descriptors/bats.js";
import { batsCorePlan, batsLibraryPlans } from "../descriptors/bats.js";

/**
 * Raised when the BATS toolchain cannot be provisioned.
 *
 * @remarks
 * Four reasons rather than the provisioner's three: `install` is this step's
 * own — copying an extracted library into place, or synthesizing bats-mock's
 * `load.bash` — and has no counterpart upstream.
 */
export class BatsInstallError extends Data.TaggedError("BatsInstallError")<{
	readonly reason: "download" | "extract" | "install" | "publish";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** What this step put on the runner. */
export interface InstalledBats {
	readonly version: string;
	readonly binDir: string;
	/** The single `BATS_LIB_PATH` entry every library was installed beneath. */
	readonly libPath: string;
	readonly libraries: ReadonlyArray<{ readonly name: string; readonly version: string }>;
}

/**
 * Which of this step's reasons a provisioner failure belongs to.
 *
 * @remarks
 * No `default` arm and an annotated return type, matching `install-biome`'s
 * `classify`: a fourth reason upstream becomes a typecheck failure here rather
 * than a silent miscategorization in a workflow log.
 */
const classify = (error: ToolInstallerError): BatsInstallError["reason"] => {
	switch (error.reason) {
		case "downloadFailed":
			return "download";
		case "extractFailed":
			return "extract";
		case "cacheFailed":
			return "install";
	}
};

const fail = (error: ToolInstallerError) =>
	Effect.fail(new BatsInstallError({ reason: classify(error), message: error.message, cause: error }));

/**
 * The synthesized `load.bash` for a `flat`-layout library that ships none.
 *
 * @remarks
 * Assembled from two literals rather than one: bats-core's `${BASH_SOURCE[0]}`
 * is bash interpolation for the *installed* script to evaluate at load time,
 * not a placeholder for this module to fill in — a single string literal
 * containing it unbroken reads to a linter as an accidentally unescaped
 * template.
 */
const BATS_MOCK_LOADER = `source "$(dirname "$${"{BASH_SOURCE[0]}"}")/stub.bash"\n`;

/**
 * Installs one helper library into `<libRoot>/<name>/`.
 *
 * @remarks
 * The bats-core org's three ship `load.bash` beside `src/`; `bats-mock` ships a
 * flat `stub.bash` / `binstub` and *may* omit `load.bash` entirely. The
 * synthesized fallback is the devcontainer feature script's, carried over
 * verbatim in behavior: a one-line `source` of the sibling `stub.bash`, which is
 * what makes `bats_load_library bats-mock` work at all.
 *
 * `binstub` keeps its executable bit — it is spawned, not sourced.
 */
const installLibrary = (
	lib: BatsLibraryPlan,
	libRoot: string,
): Effect.Effect<void, BatsInstallError, ToolInstaller | FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const installer = yield* ToolInstaller;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const archive = yield* installer.download(lib.url).pipe(Effect.catch(fail));
		const extracted = yield* installer.extractTar(archive).pipe(Effect.catch(fail));
		const source = path.join(extracted, lib.archiveSubPath);
		const destination = path.join(libRoot, lib.name);

		yield* fs.makeDirectory(destination, { recursive: true }).pipe(
			Effect.catch((cause) =>
				Effect.fail(
					new BatsInstallError({
						reason: "install",
						message: `Could not create ${destination}: ${cause.message}`,
						cause,
					}),
				),
			),
		);
		yield* fs.copy(source, destination).pipe(
			Effect.catch((cause) =>
				Effect.fail(
					new BatsInstallError({
						reason: "install",
						message: `Could not install ${lib.name} into ${destination}: ${cause.message}`,
						cause,
					}),
				),
			),
		);

		if (lib.layout === "flat") {
			const loader = path.join(destination, "load.bash");
			const present = yield* fs.access(loader).pipe(
				Effect.as(true),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (!present) {
				yield* fs.writeFileString(loader, BATS_MOCK_LOADER).pipe(
					Effect.catch((cause) =>
						Effect.fail(
							new BatsInstallError({
								reason: "install",
								message: `Could not synthesize ${loader}: ${cause.message}`,
								cause,
							}),
						),
					),
				);
			}
			yield* fs.chmod(path.join(destination, "binstub"), 0o755).pipe(Effect.catch(() => Effect.void));
		}

		yield* Effect.logDebug(`${lib.name} ${lib.version} → ${destination}`);
	});

/**
 * Provisions the BATS toolchain, when this run decided to.
 *
 * @remarks
 * bats-core goes into the **tool cache**; the four helper libraries go into
 * `$HOME/.local/share`. That split is deliberate and is dictated by the
 * consumer: `vitest-bats` (the primary consumer) locates libraries by scanning
 * a fixed directory list — `$XDG_CONFIG_HOME`, `~/.config`, `$XDG_DATA_HOME`,
 * `~/.local/share`, `/opt/homebrew/lib`, `/usr/local/lib`, `/usr/lib` — and
 * never reads `BATS_LIB_PATH`. Installing under `~/.local/share` satisfies
 * that scan *and* `bats_load_library` — which resolves `<entry>/<lib>/load.bash`
 * — from one location, and needs no `sudo`, unlike the `/usr/lib` both the
 * devcontainer script and `bats-core/bats-action` write to.
 *
 * `home` is a parameter for the same reason the runtime steps take a `Host`: it
 * is what lets a test exercise the layout without an `$HOME` on the machine
 * running the suite.
 *
 * The `jq` probe is a warning, never a failure: `jq` is preinstalled on
 * GitHub-hosted runners, and `Run.succeeds` already collapses a spawn failure
 * to `false`, so a self-hosted runner missing it fails loudly in the log
 * instead of mysteriously later, when `vitest-bats` tries to record a mock.
 */
export const installBats = (
	install: boolean,
	home: string = process.env.HOME ?? "",
): Effect.Effect<
	Option.Option<InstalledBats>,
	BatsInstallError,
	| ToolInstaller
	| ActionOutputs
	| FileSystem.FileSystem
	| Path.Path
	| ActionLogger
	| ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		if (!install) return Option.none();

		const jqPresent = yield* Run.succeeds(ChildProcess.make("jq", ["--version"]));
		if (!jqPresent) {
			yield* Effect.logWarning("jq was not found on PATH — vitest-bats mock recording requires it");
		}

		const installer = yield* ToolInstaller;
		const outputs = yield* ActionOutputs;
		const path = yield* Path.Path;
		const core = batsCorePlan();

		const archive = yield* installer.download(core.url).pipe(Effect.catch(fail));
		const extracted = yield* installer.extractTar(archive).pipe(Effect.catch(fail));
		const cached = yield* installer
			.cacheDir(path.join(extracted, core.archiveSubPath), "bats", core.version)
			.pipe(Effect.catch(fail));
		const binDir = path.join(cached, core.binSubPath);

		const libRoot = path.join(home, ".local", "share");
		const libraries = batsLibraryPlans();
		for (const lib of libraries) {
			yield* installLibrary(lib, libRoot);
		}

		const publish = (effect: Effect.Effect<void, { readonly message: string }>) =>
			effect.pipe(
				Effect.catch((cause) =>
					Effect.fail(
						new BatsInstallError({
							reason: "publish",
							message: `BATS ${core.version} could not be published: ${cause.message}`,
							cause,
						}),
					),
				),
			);

		yield* publish(outputs.addPath(binDir));
		yield* publish(outputs.exportVariable("BATS_LIB_PATH", libRoot));
		yield* publish(outputs.exportVariable("BATS_PATH", path.join(binDir, "bats")));

		yield* Effect.logInfo(`BATS ${core.version}`);
		return Option.some({
			version: core.version,
			binDir,
			libPath: libRoot,
			libraries: libraries.map((lib) => ({ name: lib.name, version: lib.version })),
		});
	});
