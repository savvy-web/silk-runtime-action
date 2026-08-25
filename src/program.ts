/**
 * The `main` phase pipeline: inputs → steps → outputs.
 *
 * @remarks
 * Every step is a typed contract module under `./steps/`, composed here in
 * runner order and wrapped in an `ActionLogger.group` so the workflow log is
 * navigable. This module holds the composition and the joins that need two
 * steps' results at once — nothing else: no I/O, no detection, no formatting.
 *
 * The output fold starts from {@link initialOutputs} and maps each step's
 * result over it, so a feature that did not run reports its all-disabled
 * default rather than a value nobody computed.
 *
 * @module program
 */

import { ActionEnvironment, ActionLogger } from "@effected/github-actions";
import { Effect, Option } from "effect";

import type { RuntimeName } from "./schema/domain.js";
import { loadInputs } from "./schema/inputs.js";
import type { OutputsModel } from "./schema/outputs.js";
import { emitOutputs, initialOutputs } from "./schema/outputs.js";
import { detectBats } from "./steps/detect-bats.js";
import { detectBiome } from "./steps/detect-biome.js";
import { detectTurbo } from "./steps/detect-turbo.js";
import type { InstalledBats } from "./steps/install-bats.js";
import { installBats } from "./steps/install-bats.js";
import { installBiome } from "./steps/install-biome.js";
import { installDependencies } from "./steps/install-dependencies.js";
import type { InstalledKcov } from "./steps/install-kcov.js";
import { installKcov } from "./steps/install-kcov.js";
import type { InstalledRuntime } from "./steps/install-runtimes.js";
import { installRuntimes } from "./steps/install-runtimes.js";
import { loadConfig } from "./steps/load-config.js";
import { restoreCache } from "./steps/restore-cache.js";
import type { ActivatedPackageManager } from "./steps/setup-package-manager.js";
import { setupPackageManager } from "./steps/setup-package-manager.js";
import { writeSummary } from "./steps/summary.js";
import type { StartedTurboCache } from "./steps/turbo-cache.js";
import { startTurboCache } from "./steps/turbo-cache.js";
import { formatDetectLine } from "./summary/format.js";

/**
 * The package manager, told where this run put it when it *is* one of the
 * runtimes this run installed.
 *
 * @remarks
 * `bun` and `deno` are their own package managers, so the package-manager step
 * is a deliberate no-op for them and reports no `binDir` — the binary is the
 * runtime install's business. But the runtime install only publishes to `PATH`
 * with `ActionOutputs.addPath`, which appends `GITHUB_PATH` for *later* workflow
 * steps and never touches this process. Left alone, the dependency install would
 * spawn a bare `bun` against whatever the runner image happens to have, or
 * nothing at all — the same class of failure that shim directories fixed for
 * pnpm.
 *
 * The join lives here rather than in either step because it is the only place
 * that holds both results: neither step contract changes, and neither learns
 * about the other.
 *
 * {@link InstalledRuntime.path} is already the directory that was published to
 * `PATH` — the same value `installRuntimes` handed `addPath` — so it is the bin
 * directory, not a path to descend from.
 *
 * A manager that already knows where it is keeps that answer: an npm-registry
 * manager's shim directory wins over a same-named runtime, and there is no such
 * collision anyway (`npm`, `pnpm` and `yarn` are never runtimes).
 */
const onInstallPath = (
	pm: ActivatedPackageManager,
	runtimes: ReadonlyArray<InstalledRuntime>,
): ActivatedPackageManager => {
	if (Option.isSome(pm.binDir)) return pm;
	const runtime = runtimes.find((installed) => installed.name === pm.name);
	return runtime === undefined ? pm : { ...pm, binDir: Option.some(runtime.path) };
};

/**
 * Every directory this run put a binary in, in the order the install child
 * should search them.
 *
 * @remarks
 * The manager alone is not enough. A package manager's install spawns lifecycle
 * scripts, and those inherit the install child's `PATH` — so a `postinstall`
 * running `deno install` or `bun install` looks for a runtime this action
 * installed on a `PATH` that, with only the manager prepended, does not have it.
 * That is a real cross-OS failure and not a hypothetical: a multi-runtime
 * workspace failed on every runner with `deno: not found`.
 *
 * Assembling the list here rather than in either step is the same reasoning as
 * {@link onInstallPath}: this is the only place holding both results.
 *
 * The manager leads so its shims win a name collision with a same-named runtime
 * — which is exactly the bun/deno-as-package-manager case, where
 * {@link onInstallPath} has already filled `binDir` from the runtime install and
 * the two entries are the same directory. `Set` drops that duplicate while
 * keeping first-seen order, so the head stays the manager's answer.
 *
 * The npm collision is the one this had to rule on, and it is now settled
 * upstream of here rather than in this list (issue #220). An *ambient* npm
 * answer carries no `binDir`, so it contributed nothing and the pinned node's
 * bin directory led — meaning the install child ran the npm **bundled with** the
 * pinned node, not the pinned npm, on exactly the runs where the runner's own
 * npm happened to match the pin. `setupPackageManager` passes `allowAmbient:
 * false`, so no npm reaches this function without a `binDir` and the head of the
 * list is the pinned npm on every run. The rule the list implements is therefore
 * uniform for all five managers: **the manager you pinned leads**.
 */
const installPathPrepends = (
	pm: ActivatedPackageManager,
	runtimes: ReadonlyArray<InstalledRuntime>,
): ReadonlyArray<string> => [
	...new Set([
		...Option.match(pm.binDir, { onNone: () => [], onSome: (binDir) => [binDir] }),
		...runtimes.map((installed) => installed.path),
	]),
];

/**
 * The `{rt}Version` / `{rt}Enabled` pair for one runtime.
 *
 * @remarks
 * Oracle 46: the version output is the *installed* result's version and the
 * enabled flag is presence in the results — "we installed it", not "the
 * manifest asked for it". The two happen to coincide because the installed
 * version echoes the requested one (there is no resolution step: `devEngines`
 * versions are absolute), but the distinction matters for a runtime the
 * manifest never named — it must publish `""` / `false`, not the requested
 * version of something that was never fetched.
 */
const runtimeOutputs = (
	runtimes: ReadonlyArray<InstalledRuntime>,
	name: RuntimeName,
): { readonly version: string; readonly enabled: boolean } => {
	const installed = runtimes.find((runtime) => runtime.name === name);
	return installed === undefined ? { version: "", enabled: false } : { version: installed.version, enabled: true };
};

/**
 * The `turbo-cache-backend` / `turbo-cache-port` pair, from what the step
 * started.
 *
 * @remarks
 * The port is `""` rather than `"0"` or `"none"` when no embedded server is
 * listening (oracle 44) — `turbo-cache-port` is documented as empty when the
 * server was not started, and a workflow reading it tests emptiness.
 *
 * Split out as a pure function rather than folded inline because it is the one
 * part of the turbo wiring a test can pin without a detached child: the step
 * itself spawns, and the program run that exercises it therefore cannot.
 */
export const turboCacheOutputs = (
	started: StartedTurboCache,
): Pick<OutputsModel, "turboCacheBackend" | "turboCachePort"> => ({
	turboCacheBackend: started.backend,
	turboCachePort: Option.match(started.port, { onNone: () => "", onSome: (port) => String(port) }),
});

/**
 * How the dependency cache restore went, in the three words `cache-hit` is
 * documented to take.
 *
 * @remarks
 * `"partial"` is the interesting one: something restored, but not what this run
 * asked for, so a workflow reading the output learns that its dependencies came
 * from a neighbouring key rather than its own. v1 published the same three
 * values from a hit enum; here they come off `restoredKey` directly.
 */
const cacheHit = (state: {
	readonly primaryKey: string;
	readonly restoredKey: Option.Option<string>;
}): OutputsModel["cacheHit"] =>
	Option.isNone(state.restoredKey) ? "false" : state.restoredKey.value === state.primaryKey ? "true" : "partial";

export const program = Effect.gen(function* () {
	const logger = yield* ActionLogger;
	// Fail fast: `github` is the first thing that needs a real runner, so a
	// non-runner environment fails here with `ActionEnvironmentError` rather
	// than after every step has already run.
	yield* (yield* ActionEnvironment).github;
	const inputs = yield* loadInputs;

	// Quiet the tool chatter our *own* install steps provoke. Set on this
	// process only — never `exportVariable` — so none of it leaks into the
	// consumer's later job steps (oracle 43). `COREPACK_ENABLE_DOWNLOAD_PROMPT`
	// outlives corepack's removal from this action: it costs nothing and still
	// covers a corepack the consumer's own steps invoke.
	yield* Effect.sync(() => {
		process.env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
		process.env.NPM_CONFIG_FUND = "false";
		process.env.HUSKY = "0";
		process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
	});

	const config = yield* logger.group("Load configuration", loadConfig);
	// Detection runs before the cache restore because both the resolved Biome
	// version and turbo's presence feed the cache key and path set — the legacy
	// ordering (`legacy-v1/program.ts:382-411`).
	const biomeVersion = yield* logger.group("Detect Biome", detectBiome(inputs.biomeVersion));
	const turbo = yield* logger.group("Detect Turbo", detectTurbo);
	const batsDecision = yield* logger.group("Detect BATS", detectBats({ bats: inputs.bats, kcov: inputs.kcov }));
	// The headline a reader skims instead of expanding the detection groups above
	// (oracle 29). v1 emitted it as the canonical success line of a single
	// "Detect configuration" group; detection is four groups here, so the line
	// is assembled once all four have answered and gets a group of its own —
	// a structural deviation, and the only placement that can carry every fact.
	yield* logger.group(
		"Detected configuration",
		Effect.logInfo(
			formatDetectLine({
				runtimes: config.runtimes,
				packageManager: config.packageManager,
				biome: biomeVersion,
				turbo: turbo.enabled,
				bats: batsDecision.installBats,
			}),
		),
	);
	const cache = yield* logger.group("Restore dependency cache", restoreCache({ inputs, config, biomeVersion, turbo }));

	const runtimes = yield* logger.group("Install runtimes", installRuntimes(config));
	// The group title names the manager rather than describing the step, and
	// says `Install` rather than legacy's "via corepack" — which was a lie for
	// bun and deno even before corepack left the action (ruling 17).
	const packageManager = yield* logger.group(
		`Install ${config.packageManager.name}`,
		setupPackageManager(config.packageManager),
	);
	const activated = onInstallPath(packageManager, runtimes);
	// PHASE B: the dependency install is the only step that spawns anything today,
	// so the prepend list is computed inline. When `installBiome` or the turbo
	// server start spawning they need the same `PATH`, and the list should be
	// bound once here and shared rather than recomputed per caller.
	//
	// The result is bound rather than discarded because the summary reports it:
	// `ran` is *truthful* — false for deno, for a disabled install, and for
	// nothing else — where v1 echoed the raw input back and so reported deno's
	// skipped install as done (oracle 44, quirk 52).
	const dependencies = yield* logger.group(
		"Install dependencies",
		installDependencies(activated, inputs.installDeps, installPathPrepends(activated, runtimes), {
			ignoreScripts: inputs.ignoreScripts,
		}),
	);
	// Biome is optional, so a failed install degrades to a warning and the run
	// carries on (oracle 29) — a lint tool a later step may or may not invoke is
	// not worth failing a job over. The outputs then fold from *this* result
	// rather than from detection, so a run that could not install Biome reports
	// it as disabled; v1 folded from detection and reported an enabled Biome
	// that was never fetched (oracle 30).
	const biome = yield* logger.group(
		"Install Biome",
		installBiome(biomeVersion).pipe(
			Effect.catch((error) =>
				Effect.logWarning(`Biome installation failed: ${error.message}`).pipe(
					Effect.as(Option.none<{ readonly version: string; readonly path: string }>()),
				),
			),
		),
	);
	// Optional, exactly as Biome is: a toolchain a later step may or may not
	// invoke is not worth failing a job over, and the outputs fold from the
	// install result rather than from detection so a run that could not fetch it
	// reports disabled (oracle 30).
	const bats = yield* logger.group(
		"Install BATS",
		installBats(batsDecision.installBats).pipe(
			Effect.catch((error) =>
				Effect.logWarning(`BATS installation failed: ${error.message}`).pipe(Effect.as(Option.none<InstalledBats>())),
			),
		),
	);
	// kcov is gated on bats having actually landed, not merely on the decision: a
	// coverage tool for a toolchain that failed to install has nothing to cover.
	const kcov = yield* logger.group(
		"Install kcov",
		installKcov(batsDecision.installKcov && Option.isSome(bats), { bust: inputs.cacheBust }).pipe(
			Effect.catch((error) =>
				Effect.logWarning(`kcov installation failed: ${error.message}`).pipe(Effect.as(Option.none<InstalledKcov>())),
			),
		),
	);
	// Last in the pipeline deliberately: nothing above consumes the turbo
	// environment, and a later start shortens the window in which a detached
	// child holds the runner's short-lived `ACTIONS_RUNTIME_TOKEN`.
	const turboCache = yield* logger.group("Start turbo remote cache", startTurboCache({ inputs, turbo }));

	const node = runtimeOutputs(runtimes, "node");
	const bun = runtimeOutputs(runtimes, "bun");
	const deno = runtimeOutputs(runtimes, "deno");
	const outputs: OutputsModel = {
		...initialOutputs,
		nodeVersion: node.version,
		nodeEnabled: node.enabled,
		bunVersion: bun.version,
		bunEnabled: bun.enabled,
		denoVersion: deno.version,
		denoEnabled: deno.enabled,
		packageManager: packageManager.name,
		packageManagerVersion: packageManager.version,
		biomeVersion: Option.match(biome, { onNone: () => "", onSome: (installed) => installed.version }),
		biomeEnabled: Option.isSome(biome),
		batsVersion: Option.match(bats, { onNone: () => "", onSome: (installed) => installed.version }),
		batsEnabled: Option.isSome(bats),
		batsLibPath: Option.match(bats, { onNone: () => "", onSome: (installed) => installed.libPath }),
		kcovVersion: Option.match(kcov, { onNone: () => "", onSome: (installed) => installed.version }),
		kcovEnabled: Option.isSome(kcov),
		kcovCacheHit: Option.match(kcov, { onNone: () => false, onSome: (installed) => installed.cacheHit }),
		turboEnabled: turbo.enabled,
		...turboCacheOutputs(turboCache),
		cacheHit: cacheHit(cache.workspace),
		storeCacheHit: cacheHit(cache.store),
		lockfiles: cache.workspace.lockfiles.join(","),
		// Both archives' paths, workspace first. The output is documented as the
		// set this run restores, and after the split that is two entries — a
		// consumer reading it back to see whether their store was covered would
		// otherwise find it simply missing.
		cachePaths: [...cache.workspace.paths, ...cache.store.paths].join(","),
	};

	yield* emitOutputs(outputs);
	// Last, and after the outputs: the panel reports a run that has already
	// published everything a later workflow step reads, so a summary that cannot
	// be written costs a report rather than a result.
	yield* writeSummary({
		outputs,
		runtimes,
		biome,
		// Detection travels beside the install result so the closing group can
		// tell "nobody asked for Biome" apart from "we could not fetch the one
		// you pinned" — two situations the install result alone renders as one.
		biomeDetected: biomeVersion,
		bats,
		kcov,
		// Requested-but-failed is what the panel's `unavailable` cell reports, and
		// the decision is the only thing that can tell it apart from never asked.
		kcovRequested: batsDecision.installKcov,
		cache: cache.workspace,
		turboCache,
		dependenciesInstalled: dependencies.ran,
	});
});
