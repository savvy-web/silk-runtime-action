/**
 * Main action program (the `main` phase).
 *
 * Imported by main.ts which calls Action.run(program, { layer: MainLive }).
 * Separated so tests can import `program` without triggering the module-level
 * Action.run side effect in main.ts.
 *
 * @module program
 */

import { homedir, arch as osArch, platform as osPlatform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileSystem } from "@effect/platform";
import { ActionInput, ActionOutputs, CommandRunner, Step, ToolInstaller } from "@savvy-web/github-action-effects";
import type { Context } from "effect";
import { Config, Effect, Option, Redacted } from "effect";
import { binaryMap as biomeBinaryMap } from "./descriptors/biome.js";
import { DependencyInstallError, PackageManagerSetupError } from "./errors/errors.js";
import type { PackageManagerEntry, RuntimeEntry } from "./schemas/domain.js";
import type { PackageManager } from "./services/cache.js";
import { findLockFiles, getCombinedCacheConfig, restoreCache } from "./services/cache.js";
import { detectBiome, detectTurbo, loadPackageJson, parseDevEngines } from "./services/config-loader.js";
import type { InstalledRuntime } from "./services/runtime-installer.js";
import {
	RuntimeInstaller,
	extractErrorReason,
	formatCauseDetail,
	installerLayerFor,
} from "./services/runtime-installer.js";
import { resolveTurboCache } from "./services/turbo-cache/activation.js";
import { applyTurboCache } from "./services/turbo-cache/apply.js";
import { spawnTurboServer, waitForServer } from "./services/turbo-cache/lifecycle.js";

/**
 * Install Biome CLI as a raw binary using ToolInstaller primitives.
 */
export const installBiome = (
	version: string,
): Effect.Effect<void, Error, ToolInstaller | ActionOutputs | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const toolInstaller = yield* ToolInstaller;
		const outputs = yield* ActionOutputs;
		const plat = osPlatform();
		const architecture = osArch();

		const binaryName = biomeBinaryMap[plat]?.[architecture];
		if (!binaryName) {
			yield* Effect.fail(new Error(`Unsupported platform for Biome: ${plat}-${architecture}`));
			return;
		}

		const url = `https://github.com/biomejs/biome/releases/download/%40biomejs%2Fbiome%40${version}/${binaryName}`;
		const finalName = plat === "win32" ? "biome.exe" : "biome";

		// Download the binary
		const downloadedPath = yield* toolInstaller.download(url);

		// Cache the file
		const cachedDir = yield* toolInstaller.cacheFile(downloadedPath, finalName, "biome", version);

		// Make executable on non-Windows platforms
		if (plat !== "win32") {
			const fs = yield* FileSystem.FileSystem;
			yield* fs.chmod(join(cachedDir, finalName), 0o755);
		}

		// Add to PATH
		yield* outputs.addPath(cachedDir);

		yield* Step.success(`Biome ${version}`);
	}).pipe(Effect.catchAll((error) => Effect.fail(new Error(`Biome install failed: ${error}`))));

/**
 * Determines active package managers from the set of installed runtimes
 * and the primary package manager.
 */
export const getActivePackageManagers = (
	runtimes: ReadonlyArray<RuntimeEntry>,
	primaryPackageManager: PackageManager,
): PackageManager[] => {
	const pms = new Set<PackageManager>();

	for (const rt of runtimes) {
		if (rt.name === "node") pms.add(primaryPackageManager);
		else if (rt.name === "bun") pms.add("bun");
		else if (rt.name === "deno") pms.add("deno");
	}

	return Array.from(pms);
};

/**
 * Install dependencies using the detected package manager.
 * Uses lockfile-aware flags for reproducible installs.
 */
export const installDependencies = (
	packageManager: PackageManager,
): Effect.Effect<void, DependencyInstallError, CommandRunner | FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const runner = yield* CommandRunner;
		const fs = yield* FileSystem.FileSystem;

		const fileExists = (path: string) =>
			fs.access(path).pipe(
				Effect.map(() => true),
				Effect.orElse(() => Effect.succeed(false)),
			);

		if (packageManager === "deno") {
			yield* Effect.log("Deno caches dependencies automatically, skipping install step");
			return;
		}

		let command: string[];

		switch (packageManager) {
			case "npm": {
				const hasLock = yield* fileExists("package-lock.json");
				command = hasLock ? ["ci"] : ["install"];
				break;
			}
			case "pnpm": {
				const hasLock = yield* fileExists("pnpm-lock.yaml");
				command = hasLock ? ["install", "--frozen-lockfile"] : ["install"];
				break;
			}
			case "yarn": {
				const hasLock = yield* fileExists("yarn.lock");
				command = hasLock ? ["install", "--immutable"] : ["install", "--no-immutable"];
				break;
			}
			case "bun": {
				const hasBunLock = yield* fileExists("bun.lock");
				const hasBunLockb = yield* fileExists("bun.lockb");
				command = hasBunLock || hasBunLockb ? ["install", "--frozen-lockfile"] : ["install"];
				break;
			}
		}

		yield* runner.exec(packageManager, command, { streaming: true }).pipe(
			/* v8 ignore next 8 -- error path tested via CI fixtures */
			Effect.mapError((cause) => {
				const msg = cause instanceof Error ? cause.message : String(cause);
				const stderr =
					cause && typeof cause === "object" && "stderr" in cause ? (cause as { stderr?: string }).stderr : undefined;
				const detail = stderr ? `\n${stderr}` : "";
				return new DependencyInstallError({
					packageManager,
					reason: `Failed to install dependencies: ${msg}${detail}`,
					cause,
				});
			}),
		);

		yield* Step.success("Dependencies installed successfully");
	});

/**
 * Setup the package manager version after Node is installed and on PATH.
 * npm: sudo npm install -g on linux/darwin (global prefix is /usr/local)
 * pnpm/yarn: corepack prepare --activate (from tmpdir to avoid workspace interference)
 * bun/deno: no setup needed (they ARE their own package manager)
 */
export const setupPackageManager = (
	packageManager: PackageManager,
	version: string,
): Effect.Effect<void, PackageManagerSetupError, CommandRunner> =>
	Effect.gen(function* () {
		if (packageManager === "bun" || packageManager === "deno") {
			yield* Effect.log(`${packageManager} is its own package manager, no additional setup needed`);
			return;
		}

		const runner = yield* CommandRunner;

		if (packageManager === "npm") {
			// npm: install exact version globally via sudo (prefix is /usr/local)
			const currentOut = yield* runner.execCapture("npm", ["--version"]);
			const currentVersion = currentOut.stdout.trim();
			if (currentVersion !== version) {
				yield* Effect.log(`Upgrading npm from ${currentVersion} to ${version}...`);
				const plat = osPlatform();
				if (plat === "linux" || plat === "darwin") {
					yield* runner.exec("sudo", ["npm", "install", "-g", `npm@${version}`], { streaming: true });
					// Fix npm cache ownership after sudo (sudo creates root-owned files in ~/.npm)
					const npmCacheDir = join(homedir(), ".npm");
					yield* runner
						.exec("sudo", ["chown", "-R", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, npmCacheDir])
						.pipe(Effect.catchAll(() => Effect.void));
				} else {
					yield* runner.exec("npm", ["install", "-g", `npm@${version}`], { streaming: true });
				}
			} else {
				yield* Effect.log(`npm ${currentVersion} already matches required version`);
			}
		} else {
			// Run all corepack and PM commands from a temp directory to prevent pnpm
			// from reading pnpm-workspace.yaml configDependencies, which hangs on
			// first run before dependencies are installed.
			// See: https://github.com/renovatebot/renovate/issues/39902
			const cwd = tmpdir();

			// Check if corepack needs to be installed (Node >= 25)
			const nodeVersionOut = yield* runner.execCapture("node", ["--version"], { cwd });
			const versionMatch = nodeVersionOut.stdout.trim().match(/^v(\d+)\.\d+\.\d+$/);
			if (versionMatch) {
				const major = Number.parseInt(versionMatch[1], 10);
				if (major >= 25) {
					yield* Effect.log("Node.js >= 25 detected, installing corepack globally...");
					const plat = osPlatform();
					if (plat === "linux" || plat === "darwin") {
						yield* runner.exec("sudo", ["npm", "install", "-g", "--force", "corepack@latest"], {
							cwd,
							streaming: true,
						});
					} else {
						yield* runner.exec("npm", ["install", "-g", "--force", "corepack@latest"], { cwd, streaming: true });
					}
				}
			}

			yield* Effect.log("Enabling corepack...");
			yield* runner.exec("corepack", ["enable"], { cwd }).pipe(
				Effect.catchAll(() =>
					// Retry after removing stale shims (EEXIST from cached Node installs)
					Effect.gen(function* () {
						const whichNode = yield* runner.execCapture("which", ["node"], { cwd });
						const binDir = join(whichNode.stdout.trim(), "..");
						yield* Effect.logDebug("Removing stale corepack shims and retrying...");
						const shims = ["pnpm", "pnpx", "yarn", "yarnpkg", "npm", "npx"];
						const exts = ["", ".js", ".cmd", ".ps1"];
						const allShims = shims.flatMap((s) => exts.map((e) => join(binDir, `${s}${e}`)));
						yield* runner.exec("rm", ["-f", ...allShims]).pipe(Effect.catchAll(() => Effect.void));
						yield* runner.exec("corepack", ["enable"], { cwd, streaming: true });
					}),
				),
			);

			yield* Effect.log(`Preparing ${packageManager}@${version}...`);
			yield* runner.exec("corepack", ["prepare", `${packageManager}@${version}`, "--activate"], {
				cwd,
				streaming: true,
			});
		}

		// Verify — pnpm must run from tmpdir to avoid configDependencies hang
		const verifyOpts = packageManager === "pnpm" ? { cwd: tmpdir() } : {};
		yield* runner.exec(packageManager, ["--version"], { ...verifyOpts, streaming: true });
		yield* Step.success(`${packageManager}@${version} activated`);
	}).pipe(
		/* v8 ignore next 5 -- error path tested via CI fixtures */
		Effect.mapError((cause) => {
			const reason = extractErrorReason(cause);
			const stderr =
				cause && typeof cause === "object" && "stderr" in cause ? (cause as { stderr?: string }).stderr : undefined;
			const detail = stderr ? `\n${stderr}` : "";
			return new PackageManagerSetupError({
				packageManager,
				version,
				reason: `Package manager setup failed: ${reason}${detail}`,
				cause,
			});
		}),
	);

/**
 * Sets all action outputs from the pipeline results.
 */
export const setOutputs = (
	outputs: Context.Tag.Service<ActionOutputs>,
	installed: ReadonlyArray<InstalledRuntime>,
	config: {
		readonly packageManager: PackageManagerEntry;
		readonly biome: Option.Option<string>;
		readonly turbo: boolean;
	},
	cacheHit: "exact" | "partial" | "none",
	lockfiles: string[],
	cachePaths: string[],
) =>
	Effect.gen(function* () {
		// Runtime outputs
		const nodeRt = installed.find((r) => r.name === "node");
		const bunRt = installed.find((r) => r.name === "bun");
		const denoRt = installed.find((r) => r.name === "deno");

		yield* outputs.set("node-version", nodeRt?.version ?? "");
		yield* outputs.set("node-enabled", nodeRt ? "true" : "false");
		yield* outputs.set("bun-version", bunRt?.version ?? "");
		yield* outputs.set("bun-enabled", bunRt ? "true" : "false");
		yield* outputs.set("deno-version", denoRt?.version ?? "");
		yield* outputs.set("deno-enabled", denoRt ? "true" : "false");

		// Package manager outputs
		yield* outputs.set("package-manager", config.packageManager.name);
		yield* outputs.set("package-manager-version", config.packageManager.version);

		// Biome outputs
		yield* outputs.set("biome-version", Option.isSome(config.biome) ? config.biome.value : "");
		yield* outputs.set("biome-enabled", Option.isSome(config.biome) ? "true" : "false");

		// Turbo output
		yield* outputs.set("turbo-enabled", config.turbo ? "true" : "false");

		// Cache outputs
		const cacheHitOutput = cacheHit === "exact" ? "true" : cacheHit === "partial" ? "partial" : "false";
		yield* outputs.set("cache-hit", cacheHitOutput);
		yield* outputs.set("lockfiles", lockfiles.join(","));
		yield* outputs.set("cache-paths", cachePaths.join(","));
	});

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/* v8 ignore start -- pipeline orchestration; individual functions tested separately */
export const program = Effect.gen(function* () {
	const outputs = yield* ActionOutputs;

	// 1. Parse configuration
	const config = yield* Step.groupStep(
		"Detect configuration",
		Effect.gen(function* () {
			const devEngines = yield* loadPackageJson;
			const parsed = parseDevEngines(devEngines);
			const runtimes = parsed.runtime;
			const packageManager = parsed.packageManager;
			const biome = yield* detectBiome;
			const turbo = yield* detectTurbo;

			yield* Effect.log(`Detected runtime(s): ${runtimes.map((r) => `${r.name}@${r.version}`).join(", ")}`);
			yield* Effect.log(`Detected package manager: ${packageManager.name}@${packageManager.version}`);
			if (Option.isSome(biome)) {
				yield* Effect.log(`Detected Biome: ${biome.value}`);
			}
			if (turbo) {
				yield* Effect.log("Detected Turbo configuration");
			}

			return { runtimes, packageManager, biome, turbo };
		}),
	);

	// 2. Determine active package managers and cache config
	const pmName: PackageManager = config.packageManager.name;
	const activePackageManagers = getActivePackageManagers(config.runtimes, pmName);

	// Build runtime version list for tool cache inclusion
	const runtimeEntries: Array<{ name: string; version: string }> = config.runtimes.map((r) => ({
		name: r.name,
		version: r.version,
	}));
	if (Option.isSome(config.biome)) {
		runtimeEntries.push({ name: "biome", version: config.biome.value });
	}

	const cacheConfig = yield* getCombinedCacheConfig(activePackageManagers, runtimeEntries);

	// Read additional lockfile patterns and cache paths from inputs (optional, may be empty)
	const additionalLockfiles = yield* ActionInput.multiline("additional-lockfiles").pipe(Config.withDefault([]));
	const additionalCachePaths = yield* ActionInput.multiline("additional-cache-paths").pipe(Config.withDefault([]));

	const allLockfilePatterns = [...cacheConfig.lockfilePatterns, ...additionalLockfiles];
	const lockfiles = yield* findLockFiles(allLockfilePatterns);

	const cacheBust = yield* Config.string("cache-bust").pipe(Config.withDefault(""));
	const cacheBustValue = cacheBust && cacheBust !== "false" ? cacheBust : undefined;

	// Cache paths no longer include **/.turbo — the turbo remote cache replaces it.
	const finalCachePaths = [...cacheConfig.cachePaths, ...additionalCachePaths];

	yield* Effect.logDebug(`Active PMs: ${activePackageManagers.join(", ")}`);
	yield* Effect.logDebug(`Lockfiles found: ${lockfiles.length > 0 ? lockfiles.join(", ") : "(none)"}`);
	yield* Effect.logDebug(`Cache paths (${finalCachePaths.length}): ${finalCachePaths.join(", ")}`);

	// Resolve and apply turbo remote cache strategy.
	const turboResult = yield* Step.groupStep(
		"Turbo remote cache",
		Effect.gen(function* () {
			const cacheMode =
				(yield* Config.string("turbo-cache").pipe(Config.withDefault("auto"))) === "off" ? "off" : "auto";
			const turboToken = yield* Config.string("turbo-token").pipe(Config.withDefault(""));
			const turboTeam = yield* Config.string("turbo-team").pipe(Config.withDefault(""));
			const prefix = yield* Config.string("turbo-cache-prefix").pipe(Config.withDefault(""));

			// Secrets: read redacted, register with the runner's log mask, then
			// unwrap for transport. setSecret takes plaintext (it tells the runner
			// what to redact); Redacted guards against accidental logging in main.
			const s3Secret = yield* Config.redacted("turbo-s3-secret-access-key").pipe(Config.withDefault(Redacted.make("")));
			const s3Session = yield* Config.redacted("turbo-s3-session-token").pipe(Config.withDefault(Redacted.make("")));
			for (const secret of [turboToken, Redacted.value(s3Secret), Redacted.value(s3Session)]) {
				if (secret !== "") yield* outputs.setSecret(secret);
			}

			const s3 = {
				bucket: yield* Config.string("turbo-s3-bucket").pipe(Config.withDefault("")),
				region: yield* Config.string("turbo-s3-region").pipe(Config.withDefault("")),
				endpoint: yield* Config.string("turbo-s3-endpoint").pipe(Config.withDefault("")),
				accessKeyId: yield* Config.string("turbo-s3-access-key-id").pipe(Config.withDefault("")),
				secretAccessKey: Redacted.value(s3Secret),
				sessionToken: Redacted.value(s3Session),
				prefix: yield* Config.string("turbo-s3-prefix").pipe(Config.withDefault("")),
			};
			const resolution = resolveTurboCache({
				turboDetected: config.turbo,
				cacheMode,
				turboToken,
				turboTeam,
				s3,
			});
			const serverEntry = join(dirname(fileURLToPath(import.meta.url)), "turbo-server.js");
			return yield* applyTurboCache(resolution, {
				serverEntry,
				prefix,
				spawn: spawnTurboServer,
				waitForReady: waitForServer,
			});
		}),
	);

	// 3. Restore cache (non-fatal)
	const cacheResult = yield* Step.groupStep(
		"Restore cache",
		Effect.gen(function* () {
			// Diagnostic: check which cache env vars are available
			const cacheEnvDiag = [
				`ACTIONS_CACHE_URL: ${process.env.ACTIONS_CACHE_URL ? "set" : "NOT SET"}`,
				`ACTIONS_RESULTS_URL: ${process.env.ACTIONS_RESULTS_URL ? "set" : "NOT SET"}`,
				`ACTIONS_RUNTIME_TOKEN: ${process.env.ACTIONS_RUNTIME_TOKEN ? "set" : "NOT SET"}`,
				`ACTIONS_CACHE_SERVICE_V2: ${process.env.ACTIONS_CACHE_SERVICE_V2 ?? "NOT SET"}`,
			].join(", ");
			yield* Effect.logDebug(`Cache env diagnostic: ${cacheEnvDiag}`);

			return yield* restoreCache({
				cachePaths: finalCachePaths,
				runtimes: runtimeEntries,
				packageManager: { name: config.packageManager.name, version: config.packageManager.version },
				lockfiles,
				...(cacheBustValue ? { cacheBust: cacheBustValue } : {}),
			});
		}).pipe(
			Effect.catchTag("CacheError", (e) =>
				Effect.gen(function* () {
					yield* Effect.logWarning(`Cache restore failed: ${e.reason}`);
					const detail = formatCauseDetail(e);
					if (detail) {
						yield* Effect.logWarning(`Cache restore cause detail: ${detail}`);
					}
					return "none" as const;
				}),
			),
		),
	);

	// 4. Install runtimes
	const installed = yield* Step.groupStep(
		"Install runtimes",
		Effect.forEach(config.runtimes, (rt) =>
			RuntimeInstaller.pipe(
				Effect.flatMap((installer) => installer.install(rt.version)),
				Effect.provide(installerLayerFor(rt.name)),
				Effect.tap((result) => Step.success(`${rt.name} ${result.version}`)),
			),
		),
	);

	// 5. Setup package manager (after runtimes are installed and on PATH)
	yield* Step.groupStep(
		`Install ${pmName} via ${pmName === "npm" ? "npm" : "corepack"}`,
		setupPackageManager(pmName, config.packageManager.version),
	);

	// 6. Install dependencies
	const installDeps = yield* ActionInput.boolean("install-deps").pipe(Config.withDefault(true));
	if (installDeps) {
		yield* Step.groupStep(`Install dependencies with ${pmName}`, installDependencies(pmName));
	}

	// 7. Install Biome (non-fatal) -- uses direct download since biome is a raw binary, not an archive
	if (Option.isSome(config.biome)) {
		const biomeVersion = config.biome.value;
		yield* Step.groupStep(
			"Install Biome",
			installBiome(biomeVersion).pipe(
				Effect.catchAll((e) =>
					Effect.logWarning(`Biome installation failed: ${e instanceof Error ? e.message : String(e)}`),
				),
			),
		);
	}

	// 8. Set outputs
	yield* setOutputs(outputs, installed, config, cacheResult, lockfiles, finalCachePaths);
	yield* outputs.set("turbo-cache-backend", turboResult.backend);
	yield* outputs.set("turbo-cache-port", turboResult.port === null ? "" : String(turboResult.port));

	// 9. Summary
	yield* Step.groupStep(
		"Runtime Setup Complete",
		Effect.gen(function* () {
			yield* Effect.log(`Runtime(s): ${config.runtimes.map((r) => `${r.name}@${r.version}`).join(", ")}`);
			for (const rt of installed) {
				yield* Effect.log(`${rt.name}: ${rt.version}`);
			}
			yield* Effect.log(`${pmName}: ${config.packageManager.version}`);
			yield* Effect.log(`Turbo: ${config.turbo ? "enabled" : "disabled"}`);
			yield* Effect.log(`Biome: ${Option.isSome(config.biome) ? `v${config.biome.value}` : "not installed"}`);
			yield* Effect.log(`Dependencies: ${installDeps ? "installed" : "skipped"}`);
		}),
	);
});
/* v8 ignore stop */
