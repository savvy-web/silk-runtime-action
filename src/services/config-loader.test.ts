import { ConfigProvider, Effect, Exit, FileSystem, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../errors/errors.js";
import { detectBiome, detectTurbo, loadPackageJson, parseDevEngines } from "./config-loader.js";

// ---------------------------------------------------------------------------
// FileSystem mock helpers
// ---------------------------------------------------------------------------

type FsFiles = Record<string, string>;
type FsExists = Set<string>;

/**
 * Creates a minimal FileSystem layer for testing.
 * - `files` maps path → content (for readFileString)
 * - `exists` is a set of accessible paths (for access); defaults to all keys in `files`
 */
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
// Helper: run detectBiome with given inputs record + FileSystem layer
// ---------------------------------------------------------------------------

const runDetectBiome = (inputs: Record<string, string>, fsLayer: Layer.Layer<FileSystem.FileSystem>) => {
	// Build a ConfigProvider that maps input names directly (no prefix transformation).
	// This simulates how ActionsConfigProvider resolves Config.string("biome-version").
	const configProvider = ConfigProvider.fromUnknown(inputs);

	return Effect.runPromise(
		Effect.provide(detectBiome.pipe(Effect.provideService(ConfigProvider.ConfigProvider, configProvider)), fsLayer),
	);
};

// ---------------------------------------------------------------------------
// loadPackageJson
// ---------------------------------------------------------------------------

describe("loadPackageJson", () => {
	it("reads and parses a valid package.json with single runtime devEngines", async () => {
		const packageJson = JSON.stringify({
			name: "my-project",
			devEngines: {
				packageManager: { name: "pnpm", version: "10.20.0", onFail: "error" },
				runtime: { name: "node", version: "24.11.0", onFail: "error" },
			},
		});

		const layer = makeFileSystemLayer({ "package.json": packageJson });
		const result = await Effect.runPromise(Effect.provide(loadPackageJson, layer));

		expect(result.packageManager.name).toBe("pnpm");
		expect(result.packageManager.version).toBe("10.20.0");
	});

	it("reads and parses a valid package.json with array runtime devEngines", async () => {
		const packageJson = JSON.stringify({
			name: "my-project",
			devEngines: {
				packageManager: { name: "bun", version: "1.3.3" },
				runtime: [
					{ name: "node", version: "24.11.0" },
					{ name: "bun", version: "1.3.3" },
				],
			},
		});

		const layer = makeFileSystemLayer({ "package.json": packageJson });
		const result = await Effect.runPromise(Effect.provide(loadPackageJson, layer));

		expect(result.packageManager.name).toBe("bun");
		expect(Array.isArray(result.runtime)).toBe(true);
	});

	it("fails with ConfigError when package.json is missing", async () => {
		const layer = makeFileSystemLayer({});
		const exit = await Effect.runPromise(Effect.exit(Effect.provide(loadPackageJson, layer)));

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails with ConfigError for invalid JSON", async () => {
		const layer = makeFileSystemLayer({ "package.json": "not valid json {{{" });
		const exit = await Effect.runPromise(Effect.exit(Effect.provide(loadPackageJson, layer)));

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails with ConfigError when devEngines field is missing", async () => {
		const layer = makeFileSystemLayer({ "package.json": JSON.stringify({ name: "my-project" }) });
		const exit = await Effect.runPromise(Effect.exit(Effect.provide(loadPackageJson, layer)));

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails with ConfigError when runtime version is a semver range", async () => {
		const packageJson = JSON.stringify({
			devEngines: {
				packageManager: { name: "pnpm", version: "10.20.0" },
				runtime: { name: "node", version: "^24.0.0" },
			},
		});

		const layer = makeFileSystemLayer({ "package.json": packageJson });
		const exit = await Effect.runPromise(Effect.exit(Effect.provide(loadPackageJson, layer)));

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("fails with ConfigError when packageManager version is a semver range", async () => {
		const packageJson = JSON.stringify({
			devEngines: {
				packageManager: { name: "pnpm", version: "~10.0.0" },
				runtime: { name: "node", version: "24.11.0" },
			},
		});

		const layer = makeFileSystemLayer({ "package.json": packageJson });
		const exit = await Effect.runPromise(Effect.exit(Effect.provide(loadPackageJson, layer)));

		expect(Exit.isFailure(exit)).toBe(true);
	});

	it("surfaces a ConfigError instance (not a generic error)", async () => {
		const layer = makeFileSystemLayer({});
		const exit = await Effect.runPromise(
			Effect.exit(Effect.provide(loadPackageJson.pipe(Effect.catch((e) => Effect.succeed(e))), layer)),
		);

		expect(Exit.isSuccess(exit)).toBe(true);
		if (Exit.isSuccess(exit)) {
			expect(exit.value).toBeInstanceOf(ConfigError);
		}
	});
});

// ---------------------------------------------------------------------------
// parseDevEngines
// ---------------------------------------------------------------------------

describe("parseDevEngines", () => {
	it("normalizes single runtime object to array", () => {
		const devEngines = {
			packageManager: { name: "pnpm", version: "10.20.0" } as const,
			runtime: { name: "node", version: "24.11.0" } as const,
		};

		const result = parseDevEngines(devEngines);
		expect(Array.isArray(result.runtime)).toBe(true);
		expect(result.runtime).toHaveLength(1);
		expect(result.runtime[0]).toEqual({ name: "node", version: "24.11.0" });
	});

	it("keeps array runtime as-is", () => {
		const devEngines = {
			packageManager: { name: "bun", version: "1.3.3" } as const,
			runtime: [{ name: "node", version: "24.11.0" } as const, { name: "bun", version: "1.3.3" } as const],
		};

		const result = parseDevEngines(devEngines);
		expect(Array.isArray(result.runtime)).toBe(true);
		expect(result.runtime).toHaveLength(2);
	});

	it("preserves packageManager unchanged", () => {
		const devEngines = {
			packageManager: { name: "pnpm", version: "10.20.0", onFail: "error" } as const,
			runtime: { name: "node", version: "24.11.0" } as const,
		};

		const result = parseDevEngines(devEngines);
		expect(result.packageManager).toEqual({ name: "pnpm", version: "10.20.0", onFail: "error" });
	});
});

// ---------------------------------------------------------------------------
// detectBiome
// ---------------------------------------------------------------------------

describe("detectBiome", () => {
	it("returns Some with version from biome.jsonc $schema URL", async () => {
		const biomeConfig = JSON.stringify({
			$schema: "https://biomejs.dev/schemas/2.3.14/schema.json",
		});

		const fsLayer = makeFileSystemLayer({ "biome.jsonc": biomeConfig });
		const result = await runDetectBiome({}, fsLayer);

		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value).toBe("2.3.14");
		}
	});

	it("returns Some with version from biome.json when biome.jsonc not present", async () => {
		const biomeConfig = JSON.stringify({
			$schema: "https://biomejs.dev/schemas/2.3.14/schema.json",
		});

		const fsLayer = makeFileSystemLayer({ "biome.json": biomeConfig }, new Set(["biome.json"]));
		const result = await runDetectBiome({}, fsLayer);

		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value).toBe("2.3.14");
		}
	});

	it("returns None when no biome config exists", async () => {
		const fsLayer = makeFileSystemLayer({});
		const result = await runDetectBiome({}, fsLayer);

		expect(Option.isNone(result)).toBe(true);
	});

	it("uses biome-version input override when provided", async () => {
		const fsLayer = makeFileSystemLayer({});
		const result = await runDetectBiome({ "biome-version": "2.0.0" }, fsLayer);

		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value).toBe("2.0.0");
		}
	});

	it("uses input override even when biome.jsonc exists", async () => {
		const biomeConfig = JSON.stringify({
			$schema: "https://biomejs.dev/schemas/1.0.0/schema.json",
		});

		const fsLayer = makeFileSystemLayer({ "biome.jsonc": biomeConfig });
		const result = await runDetectBiome({ "biome-version": "2.3.14" }, fsLayer);

		expect(Option.isSome(result)).toBe(true);
		if (Option.isSome(result)) {
			expect(result.value).toBe("2.3.14");
		}
	});
});

// ---------------------------------------------------------------------------
// detectTurbo
// ---------------------------------------------------------------------------

describe("detectTurbo", () => {
	it("returns true when turbo.json exists", async () => {
		const fsLayer = makeFileSystemLayer({ "turbo.json": "{}" });
		const result = await Effect.runPromise(Effect.provide(detectTurbo, fsLayer));

		expect(result).toBe(true);
	});

	it("returns false when turbo.json does not exist", async () => {
		const fsLayer = makeFileSystemLayer({});
		const result = await Effect.runPromise(Effect.provide(detectTurbo, fsLayer));

		expect(result).toBe(false);
	});
});
