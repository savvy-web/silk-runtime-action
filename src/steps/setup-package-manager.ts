import type { ActionOutputError, PackageManagerInstallerError } from "@effected/github-actions";
import { ActionLogger, ActionOutputs, PackageManagerInstaller } from "@effected/github-actions";
import type { InvalidPackageManagerPinError } from "@effected/npm";
import { PackageManagerPin } from "@effected/npm";
import { Data, Effect, Option } from "effect";

import type { PackageManagerName, PackageManagerSpec } from "../schema/domain.js";

/**
 * Raised when the `devEngines.packageManager` cannot be installed, published
 * to `PATH`, or verified afterward.
 */
export class PackageManagerError extends Data.TaggedError("PackageManagerError")<{
	readonly reason: "install" | "activate" | "verify";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/**
 * Everything the install branch can fail with.
 *
 * @remarks
 * Spelled out rather than inferred so {@link classify} is exhaustive over it: a
 * new failure surfacing from either dependency becomes a type error here rather
 * than a silent fall-through to `"install"`.
 */
type SetupFailure = InvalidPackageManagerPinError | PackageManagerInstallerError | ActionOutputError;

/**
 * Which stage a failure belongs to.
 *
 * @remarks
 * All three literals stay in honest use. `activate` is the `addPath` failure —
 * publishing the manager to `PATH` is what legacy's `corepack prepare
 * --activate` did, and a manager that never reaches `PATH` is exactly what
 * "not activated" means. `verify` is `layoutUnexpected` alone: the artifact
 * downloaded, extracted and cached, and what failed is the check that its
 * contents are the package manager the pin claims. Everything else — an
 * unparseable pin, a download, an extraction, a cache write, an integrity
 * mismatch, a platform with no build — happened while acquiring the manager,
 * which is `install`.
 */
const classify = (error: SetupFailure): PackageManagerError["reason"] => {
	if (error._tag === "ActionOutputError") return "activate";
	if (error._tag === "InvalidPackageManagerPinError") return "install";
	// Bound before the switch: narrowing `error` itself to `never` in the
	// default branch would leave nothing to read the unhandled reason from.
	const reason: PackageManagerInstallerError["reason"] = error.reason;
	switch (reason) {
		case "layoutUnexpected":
			return "verify";
		case "downloadFailed":
		case "extractFailed":
		case "cacheFailed":
		case "integrityMismatch":
		case "integrityMissing":
		case "unsupportedPlatform":
			return "install";
		default: {
			// Exhaustive by construction: a reason literal added upstream fails to
			// assign to `never` here, so it is a compile error rather than a silent
			// `install`. Unreachable at runtime — the throw is what an impossible
			// state deserves.
			const unhandled: never = reason;
			throw new Error(`PackageManagerInstallerError carries an unhandled reason: ${String(unhandled)}`);
		}
	}
};

/**
 * Provisions the pinned manager and publishes it to `PATH`.
 *
 * @remarks
 * The pin string is assembled from `devEngines` and handed to
 * `PackageManagerPin.parse`, which owns the `<name>@<version>[+<integrity>]`
 * grammar. A `devEngines` version may carry an integrity tail
 * (`10.20.0+sha512.…`), and the first `+` always begins integrity — so the
 * split is the pin's to make, never this step's.
 *
 * `install` runs with default options. In particular `requireIntegrity` stays
 * off: in-the-wild `devEngines` pins routinely carry no hash, and the installer
 * already warns when one does not. Warnings are not buffered, so that notice
 * reaches the log even on a green run.
 */
const provision = (spec: PackageManagerSpec) =>
	Effect.gen(function* () {
		const installer = yield* PackageManagerInstaller;
		const outputs = yield* ActionOutputs;

		const pin = yield* PackageManagerPin.parse(`${spec.name}@${spec.version}`);
		const installed = yield* installer.install(pin);
		yield* Effect.logDebug(`${spec.name} ${spec.version}: ${installed.source}`);

		// An `ambient` answer is already on `PATH` — it is what the probe found
		// there — and carries no directory. A `tool-cache` answer does, and
		// `PackageManagerInstaller` deliberately stops at the cache: putting a
		// cached bin on `PATH` is `ActionOutputs.addPath` (dossier §A8).
		//
		// `source` is the union's discriminant, so this narrows to
		// `CachedPackageManager` and `binDir` is required there — the impossible
		// directoryless-tool-cache state an earlier round had to guard against is
		// now unrepresentable. `binDir` rather than `directory` is the uniform
		// `addPath` target: for npm/pnpm/yarn it is the entry's `.bin` directory of
		// shims the installer writes, and for bun it *is* the entry directory.
		if (installed.source === "tool-cache") {
			yield* outputs.addPath(installed.binDir);
		}

		return installed;
	}).pipe(
		// One collapse for every stage, so a caller sees a single error class with
		// the manager and version in its message (legacy `errors.ts:47-59`).
		Effect.catch((error: SetupFailure) =>
			Effect.fail(
				new PackageManagerError({
					reason: classify(error),
					message: `Failed to setup ${spec.name}@${spec.version}: ${error.message}`,
					cause: error,
				}),
			),
		),
	);

/**
 * The activated package manager: what `devEngines` asked for, plus where the
 * command lives when it lives anywhere this action put it.
 *
 * @remarks
 * `binDir` is `Some` only for a tool-cache install — the directory handed to
 * `addPath`. It is `None` for an ambient manager (already on the runner's
 * `PATH`) and for the bun/deno no-op (the runtime install owns that binary).
 * The next step needs it because `addPath` writes `GITHUB_PATH` for *later*
 * workflow steps and never touches this process's own `PATH`.
 */
export interface ActivatedPackageManager {
	readonly name: PackageManagerName;
	readonly version: string;
	readonly binDir: Option.Option<string>;
}

/**
 * Installs and activates the `devEngines.packageManager` entry.
 *
 * @remarks
 * `bun` and `deno` are their own package managers: naming either one here means
 * the runtime install already put it on `PATH`, so this is a complete no-op
 * with the legacy log line (oracle 18). Neither is probed, and neither is
 * checked against the `devEngines` version.
 *
 * Everything else goes through `PackageManagerInstaller`, which replaces the
 * whole corepack/sudo/shim apparatus v1 carried (rulings 20-27): no `sudo npm
 * install -g`, no `~/.npm` chown, no tmpdir cwd, no Node-25 corepack bootstrap,
 * no shim cleanup. The npm ambient short-circuit lives inside the installer.
 *
 * The reported name and version are a pure echo of the request — never the
 * installed manager's own report — because the `package-manager` and
 * `package-manager-version` outputs are what the caller asked for, not what a
 * probe found (ruling 47). {@link ActivatedPackageManager.binDir} is the one
 * field that is not an echo: it is where this run actually put the command, and
 * it exists for the install step downstream rather than for any output.
 *
 * `R` is what the step actually touches. `ToolInstaller` and
 * `ChildProcessSpawner` are gone from it: both were there for the corepack
 * machinery rulings 20-27 dropped, and the tool cache is now the installer's
 * business, behind its own layer.
 */
export const setupPackageManager = (
	spec: PackageManagerSpec,
): Effect.Effect<
	ActivatedPackageManager,
	PackageManagerError,
	PackageManagerInstaller | ActionOutputs | ActionLogger
> =>
	Effect.gen(function* () {
		const echo = { name: spec.name, version: spec.version };

		if (spec.name === "bun" || spec.name === "deno") {
			yield* Effect.logInfo(`${spec.name} is its own package manager, no additional setup needed`);
			return { ...echo, binDir: Option.none() };
		}

		const logger = yield* ActionLogger;
		// The transcript is held and discarded on success, so a green run is one
		// step line. The installer's integrity notice is a warning, which
		// `withBuffer` never holds — a pin with no hash still says so.
		const installed = yield* logger.withBuffer(spec.name, provision(spec), { onSuccess: "discard" });
		yield* Effect.logInfo(`${spec.name}@${spec.version} activated`);

		return { ...echo, binDir: installed.source === "tool-cache" ? Option.some(installed.binDir) : Option.none() };
	});
