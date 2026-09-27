import type {
	ActionOutputError,
	PackageManagerInstallOptions,
	PackageManagerInstallerError,
} from "@effected/github-actions";
import { ActionLogger, ActionOutputs, PackageManagerInstaller } from "@effected/github-actions";
import type { LockfileFramingError, LockfileParseError } from "@effected/lockfiles";
import { PnpmEnvLockfile } from "@effected/lockfiles";
import type { InvalidPackageManagerPinError, InvalidSriIntegrityHashError } from "@effected/npm";
import { CorepackIntegrityHash, PackageManagerPin } from "@effected/npm";
import type { PlatformError } from "effect";
import { Data, Effect, FileSystem, Option } from "effect";

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
 * than a silent fall-through to `"install"`. `LockfileParseError` and
 * `LockfileFramingError` come from reading `pnpm-lock.yaml`'s env preamble for
 * the pnpm case, and `InvalidSriIntegrityHashError` from converting its
 * recorded integrity (and `PlatformError` from a lockfile that exists but
 * cannot be read) into the corepack form the installer takes — all three
 * happen while *acquiring* the manager, same as an unparseable pin.
 */
type SetupFailure =
	| InvalidPackageManagerPinError
	| InvalidSriIntegrityHashError
	| LockfileFramingError
	| LockfileParseError
	| PlatformError.PlatformError
	| PackageManagerInstallerError
	| ActionOutputError;

/**
 * The `addPath` failure, as a stage.
 *
 * @remarks
 * A function rather than a bare literal so its parameter type can assert what
 * {@link classify} matched: upstream split `ActionOutputError` into one class
 * per failure, and this is where that residue is proven to be exactly those.
 */
const activate = (_: ActionOutputError): PackageManagerError["reason"] => "activate";

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
 * unparseable pin, an unreadable `pnpm-lock.yaml`, a malformed or framing-broken env
 * preamble, an unconvertible lockfile integrity, a download, an extraction, a
 * cache write, an integrity mismatch, a platform with no build — happened
 * while acquiring the manager, which is `install`.
 */
const classify = (error: SetupFailure): PackageManagerError["reason"] => {
	switch (error._tag) {
		case "InvalidPackageManagerPinError":
		case "InvalidSriIntegrityHashError":
		case "LockfileFramingError":
		case "LockfileParseError":
		case "PlatformError":
			return "install";
		default:
			break;
	}
	// Upstream split `ActionOutputError` into one class per failure, so the
	// output failures are matched as the residue rather than named by tag. The
	// parameter type keeps that residue honest: a failure added to
	// `SetupFailure` that is not an output failure fails to assign here, so it
	// is a compile error rather than a silent `activate`.
	if (error._tag !== "PackageManagerInstallerError") return activate(error);
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
 * The `pnpm-lock.yaml` filename, probed cwd-relative — the action runs inside
 * the checkout, exactly as `load-config` reads `package.json` and
 * `install-dependencies` probes its own lockfile names.
 */
const PNPM_LOCKFILE = "pnpm-lock.yaml";

/**
 * The `integrity` / `nativeIntegrity` install options `pnpm-lock.yaml`
 * supplies for `pin`, or none.
 *
 * @remarks
 * pnpm records the package manager a workspace declares in
 * `devEngines.packageManager` as the root importer's
 * `packageManagerDependencies` in the lockfile's env preamble, resolved like
 * any other dependency — the preamble's `packages:` section carries its
 * integrity, and pnpm itself refuses to run a manager whose identity does not
 * match. That makes the lockfile, not the pin's own `+sha512.<hex>` tail, the
 * checksum store for the manager itself; this reads it as a second,
 * independent source of truth rather than a replacement for the pin's.
 *
 * No file (`NotFound` only — any other read failure fails the step), or a
 * file with no env preamble at all (`Option.none()` from
 * {@link PnpmEnvLockfile.packageManager}), answers `{}` — today's behaviour,
 * verified only against the pin's own inline hash. A preamble that names a
 * different pnpm version than `pin` also answers `{}`, but with a logged
 * warning: the lockfile's claim does not apply to what `devEngines` pinned, so
 * it is ignored rather than trusted or treated as a mismatch. A preamble that
 * parses but cannot back its own claim (no `packages` entry, no integrity)
 * fails typed, fail-closed, through {@link LockfileParseError} —
 * {@link classify} routes it to `"install"`.
 *
 * `nativeIntegrity` is omitted rather than passed empty: pnpm 11 records none
 * in the preamble (its platform binaries hang off a separate `@pnpm/exe`
 * wrapper this model does not carry), and `exactOptionalPropertyTypes` makes
 * an explicit empty record a different, worse thing to hand the installer than
 * the key being absent.
 */
const pnpmLockOptions = (
	fs: FileSystem.FileSystem,
	pin: PackageManagerPin,
): Effect.Effect<
	Pick<PackageManagerInstallOptions, "integrity" | "nativeIntegrity">,
	LockfileFramingError | LockfileParseError | InvalidSriIntegrityHashError | PlatformError.PlatformError
> =>
	Effect.gen(function* () {
		const content = yield* fs.readFileString(PNPM_LOCKFILE, "utf-8").pipe(
			Effect.map(Option.some),
			// Only absence means "no lockfile". A lockfile that exists but cannot be
			// read fails the step: swallowing it would silently skip verification.
			Effect.catchIf(
				(error) => error.reason._tag === "NotFound",
				() => Effect.succeed(Option.none<string>()),
			),
		);
		if (Option.isNone(content)) return {};

		const lock = yield* PnpmEnvLockfile.packageManager(content.value);
		if (Option.isNone(lock)) return {};

		const pinVersion = pin.version.toString();
		if (lock.value.version !== pinVersion) {
			yield* Effect.logWarning(
				`pnpm-lock.yaml pins pnpm@${lock.value.version}, which does not match devEngines' pnpm@${pinVersion}; ignoring the lockfile's integrity`,
			);
			return {};
		}

		const integrity = yield* CorepackIntegrityHash.fromSri(lock.value.integrity);
		const nativeIntegrity = lock.value.nativeIntegrity;
		return {
			integrity,
			...(Object.keys(nativeIntegrity).length > 0 ? { nativeIntegrity } : {}),
		};
	});

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
 * For pnpm, and pnpm alone, {@link pnpmLockOptions} reads `pnpm-lock.yaml` and
 * — when its env preamble names the same pnpm version as `pin` — hands the
 * installer that lockfile's own recorded `integrity` and `nativeIntegrity`
 * alongside the pin. The lockfile is the primary source of truth once it
 * applies; the pin's inline hash remains a secondary check the installer
 * itself reconciles (`integrityMismatch` when the two disagree), and the
 * installer's own "carries no integrity" warning is the last resort when
 * neither source applies. npm, yarn, bun and deno never read a lockfile here —
 * only pnpm's `devEngines.packageManager` entry has a lockfile-recorded
 * integrity to verify against.
 *
 * `requireIntegrity` stays off: in-the-wild `devEngines` pins routinely carry no
 * hash, and the installer already warns when one does not. Warnings are not
 * buffered, so that notice reaches the log even on a green run.
 *
 * `allowAmbient: false` is the one option this step always sets, and it is the
 * whole npm ruling (issue #220). Left on, an npm pin may be answered by the
 * *runner's* npm — probed with `npm --version` before this action's PATH
 * assembly exists — and an ambient answer carries no `binDir`, so it contributes
 * nothing to `program.ts`'s PATH assembly and the pinned node's bin directory
 * leads instead. The install child then runs the npm *bundled with* the pinned
 * node, which is a different binary from the one the probe matched and need not
 * be the pinned version. A probe **miss** tool-caches the pin and does run it.
 * So which npm executes was a function of the runner image, and the pin was
 * honoured on a miss and quietly dropped on a hit.
 *
 * Suppressing the probe makes npm behave like every other tool this action
 * provisions — node, bun, deno, pnpm and yarn are all installed to their exact
 * pin with no ambient short-circuit — and costs one small tarball on the runs
 * where the runner's npm happened to match.
 */
const provision = (spec: PackageManagerSpec) =>
	Effect.gen(function* () {
		const installer = yield* PackageManagerInstaller;
		const outputs = yield* ActionOutputs;

		const pin = yield* PackageManagerPin.parse(`${spec.name}@${spec.version}`);
		const lockOptions = yield* spec.name === "pnpm"
			? Effect.flatMap(FileSystem.FileSystem, (fs) => pnpmLockOptions(fs, pin))
			: Effect.succeed<Pick<PackageManagerInstallOptions, "integrity" | "nativeIntegrity">>({});
		const installed = yield* installer.install(pin, { allowAmbient: false, ...lockOptions });
		yield* Effect.logDebug(`${spec.name} ${spec.version}: ${installed.source}`);

		// Every install through this step now answers `tool-cache`: `allowAmbient:
		// false` suppresses the only branch that could answer `ambient`. The narrow
		// stays because the *union* still has that arm — reading it off the
		// discriminant is what keeps this correct if the option is ever revisited,
		// rather than a cast asserting a shape the types do not promise.
		//
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
 * `binDir` is `Some` for every install this step performs — the directory handed
 * to `addPath` — and `None` only for the bun/deno no-op, where the runtime
 * install owns the binary. It is what makes the ambient-npm hole closable: the
 * next step needs it because `addPath` writes `GITHUB_PATH` for *later* workflow
 * steps and never touches this process's own `PATH`.
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
 * no shim cleanup. The installer's npm ambient short-circuit is suppressed here
 * (see {@link provision}), so every manager arrives from its exact pin.
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
 * business, behind its own layer. `FileSystem.FileSystem` joined `R` for
 * issue #436: the pnpm branch reads `pnpm-lock.yaml` cwd-relative, the same way
 * `load-config` reads `package.json` — a service `program.ts`'s `MainLive`
 * already supplies via `ActionServices`, so this widens the step's own
 * contract without touching layer composition.
 */
export const setupPackageManager = (
	spec: PackageManagerSpec,
): Effect.Effect<
	ActivatedPackageManager,
	PackageManagerError,
	PackageManagerInstaller | ActionOutputs | ActionLogger | FileSystem.FileSystem
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
