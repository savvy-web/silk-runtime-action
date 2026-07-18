import { ActionCache, ActionOutputs, Step } from "@savvy-web/github-action-effects";
import {
	ActionCacheError,
	ActionEnvironmentTest,
	ActionLoggerTest,
	ActionOutputsTest,
	ActionStateTest,
	CommandRunnerTest,
	GlobTest,
	ToolInstallerTest,
} from "@savvy-web/github-action-effects/testing";
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Logger, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
	getActivePackageManagers,
	installBiome,
	installDependencies,
	setOutputs,
	setupPackageManager,
	turboLocalCachePaths,
} from "./program.js";
import type { PackageManager } from "./services/cache.js";
import { findLockFiles, getCombinedCacheConfig, restoreCache } from "./services/cache.js";
import { detectBiome, detectTurbo, loadPackageJson, parseDevEngines } from "./services/config-loader.js";
import { RuntimeInstaller, installerLayerFor } from "./services/runtime-installer.js";

// ---------------------------------------------------------------------------
// FileSystem mock helpers
// ---------------------------------------------------------------------------

type FsFiles = Record<string, string>;
type FsExists = Set<string>;

const makeFileSystemLayer = (
	files: FsFiles = {},
	exists: FsExists = new Set(Object.keys(files)),
): Layer.Layer<FileSystem.FileSystem> =>
	Layer.succeed(
		FileSystem.FileSystem,
		FileSystem.makeNoop({
			readFileString: (path) => {
				const content = files[path];
				if (content === undefined) {
					return Effect.fail(
						new (class extends Error {
							readonly _tag = "SystemError";
							readonly reason = "NotFound";
						})() as never,
					);
				}
				return Effect.succeed(content);
			},
			access: (path) => {
				if (exists.has(path)) {
					return Effect.succeed(undefined);
				}
				return Effect.fail(
					new (class extends Error {
						readonly _tag = "SystemError";
						readonly reason = "NotFound";
					})() as never,
				);
			},
		}),
	);

// ---------------------------------------------------------------------------
// Helper to find the last output value by name from ActionOutputsTestState
// ---------------------------------------------------------------------------

const getOutput = (state: ReturnType<typeof ActionOutputsTest.empty>, name: string): string | undefined =>
	[...state.outputs].reverse().find((o) => o.name === name)?.value;

// ---------------------------------------------------------------------------
// The test pipeline (mirrors main.ts logic, reads services from context)
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test mock type erasure at service boundary
const pipeline: Effect.Effect<void, any, any> = Effect.gen(function* () {
	const outputsSvc = yield* ActionOutputs;

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
			return { runtimes, packageManager, biome, turbo };
		}),
	);

	// 2. Cache
	const pmName = config.packageManager.name as PackageManager;
	const activePackageManagers = getActivePackageManagers(config.runtimes, pmName);

	const runtimeEntries: Array<{ name: string; version: string }> = config.runtimes.map((r) => ({
		name: r.name,
		version: r.version,
	}));
	if (Option.isSome(config.biome)) {
		runtimeEntries.push({ name: "biome", version: config.biome.value });
	}

	const cacheConfig = yield* getCombinedCacheConfig(activePackageManagers, runtimeEntries);
	const lockfiles = yield* findLockFiles(cacheConfig.lockfilePatterns);

	const finalCachePaths = [...cacheConfig.cachePaths, ...turboLocalCachePaths(config.turbo)];

	// Restore cache (non-fatal)
	const cacheResult = yield* Step.groupStep(
		"Restore cache",
		restoreCache({
			cachePaths: finalCachePaths,
			runtimes: runtimeEntries,
			packageManager: { name: config.packageManager.name, version: config.packageManager.version },
			lockfiles,
		}).pipe(Effect.catchTag("CacheError", () => Effect.succeed("none" as const))),
	);

	// 3. Install runtimes
	const installed = yield* Step.groupStep(
		"Install runtimes",
		Effect.forEach(config.runtimes, (rt) =>
			RuntimeInstaller.pipe(
				Effect.flatMap((installer) => installer.install(rt.version)),
				Effect.provide(installerLayerFor(rt.name)),
			),
		),
	);

	// 4. Install dependencies.
	// NOTE: this mirror pipeline does NOT implement the `install-deps` guard that
	// program.ts wraps around this call. Behavior of that guard (skipping install
	// when install-deps=false) is exercised by the workflow integration tests in
	// .github/workflows/test.yml and __fixtures__/, not here.
	yield* Step.groupStep("Install dependencies", installDependencies(pmName));

	// 5. Install Biome (non-fatal)
	if (Option.isSome(config.biome)) {
		yield* Step.groupStep("Install Biome", Effect.log(`Biome ${config.biome.value} (test stub)`)).pipe(
			Effect.catch(() => Effect.void),
		);
	}

	// 6. Set outputs
	yield* setOutputs(outputsSvc as never, installed, config, cacheResult, lockfiles, finalCachePaths);
});

// ---------------------------------------------------------------------------
// Test data constants
// ---------------------------------------------------------------------------

const VALID_PACKAGE_JSON = JSON.stringify({
	name: "test-project",
	devEngines: {
		packageManager: { name: "pnpm", version: "10.20.0", onFail: "error" },
		runtime: { name: "node", version: "24.11.0", onFail: "error" },
	},
});

const MULTI_RUNTIME_PACKAGE_JSON = JSON.stringify({
	name: "test-project",
	devEngines: {
		packageManager: { name: "pnpm", version: "10.20.0", onFail: "error" },
		runtime: [
			{ name: "node", version: "24.11.0", onFail: "error" },
			{ name: "bun", version: "1.3.3", onFail: "error" },
		],
	},
});

const makeConfigProvider = (inputs: Record<string, string> = {}) => ConfigProvider.fromUnknown(inputs);

// ---------------------------------------------------------------------------
// Base layer builder
// ---------------------------------------------------------------------------

const buildBaseLayer = (opts: {
	files?: FsFiles;
	inputs?: Record<string, string>;
	cacheHit?: "exact" | "partial" | "none";
	failCache?: boolean;
	cmdResponses?: Map<string, { exitCode: number; stdout: string; stderr: string }>;
	env?: Record<string, string>;
}) => {
	const outputsState = ActionOutputsTest.empty();
	const stateState = ActionStateTest.empty();

	const fsLayer = makeFileSystemLayer(
		opts.files ?? { "package.json": VALID_PACKAGE_JSON },
		new Set(Object.keys(opts.files ?? { "package.json": VALID_PACKAGE_JSON })),
	);

	const hitType = opts.cacheHit ?? "none";
	// biome-ignore lint/suspicious/noExplicitAny: test layer type erasure at service boundary
	const cacheLayer: Layer.Layer<any> = opts.failCache
		? Layer.succeed(ActionCache, {
				save: () => Effect.fail(new ActionCacheError({ key: "test", operation: "save", reason: "save failed" })),
				restore: () =>
					Effect.fail(new ActionCacheError({ key: "test", operation: "restore", reason: "restore failed" })),
			})
		: Layer.succeed(ActionCache, {
				save: () => Effect.void,
				restore: (_paths: readonly string[], key: string) => {
					if (hitType === "exact") return Effect.succeed(Option.some(key));
					if (hitType === "partial") return Effect.succeed(Option.some(`${key}-partial`));
					return Effect.succeed(Option.none());
				},
			});

	const layer = Layer.mergeAll(
		ActionOutputsTest.layer(outputsState),
		ActionLoggerTest.layer(ActionLoggerTest.empty()),
		cacheLayer,
		ActionStateTest.layer(stateState),
		ActionEnvironmentTest.layer(opts.env ?? { GITHUB_REF: "refs/heads/main" }),
		opts.cmdResponses ? CommandRunnerTest.layer(opts.cmdResponses) : CommandRunnerTest.empty(),
		ToolInstallerTest.layer(ToolInstallerTest.empty()),
		GlobTest.layer(GlobTest.empty()),
		fsLayer,
	);

	return {
		layer,
		outputsState,
		configProvider: makeConfigProvider(opts.inputs ?? {}),
	};
};

/** Run the pipeline with given layers and config provider. */
// biome-ignore lint/suspicious/noExplicitAny: test layer type erasure at service boundary
const runPipeline = (layer: Layer.Layer<any>, configProvider: ConfigProvider.ConfigProvider) =>
	Effect.runPromise(
		(pipeline as Effect.Effect<void, never, never>).pipe(
			Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
			Effect.provide(layer),
			Effect.provide(Logger.layer([])),
		),
	);

/** Run the pipeline and return its Exit for failure assertions. */
// biome-ignore lint/suspicious/noExplicitAny: test layer type erasure at service boundary
const runPipelineExit = (layer: Layer.Layer<any>, configProvider: ConfigProvider.ConfigProvider) =>
	Effect.runPromise(
		Effect.exit(
			(pipeline as Effect.Effect<void, never, never>).pipe(
				Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
				Effect.provide(layer),
				Effect.provide(Logger.layer([])),
			),
		),
	);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("main pipeline", () => {
	it("full pipeline with valid config sets all outputs correctly", async () => {
		const { layer, outputsState, configProvider } = buildBaseLayer({
			cacheHit: "exact",
		});

		await runPipeline(layer, configProvider);

		expect(getOutput(outputsState, "node-version")).toBe("24.11.0");
		expect(getOutput(outputsState, "node-enabled")).toBe("true");
		expect(getOutput(outputsState, "bun-version")).toBe("");
		expect(getOutput(outputsState, "bun-enabled")).toBe("false");
		expect(getOutput(outputsState, "deno-version")).toBe("");
		expect(getOutput(outputsState, "deno-enabled")).toBe("false");
		expect(getOutput(outputsState, "package-manager")).toBe("pnpm");
		expect(getOutput(outputsState, "package-manager-version")).toBe("10.20.0");
		expect(getOutput(outputsState, "biome-enabled")).toBe("false");
		expect(getOutput(outputsState, "turbo-enabled")).toBe("false");
	});

	// Removed: "install-deps=false skips dependency installation"
	// — the mirror pipeline above does not implement the install-deps guard
	// (that lives in program.ts), so the previous test only checked that two
	// outputs were set, which would have been true with or without the guard.
	// Coverage of the production install-deps branch belongs to the workflow
	// integration tests in .github/workflows/test.yml + __fixtures__/.

	it("biome install failure does not fail the action (non-fatal)", async () => {
		const biomeConfig = JSON.stringify({
			$schema: "https://biomejs.dev/schemas/2.3.14/schema.json",
		});

		const { layer, outputsState, configProvider } = buildBaseLayer({
			files: {
				"package.json": VALID_PACKAGE_JSON,
				"biome.jsonc": biomeConfig,
			},
		});

		await runPipeline(layer, configProvider);

		expect(getOutput(outputsState, "biome-enabled")).toBe("true");
		expect(getOutput(outputsState, "biome-version")).toBe("2.3.14");
		expect(getOutput(outputsState, "node-version")).toBe("24.11.0");
	});

	it("cache restore failure does not fail the action (non-fatal)", async () => {
		const { layer, outputsState, configProvider } = buildBaseLayer({
			failCache: true,
		});

		await runPipeline(layer, configProvider);

		expect(getOutput(outputsState, "cache-hit")).toBe("false");
		expect(getOutput(outputsState, "node-version")).toBe("24.11.0");
	});

	it("missing package.json fails with ConfigError", async () => {
		const { layer, configProvider } = buildBaseLayer({
			files: {},
		});

		const exit = await runPipelineExit(layer, configProvider);

		expect(Exit.isFailure(exit)).toBe(true);
	});

	describe("outputs map cache hit correctly", () => {
		it("exact cache hit maps to 'true'", async () => {
			const { layer, outputsState, configProvider } = buildBaseLayer({
				cacheHit: "exact",
			});

			await runPipeline(layer, configProvider);
			expect(getOutput(outputsState, "cache-hit")).toBe("true");
		});

		it("partial cache hit maps to 'partial'", async () => {
			const { layer, outputsState, configProvider } = buildBaseLayer({
				cacheHit: "partial",
			});

			await runPipeline(layer, configProvider);
			expect(getOutput(outputsState, "cache-hit")).toBe("partial");
		});

		it("no cache hit maps to 'false'", async () => {
			const { layer, outputsState, configProvider } = buildBaseLayer({
				cacheHit: "none",
			});

			await runPipeline(layer, configProvider);
			expect(getOutput(outputsState, "cache-hit")).toBe("false");
		});
	});

	it("multi-runtime config installs all runtimes and sets outputs", async () => {
		const { layer, outputsState, configProvider } = buildBaseLayer({
			files: { "package.json": MULTI_RUNTIME_PACKAGE_JSON },
		});

		await runPipeline(layer, configProvider);

		expect(getOutput(outputsState, "node-version")).toBe("24.11.0");
		expect(getOutput(outputsState, "node-enabled")).toBe("true");
		expect(getOutput(outputsState, "bun-version")).toBe("1.3.3");
		expect(getOutput(outputsState, "bun-enabled")).toBe("true");
		expect(getOutput(outputsState, "package-manager")).toBe("pnpm");
	});
});

// ---------------------------------------------------------------------------
// getActivePackageManagers tests
// ---------------------------------------------------------------------------

describe("turboLocalCachePaths", () => {
	it("caches .turbo/cache when turbo is detected", () => {
		expect(turboLocalCachePaths(true)).toEqual(["**/.turbo/cache"]);
	});

	it("excludes .turbo/runs and other subdirectories (only .turbo/cache)", () => {
		const paths = turboLocalCachePaths(true);
		expect(paths.some((p) => p.includes(".turbo/runs"))).toBe(false);
		expect(paths).toEqual(["**/.turbo/cache"]);
	});

	it("is empty when turbo is not detected", () => {
		expect(turboLocalCachePaths(false)).toEqual([]);
	});
});

describe("getActivePackageManagers", () => {
	it("includes primary PM for node runtime", () => {
		const result = getActivePackageManagers([{ name: "node", version: "24.9.0" }] as never, "pnpm");
		expect(result).toContain("pnpm");
	});

	it("includes bun for bun runtime", () => {
		const result = getActivePackageManagers([{ name: "bun", version: "1.3.3" }] as never, "pnpm");
		expect(result).toContain("bun");
	});

	it("includes deno for deno runtime", () => {
		const result = getActivePackageManagers([{ name: "deno", version: "2.5.6" }] as never, "pnpm");
		expect(result).toContain("deno");
	});

	it("deduplicates when bun is both runtime and PM", () => {
		const result = getActivePackageManagers([{ name: "bun", version: "1.3.3" }] as never, "bun");
		expect(result).toEqual(["bun"]);
	});

	it("handles multi-runtime", () => {
		const result = getActivePackageManagers(
			[
				{ name: "node", version: "24.9.0" },
				{ name: "deno", version: "2.5.6" },
			] as never,
			"npm",
		);
		expect(result).toContain("npm");
		expect(result).toContain("deno");
	});
});

// ---------------------------------------------------------------------------
// installDependencies branch coverage
// ---------------------------------------------------------------------------

describe("installDependencies", () => {
	const runInstallDeps = (
		pm: PackageManager,
		files: Record<string, boolean>,
		responses: Map<string, { exitCode: number; stdout: string; stderr: string }>,
	) => {
		const cmdLayer = CommandRunnerTest.layer(responses);
		const fsLayer = Layer.succeed(FileSystem.FileSystem, {
			access: (path: string) => (files[path] ? Effect.void : Effect.fail("not found")),
		} as unknown as FileSystem.FileSystem);
		const layer = Layer.mergeAll(cmdLayer, fsLayer);
		return Effect.runPromise(
			(installDependencies(pm) as Effect.Effect<void, unknown, never>).pipe(
				Effect.provide(layer as never),
				Effect.provide(Logger.layer([])),
			),
		);
	};

	it("runs bun install for bun PM (no lockfile)", async () => {
		await runInstallDeps("bun", {}, new Map([["bun install", { exitCode: 0, stdout: "", stderr: "" }]]));
	});

	it("runs bun install --frozen-lockfile with bun.lock", async () => {
		await runInstallDeps(
			"bun",
			{ "bun.lock": true },
			new Map([["bun install --frozen-lockfile", { exitCode: 0, stdout: "", stderr: "" }]]),
		);
	});

	it("runs npm ci with package-lock.json", async () => {
		await runInstallDeps(
			"npm",
			{ "package-lock.json": true },
			new Map([["npm ci", { exitCode: 0, stdout: "", stderr: "" }]]),
		);
	});

	it("runs npm install without lockfile", async () => {
		await runInstallDeps("npm", {}, new Map([["npm install", { exitCode: 0, stdout: "", stderr: "" }]]));
	});

	it("runs pnpm install --frozen-lockfile with pnpm-lock.yaml", async () => {
		await runInstallDeps(
			"pnpm",
			{ "pnpm-lock.yaml": true },
			new Map([["pnpm install --frozen-lockfile", { exitCode: 0, stdout: "", stderr: "" }]]),
		);
	});

	it("runs pnpm install without lockfile", async () => {
		await runInstallDeps("pnpm", {}, new Map([["pnpm install", { exitCode: 0, stdout: "", stderr: "" }]]));
	});

	it("runs yarn install --immutable with yarn.lock", async () => {
		await runInstallDeps(
			"yarn",
			{ "yarn.lock": true },
			new Map([["yarn install --immutable", { exitCode: 0, stdout: "", stderr: "" }]]),
		);
	});

	it("runs yarn install --no-immutable without lockfile", async () => {
		await runInstallDeps(
			"yarn",
			{},
			new Map([["yarn install --no-immutable", { exitCode: 0, stdout: "", stderr: "" }]]),
		);
	});
});

// ---------------------------------------------------------------------------
// setupPackageManager tests
// ---------------------------------------------------------------------------

describe("setupPackageManager", () => {
	const runSetup = (
		pm: PackageManager,
		version: string,
		responses: Map<string, { exitCode: number; stdout: string; stderr: string }>,
	) =>
		Effect.runPromise(
			(setupPackageManager(pm, version) as Effect.Effect<void, unknown, never>).pipe(
				Effect.provide(CommandRunnerTest.layer(responses) as never),
				Effect.provide(Logger.layer([])),
			),
		);

	it("skips setup for bun", async () => {
		await runSetup("bun", "1.3.3", new Map());
	});

	it("skips setup for deno", async () => {
		await runSetup("deno", "2.5.6", new Map());
	});

	it("runs corepack for pnpm", async () => {
		const responses = new Map([
			["node --version", { exitCode: 0, stdout: "v24.9.0\n", stderr: "" }],
			["corepack enable", { exitCode: 0, stdout: "", stderr: "" }],
			["corepack prepare pnpm@10.20.0 --activate", { exitCode: 0, stdout: "", stderr: "" }],
			["pnpm --version", { exitCode: 0, stdout: "10.20.0\n", stderr: "" }],
		]);
		await runSetup("pnpm", "10.20.0", responses);
	});

	it("runs corepack for yarn", async () => {
		const responses = new Map([
			["node --version", { exitCode: 0, stdout: "v24.9.0\n", stderr: "" }],
			["corepack enable", { exitCode: 0, stdout: "", stderr: "" }],
			["corepack prepare yarn@4.6.0 --activate", { exitCode: 0, stdout: "", stderr: "" }],
			["yarn --version", { exitCode: 0, stdout: "4.6.0\n", stderr: "" }],
		]);
		await runSetup("yarn", "4.6.0", responses);
	});

	it("runs npm install -g for npm when version differs", async () => {
		const responses = new Map([
			["npm --version", { exitCode: 0, stdout: "10.8.2\n", stderr: "" }],
			["sudo npm install -g npm@11.6.0", { exitCode: 0, stdout: "", stderr: "" }],
			["sudo chown -R", { exitCode: 0, stdout: "", stderr: "" }],
		]);
		await runSetup("npm", "11.6.0", responses);
	});

	it("skips npm install when version already matches", async () => {
		const responses = new Map([["npm --version", { exitCode: 0, stdout: "11.6.0\n", stderr: "" }]]);
		await runSetup("npm", "11.6.0", responses);
	});

	it("runs npm install -g without sudo on windows", async () => {
		const origPlatform = process.platform;
		Object.defineProperty(process, "platform", { value: "win32", writable: true });
		try {
			const responses = new Map([
				["npm --version", { exitCode: 0, stdout: "10.8.2\n", stderr: "" }],
				["npm install -g npm@11.6.0", { exitCode: 0, stdout: "", stderr: "" }],
			]);
			await runSetup("npm", "11.6.0", responses);
		} finally {
			Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
		}
	});

	it("installs corepack for Node >= 25", async () => {
		const responses = new Map([
			["node --version", { exitCode: 0, stdout: "v25.0.0\n", stderr: "" }],
			["sudo npm install -g --force corepack@latest", { exitCode: 0, stdout: "", stderr: "" }],
			["corepack enable", { exitCode: 0, stdout: "", stderr: "" }],
			["corepack prepare pnpm@10.20.0 --activate", { exitCode: 0, stdout: "", stderr: "" }],
			["pnpm --version", { exitCode: 0, stdout: "10.20.0\n", stderr: "" }],
		]);
		await runSetup("pnpm", "10.20.0", responses);
	});
});

// ---------------------------------------------------------------------------
// installBiome tests (stub — real impl uses ToolInstaller primitives)
// ---------------------------------------------------------------------------

describe("installBiome", () => {
	it("is exported and callable", () => {
		expect(typeof installBiome).toBe("function");
	});
});
