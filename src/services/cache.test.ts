import { platform } from "node:os";
import { ActionCache } from "@savvy-web/github-action-effects";
import {
	ActionCacheTest,
	ActionEnvironmentTest,
	ActionStateTest,
	CommandRunnerTest,
	GlobTest,
} from "@savvy-web/github-action-effects/testing";
import { Effect, Layer, Logger, Option } from "effect";
import { describe, expect, it } from "vitest";
import {
	buildLockfileGlobPatterns,
	detectCachePath,
	findLockFiles,
	generateCacheKey,
	generateRestoreKeys,
	getCombinedCacheConfig,
	getDefaultCachePaths,
	getLockfilePatterns,
	restoreCache,
	saveCache,
} from "./cache.js";

// ---------------------------------------------------------------------------
// Helpers — cast all layers to Layer.Layer<never> so Effect.provide is happy
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test mock requires any for mocked service tags
type AnyLayer = Layer.Layer<any>;
const asLayer = (l: AnyLayer): Layer.Layer<never> => l as Layer.Layer<never>;

// biome-ignore lint/suspicious/noExplicitAny: test mock requires any for mocked effect results
const run = <A>(effect: Effect.Effect<A, any, any>, layer: AnyLayer): Promise<A> =>
	Effect.runPromise(
		effect.pipe(Effect.provide(asLayer(layer)), Effect.provide(Logger.layer([]))) as Effect.Effect<A, never, never>,
	);

// ---------------------------------------------------------------------------
// Glob mock helper
// ---------------------------------------------------------------------------

/**
 * Build the exact patterns string that findLockFiles passes to glob.glob.
 * Uses the real implementation (no mirror) so excludes can't drift.
 */
const findLockFilesGlobKey = (patterns: string[]): string => buildLockfileGlobPatterns(patterns);

/**
 * Build the exact patterns string that hashFiles passes to glob.hashFiles.
 * Mirrors the implementation in cache.ts.
 */
const hashFilesGlobKey = (files: string[]): string => files.join("\n");

/**
 * Creates a GlobTest layer with pre-seeded lock-file matches and a default
 * "aaaaaaaa" hash for any patterns string that contains those file paths.
 */
const makeGlobLayer = (
	lockfileMatches: Record<string, ReadonlyArray<string>> = {},
	hashes: Record<string, string> = {},
): AnyLayer => {
	const state = GlobTest.empty();
	for (const [key, matches] of Object.entries(lockfileMatches)) {
		state.matches.set(key, matches);
	}
	for (const [key, hash] of Object.entries(hashes)) {
		state.hashes.set(key, hash);
	}
	return GlobTest.layer(state);
};

/**
 * GlobTest layer that returns an empty match set for any patterns.
 * Suitable for tests that only need hash support or no lock files.
 */
const emptyGlobLayer = (): AnyLayer => GlobTest.layer(GlobTest.empty());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getDefaultCachePaths", () => {
	it("returns correct paths for npm", () => {
		const paths = getDefaultCachePaths("npm");
		expect(paths.length).toBeGreaterThan(0);
		expect(paths.some((p) => p.includes("npm"))).toBe(true);
	});

	it("returns correct paths for pnpm", () => {
		const paths = getDefaultCachePaths("pnpm");
		expect(paths.some((p) => p.includes("pnpm"))).toBe(true);
	});

	it("returns correct paths for yarn", () => {
		const paths = getDefaultCachePaths("yarn");
		expect(paths.length).toBe(2);
		expect(paths.some((p) => p.includes("yarn") || p.includes("Yarn"))).toBe(true);
	});

	it("returns correct paths for bun", () => {
		const paths = getDefaultCachePaths("bun");
		expect(paths.some((p) => p.includes("bun"))).toBe(true);
	});

	it("returns correct paths for deno", () => {
		const paths = getDefaultCachePaths("deno");
		expect(paths.some((p) => p.includes("deno"))).toBe(true);
	});
});

describe("getLockfilePatterns", () => {
	it("returns package-lock.json and npm-shrinkwrap.json for npm", () => {
		const patterns = getLockfilePatterns("npm");
		expect(patterns).toContain("**/package-lock.json");
		expect(patterns).toContain("**/npm-shrinkwrap.json");
	});

	it("returns pnpm-lock.yaml for pnpm", () => {
		const patterns = getLockfilePatterns("pnpm");
		expect(patterns).toContain("**/pnpm-lock.yaml");
	});

	it("returns yarn.lock for yarn", () => {
		const patterns = getLockfilePatterns("yarn");
		expect(patterns).toContain("**/yarn.lock");
	});

	it("returns bun.lock and bun.lockb for bun", () => {
		const patterns = getLockfilePatterns("bun");
		expect(patterns).toContain("**/bun.lock");
		expect(patterns).toContain("**/bun.lockb");
	});

	it("returns deno.lock for deno", () => {
		const patterns = getLockfilePatterns("deno");
		expect(patterns).toContain("**/deno.lock");
	});
});

describe("generateCacheKey", () => {
	const runtimes = [{ name: "node", version: "24.11.0" }];
	const pm = { name: "pnpm", version: "10.20.0" };
	// Hash seeded for the exact files string passed by hashFiles(["pnpm-lock.yaml"])
	const pnpmLockHash = "abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234";
	const pnpmLockGlobKey = hashFilesGlobKey(["pnpm-lock.yaml"]);

	const baseLayer = Layer.mergeAll(
		makeGlobLayer({}, { [pnpmLockGlobKey]: pnpmLockHash }),
		ActionEnvironmentTest.layer({ GITHUB_REF: "refs/heads/main" }),
	);

	it("produces correct format: {os}-{versionHash}-{branchHash}-{lockfileHash}", async () => {
		const key = await run(generateCacheKey(runtimes, pm, ["pnpm-lock.yaml"]), baseLayer);

		expect(key).toMatch(/^[a-z0-9]+-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{8}$/);
		expect(key.startsWith(platform())).toBe(true);
	});

	it("produces different keys for different versions", async () => {
		const key1 = await run(generateCacheKey(runtimes, pm, ["pnpm-lock.yaml"]), baseLayer);

		const key2 = await run(generateCacheKey([{ name: "node", version: "22.0.0" }], pm, ["pnpm-lock.yaml"]), baseLayer);

		expect(key1).not.toBe(key2);
	});

	it("produces different keys for different branches", async () => {
		const globLayer = makeGlobLayer({}, { [pnpmLockGlobKey]: pnpmLockHash });

		const layer1 = Layer.mergeAll(globLayer, ActionEnvironmentTest.layer({ GITHUB_REF: "refs/heads/main" }));

		const layer2 = Layer.mergeAll(globLayer, ActionEnvironmentTest.layer({ GITHUB_REF: "refs/heads/feature" }));

		const key1 = await run(generateCacheKey(runtimes, pm, ["pnpm-lock.yaml"]), layer1);
		const key2 = await run(generateCacheKey(runtimes, pm, ["pnpm-lock.yaml"]), layer2);

		expect(key1).not.toBe(key2);
	});

	it("falls back to empty string when GITHUB_REF is not a heads ref", async () => {
		const layer = Layer.mergeAll(
			makeGlobLayer({}, { [pnpmLockGlobKey]: pnpmLockHash }),
			ActionEnvironmentTest.layer({ GITHUB_REF: "refs/tags/v1.0.0" }),
		);

		// Should still produce a key (with empty branch hashed)
		const key = await run(generateCacheKey(runtimes, pm, ["pnpm-lock.yaml"]), layer);
		expect(key).toMatch(/^[a-z]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$/);
	});

	it("falls back to empty string when neither GITHUB_HEAD_REF nor GITHUB_REF is set", async () => {
		const layer = Layer.mergeAll(
			makeGlobLayer({}, { [pnpmLockGlobKey]: pnpmLockHash }),
			ActionEnvironmentTest.layer({}),
		);

		const key = await run(generateCacheKey(runtimes, pm, ["pnpm-lock.yaml"]), layer);
		expect(key).toMatch(/^[a-z]+-[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$/);
	});

	it("treats empty GITHUB_HEAD_REF as absent", async () => {
		const globLayer = makeGlobLayer({}, { [pnpmLockGlobKey]: pnpmLockHash });

		const layer = Layer.mergeAll(
			globLayer,
			ActionEnvironmentTest.layer({ GITHUB_HEAD_REF: "", GITHUB_REF: "refs/heads/main" }),
		);

		const mainLayer = Layer.mergeAll(globLayer, ActionEnvironmentTest.layer({ GITHUB_REF: "refs/heads/main" }));

		const key1 = await run(generateCacheKey(runtimes, pm, ["pnpm-lock.yaml"]), layer);
		const key2 = await run(generateCacheKey(runtimes, pm, ["pnpm-lock.yaml"]), mainLayer);
		expect(key1).toBe(key2);
	});

	it("uses GITHUB_HEAD_REF for PRs over GITHUB_REF", async () => {
		const globLayer = makeGlobLayer({}, { [pnpmLockGlobKey]: pnpmLockHash });

		const prLayer = Layer.mergeAll(
			globLayer,
			ActionEnvironmentTest.layer({
				GITHUB_HEAD_REF: "pr-branch",
				GITHUB_REF: "refs/heads/main",
			}),
		);

		const mainLayer = Layer.mergeAll(globLayer, ActionEnvironmentTest.layer({ GITHUB_REF: "refs/heads/main" }));

		const prKey = await run(generateCacheKey(runtimes, pm, ["pnpm-lock.yaml"]), prLayer);
		const mainKey = await run(generateCacheKey(runtimes, pm, ["pnpm-lock.yaml"]), mainLayer);

		expect(prKey).not.toBe(mainKey);
	});
});

describe("restoreCache", () => {
	const runtimes = [{ name: "node", version: "24.11.0" }];
	const pm = { name: "pnpm", version: "10.20.0" };
	const cachePaths = ["/home/runner/.local/share/pnpm/store", "**/node_modules"];

	it("returns 'exact' when primary key matches and saves state", async () => {
		const state = ActionStateTest.empty();

		// Cache that returns the primary key verbatim — simulates exact hit
		const exactCacheLayer = Layer.succeed(ActionCache, {
			save: () => Effect.void,
			restore: (_paths: readonly string[], key: string) => Effect.succeed(Option.some(key)),
		});

		const fullLayer = Layer.mergeAll(
			emptyGlobLayer(),
			ActionEnvironmentTest.layer({ GITHUB_REF: "refs/heads/main" }),
			exactCacheLayer,
			ActionStateTest.layer(state),
		);

		const result = await run(restoreCache({ cachePaths, runtimes, packageManager: pm, lockfiles: [] }), fullLayer);

		expect(result).toBe("exact");
		expect(state.entries.has("cache-state")).toBe(true);
		const saved = JSON.parse(state.entries.get("cache-state") ?? "{}");
		expect(saved.restored).toBe(true);
	});

	it("returns 'partial' when restore key matches", async () => {
		const state = ActionStateTest.empty();

		// Cache that returns a different key — simulates partial hit
		const partialCacheLayer = Layer.succeed(ActionCache, {
			save: () => Effect.void,
			restore: () => Effect.succeed(Option.some("some-other-key")),
		});

		const layer = Layer.mergeAll(
			emptyGlobLayer(),
			ActionEnvironmentTest.layer({ GITHUB_REF: "refs/heads/main" }),
			partialCacheLayer,
			ActionStateTest.layer(state),
		);

		const result = await run(restoreCache({ cachePaths, runtimes, packageManager: pm, lockfiles: [] }), layer);

		expect(result).toBe("partial");
		const saved = JSON.parse(state.entries.get("cache-state") ?? "{}");
		expect(saved.restored).toBe(false);
	});

	it("uses cacheBust parameter when provided", async () => {
		const state = ActionStateTest.empty();
		const cache = ActionCacheTest.empty();

		const layer = Layer.mergeAll(
			emptyGlobLayer(),
			ActionEnvironmentTest.layer({ GITHUB_REF: "refs/heads/main" }),
			ActionCacheTest.layer(cache),
			ActionStateTest.layer(state),
		);

		const result = await run(
			restoreCache({ cachePaths, runtimes, packageManager: pm, lockfiles: [], cacheBust: "test-bust-value" }),
			layer,
		);

		expect(result).toBe("none");
		// cacheBust changes the key, so state should still be saved
		expect(state.entries.has("cache-state")).toBe(true);
	});

	it("returns 'none' when no cache matches", async () => {
		const state = ActionStateTest.empty();
		const cache = ActionCacheTest.empty();

		const layer = Layer.mergeAll(
			emptyGlobLayer(),
			ActionEnvironmentTest.layer({ GITHUB_REF: "refs/heads/main" }),
			ActionCacheTest.layer(cache),
			ActionStateTest.layer(state),
		);

		const result = await run(restoreCache({ cachePaths, runtimes, packageManager: pm, lockfiles: [] }), layer);

		expect(result).toBe("none");
		const saved = JSON.parse(state.entries.get("cache-state") ?? "{}");
		expect(saved.restored).toBe(false);
	});
});

describe("saveCache", () => {
	it("saves when restored is false (partial hit)", async () => {
		const cache = ActionCacheTest.empty();
		const state = ActionStateTest.empty();
		state.entries.set("cache-state", JSON.stringify({ key: "test-key", paths: ["/cache/path"], restored: false }));

		const layer = Layer.mergeAll(ActionCacheTest.layer(cache), ActionStateTest.layer(state));

		await run(saveCache(), layer);

		expect(cache.entries.has("test-key")).toBe(true);
		expect(cache.entries.get("test-key")).toEqual(["/cache/path"]);
	});

	it("saves when restored is false (cache miss)", async () => {
		const cache = ActionCacheTest.empty();
		const state = ActionStateTest.empty();
		state.entries.set("cache-state", JSON.stringify({ key: "test-key", paths: ["/cache/path"], restored: false }));

		const layer = Layer.mergeAll(ActionCacheTest.layer(cache), ActionStateTest.layer(state));

		await run(saveCache(), layer);

		expect(cache.entries.size).toBe(1);
	});

	it("skips when restored is true (exact hit)", async () => {
		const cache = ActionCacheTest.empty();
		const state = ActionStateTest.empty();
		state.entries.set("cache-state", JSON.stringify({ key: "test-key", paths: ["/cache/path"], restored: true }));

		const layer = Layer.mergeAll(ActionCacheTest.layer(cache), ActionStateTest.layer(state));

		await run(saveCache(), layer);

		expect(cache.entries.size).toBe(0);
	});

	it("skips when paths is empty", async () => {
		const cache = ActionCacheTest.empty();
		const state = ActionStateTest.empty();
		state.entries.set("cache-state", JSON.stringify({ key: "test-key", paths: [], restored: false }));

		const layer = Layer.mergeAll(ActionCacheTest.layer(cache), ActionStateTest.layer(state));

		await run(saveCache(), layer);

		expect(cache.entries.size).toBe(0);
	});
});

describe("getCombinedCacheConfig", () => {
	it("deduplicates paths across multiple package managers", async () => {
		const layer = CommandRunnerTest.empty();

		const config = await run(getCombinedCacheConfig(["npm", "pnpm"]), layer);

		const nodeModulesCount = config.cachePaths.filter((p: string) => p === "**/node_modules").length;
		expect(nodeModulesCount).toBe(1);
	});

	it("includes tool cache paths for runtimes", async () => {
		const layer = CommandRunnerTest.empty();
		const runtimes = [{ name: "node", version: "24.11.0" }];

		const config = await run(getCombinedCacheConfig(["pnpm"], runtimes), layer);

		const hasToolCache = config.cachePaths.some((p: string) => p.includes("hostedtoolcache/node/24.11.0"));
		expect(hasToolCache).toBe(true);
	});

	it("sorts paths with absolute paths first, then globs", async () => {
		const layer = CommandRunnerTest.empty();

		const config = await run(getCombinedCacheConfig(["pnpm"]), layer);

		const firstGlobIdx = config.cachePaths.findIndex((p: string) => p.startsWith("*"));
		// Find last absolute path index by iterating
		let lastAbsoluteIdx = -1;
		for (let i = config.cachePaths.length - 1; i >= 0; i--) {
			if (!config.cachePaths[i].startsWith("*")) {
				lastAbsoluteIdx = i;
				break;
			}
		}

		if (firstGlobIdx !== -1 && lastAbsoluteIdx !== -1) {
			expect(lastAbsoluteIdx).toBeLessThan(firstGlobIdx);
		}
	});
});

describe("detectCachePath", () => {
	it("returns detected path from pnpm store path command", async () => {
		const layer = CommandRunnerTest.layer(
			new Map([["pnpm store path", { exitCode: 0, stdout: "/home/runner/.local/share/pnpm/store\n", stderr: "" }]]),
		);

		const result = await run(detectCachePath("pnpm"), layer);

		expect(result).toBe("/home/runner/.local/share/pnpm/store");
	});

	it("falls back to null on command failure", async () => {
		// Use empty responses so all commands return exitCode 0 with empty stdout
		// To simulate failure, use a layer where all commands return non-zero
		const layer = CommandRunnerTest.layer(
			new Map([["pnpm store path", { exitCode: 1, stdout: "", stderr: "command failed" }]]),
		);

		const result = await run(detectCachePath("pnpm"), layer);

		expect(result).toBeNull();
	});

	it("returns detected path for npm", async () => {
		const layer = CommandRunnerTest.layer(
			new Map([["npm config get cache", { exitCode: 0, stdout: "/home/runner/.npm\n", stderr: "" }]]),
		);

		const result = await run(detectCachePath("npm"), layer);

		expect(result).toBe("/home/runner/.npm");
	});

	it("returns detected path for yarn Berry", async () => {
		const layer = CommandRunnerTest.layer(
			new Map([["yarn config get cacheFolder", { exitCode: 0, stdout: "/home/runner/.yarn/cache\n", stderr: "" }]]),
		);

		const result = await run(detectCachePath("yarn"), layer);

		expect(result).toBe("/home/runner/.yarn/cache");
	});

	it("returns detected path for bun", async () => {
		const layer = CommandRunnerTest.layer(
			new Map([["bun pm cache", { exitCode: 0, stdout: "/home/runner/.bun/install/cache\n", stderr: "" }]]),
		);

		const result = await run(detectCachePath("bun"), layer);

		expect(result).toBe("/home/runner/.bun/install/cache");
	});

	it("parses deno info --json for denoDir", async () => {
		const layer = CommandRunnerTest.layer(
			new Map([
				[
					"deno info --json",
					{ exitCode: 0, stdout: JSON.stringify({ denoDir: "/home/runner/.cache/deno" }), stderr: "" },
				],
			]),
		);

		const result = await run(detectCachePath("deno"), layer);

		expect(result).toBe("/home/runner/.cache/deno");
	});
});

describe("findLockFiles", () => {
	it("finds lockfiles that exist via glob patterns", async () => {
		const patternsKey = findLockFilesGlobKey(["pnpm-lock.yaml"]);
		const layer = makeGlobLayer({ [patternsKey]: ["pnpm-lock.yaml"] });
		const result = await run(findLockFiles(["pnpm-lock.yaml"]), layer);
		expect(result).toContain("pnpm-lock.yaml");
	});

	it("finds lockfiles with glob wildcards", async () => {
		const patternsKey = findLockFilesGlobKey(["**/pnpm-lock.yaml"]);
		const layer = makeGlobLayer({ [patternsKey]: ["/repo/pnpm-lock.yaml"] });
		const result = await run(findLockFiles(["**/pnpm-lock.yaml"]), layer);
		expect(result.length).toBeGreaterThan(0);
		expect(result.some((f) => f === "pnpm-lock.yaml" || f.endsWith("/pnpm-lock.yaml"))).toBe(true);
	});

	it("returns empty array when no lockfiles match", async () => {
		const layer = emptyGlobLayer();
		const result = await run(findLockFiles(["nonexistent-lockfile-xyz.lock"]), layer);
		expect(result).toEqual([]);
	});

	it("excludes node_modules, .git, and test/fixture trees from discovery", () => {
		const patternsStr = buildLockfileGlobPatterns(["**/pnpm-lock.yaml"]);
		expect(patternsStr).toContain("**/pnpm-lock.yaml");
		expect(patternsStr).toContain("!**/node_modules/**");
		expect(patternsStr).toContain("!**/.git/**");
		expect(patternsStr).toContain("!**/__fixtures__/**");
		expect(patternsStr).toContain("!**/__test__/**");
		expect(patternsStr).toContain("!**/__tests__/**");
	});

	it("deduplicates results across overlapping patterns", async () => {
		// GlobLive deduplicates via Set; GlobTest returns whatever we seed.
		// Seed with a single entry to verify the caller doesn't double-count.
		const patternsKey = findLockFilesGlobKey(["pnpm-lock.yaml", "pnpm-lock.yaml"]);
		const layer = makeGlobLayer({ [patternsKey]: ["pnpm-lock.yaml"] });
		const result = await run(findLockFiles(["pnpm-lock.yaml", "pnpm-lock.yaml"]), layer);
		const pnpmCount = result.filter((f) => f === "pnpm-lock.yaml").length;
		expect(pnpmCount).toBeLessThanOrEqual(1);
	});
});

describe("generateRestoreKeys", () => {
	const runtimes = [{ name: "node", version: "24.11.0" }];
	const pm = { name: "pnpm", version: "10.20.0" };

	it("returns restore key prefixes", async () => {
		const layer = ActionEnvironmentTest.layer({ GITHUB_REF: "refs/heads/main" });

		const keys = await run(generateRestoreKeys(runtimes, pm), layer);

		expect(keys).toHaveLength(2);
		expect(keys[0]).toMatch(new RegExp(`^${platform()}-[a-f0-9]{8}-[a-f0-9]{8}-$`));
		expect(keys[1]).toMatch(new RegExp(`^${platform()}-[a-f0-9]{8}-$`));
	});

	it("returns empty array when cacheBust is set", async () => {
		const layer = ActionEnvironmentTest.layer({ GITHUB_REF: "refs/heads/main" });

		const keys = await run(generateRestoreKeys(runtimes, pm, "test-bust"), layer);

		expect(keys).toEqual([]);
	});
});
