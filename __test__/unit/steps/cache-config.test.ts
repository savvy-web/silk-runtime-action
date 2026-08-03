import { describe, expect, it } from "@effect/vitest";
import { CacheKey } from "@effected/github-actions";
import { Option } from "effect";

import { RuntimeConfig } from "../../../src/schema/domain.js";
import {
	EMPTY_LOCKFILE_SEGMENT,
	LOCKFILE_EXCLUSIONS,
	RESTORE_DEPTHS,
	TURBO_LOCAL_CACHE_PATHS,
	activePackageManagers,
	cachePaths,
	defaultToolCacheBase,
	keySegments,
	lockfilePatterns,
} from "../../../src/steps/cache-config.js";

/** A `devEngines` config, spelled as briefly as the helpers need it. */
const config = (packageManager: { name: string; version: string }, ...runtimes: ReadonlyArray<string>): RuntimeConfig =>
	RuntimeConfig.make({
		packageManager: { name: packageManager.name as "npm", version: packageManager.version },
		runtimes: runtimes.map((name) => ({ name: name as "node", version: "1.0.0" })) as [
			{ name: "node"; version: string },
		],
	});

/** The five exclusions, verbatim (oracle 5). */
const EXCLUSIONS = ["!**/node_modules/**", "!**/.git/**", "!**/__fixtures__/**", "!**/__tests__/**", "!**/__test__/**"];

/** Everything `cachePaths` needs, with the fields a case does not care about pinned. */
const pathOptions = (overrides: Partial<Parameters<typeof cachePaths>[0]> = {}): Parameters<typeof cachePaths>[0] => ({
	packageManagers: ["pnpm"],
	tools: [],
	toolCacheBase: "/opt/hostedtoolcache",
	additional: [],
	turbo: false,
	platform: "linux",
	home: "/home/runner",
	...overrides,
});

/** Everything `keySegments` needs, with a fixed baseline every case perturbs. */
const keyOptions = (overrides: Partial<Parameters<typeof keySegments>[0]> = {}): Parameters<typeof keySegments>[0] => ({
	platform: "linux",
	arch: "x64",
	tools: [{ name: "node", version: "24.11.0" }],
	packageManager: { name: "pnpm", version: "10.20.0" },
	branch: "main",
	lockfileHash: Option.some("0123456789abcdef0123456789abcdef"),
	cacheBust: Option.none(),
	...overrides,
});

describe("activePackageManagers", () => {
	it("maps a node runtime to the manifest's package manager", () => {
		expect(activePackageManagers(config({ name: "pnpm", version: "10.20.0" }, "node"))).toEqual(["pnpm"]);
	});

	it("maps bun and deno runtimes to themselves", () => {
		expect(activePackageManagers(config({ name: "npm", version: "11.6.0" }, "bun"))).toEqual(["bun"]);
		expect(activePackageManagers(config({ name: "npm", version: "11.6.0" }, "deno"))).toEqual(["deno"]);
	});

	it("unions every runtime's manager, in declaration order", () => {
		expect(activePackageManagers(config({ name: "pnpm", version: "10.20.0" }, "node", "bun", "deno"))).toEqual([
			"pnpm",
			"bun",
			"deno",
		]);
	});

	it("de-duplicates a manager two runtimes both name", () => {
		// bun as the manifest's package manager *and* a declared runtime: the node
		// runtime contributes "bun" and so does the bun runtime.
		expect(activePackageManagers(config({ name: "bun", version: "1.3.3" }, "node", "bun"))).toEqual(["bun"]);
	});
});

describe("lockfilePatterns", () => {
	it("carries each manager's patterns verbatim", () => {
		expect(lockfilePatterns(["npm"], [])).toEqual(["**/npm-shrinkwrap.json", "**/package-lock.json", ...EXCLUSIONS]);
		expect(lockfilePatterns(["pnpm"], [])).toEqual([
			"**/.pnpmfile.cjs",
			"**/pnpm-lock.yaml",
			"**/pnpm-workspace.yaml",
			...EXCLUSIONS,
		]);
		expect(lockfilePatterns(["yarn"], [])).toEqual([
			"**/.pnp.cjs",
			"**/.yarn/install-state.gz",
			"**/yarn.lock",
			...EXCLUSIONS,
		]);
		expect(lockfilePatterns(["bun"], [])).toEqual(["**/bun.lock", "**/bun.lockb", ...EXCLUSIONS]);
		expect(lockfilePatterns(["deno"], [])).toEqual(["**/deno.lock", ...EXCLUSIONS]);
	});

	it("unions multiple managers and sorts the union", () => {
		expect(lockfilePatterns(["pnpm", "deno"], [])).toEqual([
			"**/.pnpmfile.cjs",
			"**/deno.lock",
			"**/pnpm-lock.yaml",
			"**/pnpm-workspace.yaml",
			...EXCLUSIONS,
		]);
	});

	it("appends additional patterns after the sort, in the order they were given", () => {
		expect(lockfilePatterns(["deno"], ["**/vendor.lock", "**/custom.lock"])).toEqual([
			"**/deno.lock",
			"**/vendor.lock",
			"**/custom.lock",
			...EXCLUSIONS,
		]);
	});

	it("ends with the five exclusions, verbatim and last", () => {
		expect([...LOCKFILE_EXCLUSIONS]).toEqual(EXCLUSIONS);
		expect(lockfilePatterns(["npm"], []).slice(-EXCLUSIONS.length)).toEqual(EXCLUSIONS);
	});
});

describe("cachePaths", () => {
	it("uses each manager's default store directory on POSIX", () => {
		expect(cachePaths(pathOptions({ packageManagers: ["npm"] }))).toContain("/home/runner/.npm");
		expect(cachePaths(pathOptions({ packageManagers: ["pnpm"] }))).toContain("/home/runner/.local/share/pnpm/store");
		expect(cachePaths(pathOptions({ packageManagers: ["yarn"] }))).toContain("/home/runner/.yarn/cache");
		expect(cachePaths(pathOptions({ packageManagers: ["yarn"] }))).toContain("/home/runner/.cache/yarn");
		expect(cachePaths(pathOptions({ packageManagers: ["bun"] }))).toContain("/home/runner/.bun/install/cache");
		expect(cachePaths(pathOptions({ packageManagers: ["deno"] }))).toContain("/home/runner/.cache/deno");
	});

	it("uses each manager's default store directory on Windows", () => {
		const windows = { platform: "win32", home: "C:\\Users\\runneradmin", toolCacheBase: "C:\\hostedtoolcache" };
		expect(cachePaths(pathOptions({ ...windows, packageManagers: ["npm"] }))).toContain(
			"C:\\Users\\runneradmin\\AppData\\Local\\npm-cache",
		);
		expect(cachePaths(pathOptions({ ...windows, packageManagers: ["pnpm"] }))).toContain(
			"C:\\Users\\runneradmin\\AppData\\Local\\pnpm\\store",
		);
		expect(cachePaths(pathOptions({ ...windows, packageManagers: ["yarn"] }))).toContain(
			"C:\\Users\\runneradmin\\AppData\\Local\\Yarn\\Cache",
		);
		expect(cachePaths(pathOptions({ ...windows, packageManagers: ["bun"] }))).toContain(
			"C:\\Users\\runneradmin\\AppData\\Local\\bun\\install\\cache",
		);
		expect(cachePaths(pathOptions({ ...windows, packageManagers: ["deno"] }))).toContain(
			"C:\\Users\\runneradmin\\AppData\\Local\\deno",
		);
	});

	it("adds the per-manager dependency directories (oracle 19)", () => {
		expect(cachePaths(pathOptions({ packageManagers: ["npm"] }))).toContain("**/node_modules");
		expect(cachePaths(pathOptions({ packageManagers: ["bun"] }))).toContain("**/node_modules");
		const yarn = cachePaths(pathOptions({ packageManagers: ["yarn"] }));
		expect(yarn).toContain("**/node_modules");
		expect(yarn).toContain("**/.yarn/cache");
		expect(yarn).toContain("**/.yarn/unplugged");
		expect(yarn).toContain("**/.yarn/install-state.gz");
		// deno resolves modules into its own store and never writes node_modules.
		expect(cachePaths(pathOptions({ packageManagers: ["deno"] }))).not.toContain("**/node_modules");
	});

	it("adds a hostedtoolcache directory per cacheable tool, and only those", () => {
		const paths = cachePaths(
			pathOptions({
				tools: [
					{ name: "node", version: "24.11.0" },
					{ name: "bun", version: "1.3.3" },
					{ name: "deno", version: "2.5.6" },
					{ name: "biome", version: "2.3.14" },
					{ name: "pnpm", version: "10.20.0" },
				],
			}),
		);
		expect(paths).toContain("/opt/hostedtoolcache/node/24.11.0");
		expect(paths).toContain("/opt/hostedtoolcache/bun/1.3.3");
		expect(paths).toContain("/opt/hostedtoolcache/deno/2.5.6");
		expect(paths).toContain("/opt/hostedtoolcache/biome/2.3.14");
		// The package manager is not installed into the runtime tool-cache layout
		// this action caches, so it contributes no directory.
		expect(paths).not.toContain("/opt/hostedtoolcache/pnpm/10.20.0");
	});

	it("joins tool-cache directories with the target platform's separator", () => {
		expect(
			cachePaths(
				pathOptions({
					platform: "win32",
					home: "C:\\Users\\runneradmin",
					toolCacheBase: "C:\\hostedtoolcache",
					tools: [{ name: "node", version: "24.11.0" }],
				}),
			),
		).toContain("C:\\hostedtoolcache\\node\\24.11.0");
	});

	it("sorts the built-ins absolute-first, then appends the caller's paths and turbo's", () => {
		const paths = cachePaths(
			pathOptions({
				packageManagers: ["pnpm"],
				tools: [{ name: "node", version: "24.11.0" }],
				additional: ["**/build", "**/dist"],
				turbo: true,
			}),
		);
		expect(paths).toEqual([
			"/home/runner/.local/share/pnpm/store",
			"/opt/hostedtoolcache/node/24.11.0",
			"**/node_modules",
			"**/build",
			"**/dist",
			"**/.turbo/cache",
		]);
	});

	it("caches only turbo's artifact directory, and only when turbo was detected", () => {
		expect([...TURBO_LOCAL_CACHE_PATHS]).toEqual(["**/.turbo/cache"]);
		expect(cachePaths(pathOptions({ turbo: false }))).not.toContain("**/.turbo/cache");
	});

	it("de-duplicates a caller path that repeats a built-in, keeping the built-in's place", () => {
		const paths = cachePaths(pathOptions({ packageManagers: ["pnpm"], additional: ["**/node_modules", "**/dist"] }));
		expect(paths.filter((path) => path === "**/node_modules")).toHaveLength(1);
		expect(paths).toEqual(["/home/runner/.local/share/pnpm/store", "**/node_modules", "**/dist"]);
	});
});

describe("defaultToolCacheBase", () => {
	it("answers the runner image's hostedtoolcache root per platform", () => {
		expect(defaultToolCacheBase("linux")).toBe("/opt/hostedtoolcache");
		expect(defaultToolCacheBase("darwin")).toBe("/opt/hostedtoolcache");
		expect(defaultToolCacheBase("win32")).toBe("C:\\hostedtoolcache");
	});
});

describe("keySegments", () => {
	it("lays the key out as platform-arch-versionHash-branchHash-lockfileHash", () => {
		const segments = keySegments(keyOptions());
		expect(segments).toHaveLength(5);
		expect(segments[0]).toBe("linux");
		expect(segments[1]).toBe("x64");
		expect(CacheKey.of(...segments).key).toMatch(/^linux-x64-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}$/);
	});

	it("separates architectures on the same platform", () => {
		// The bug the arch segment fixes: an arm64 and an x64 macOS runner share a
		// platform name and would otherwise restore each other's binaries.
		expect(keySegments(keyOptions({ arch: "arm64" }))).not.toEqual(keySegments(keyOptions({ arch: "x64" })));
	});

	it("truncates the lockfile digest to eight hex characters", () => {
		expect(keySegments(keyOptions())[4]).toBe("01234567");
	});

	it("names the no-lockfile case rather than leaving the segment empty", () => {
		const segments = keySegments(keyOptions({ lockfileHash: Option.none() }));
		expect(segments[4]).toBe(EMPTY_LOCKFILE_SEGMENT);
		// The key still assembles: an empty segment is refused by `CacheKey`.
		expect(CacheKey.of(...segments).key.endsWith(`-${EMPTY_LOCKFILE_SEGMENT}`)).toBe(true);
	});

	it("hashes every tool version and the package manager into the version segment", () => {
		const baseline = keySegments(keyOptions())[2];
		expect(keySegments(keyOptions({ tools: [{ name: "node", version: "24.11.1" }] }))[2]).not.toBe(baseline);
		expect(keySegments(keyOptions({ packageManager: { name: "pnpm", version: "10.20.1" } }))[2]).not.toBe(baseline);
		expect(keySegments(keyOptions({ packageManager: { name: "npm", version: "10.20.0" } }))[2]).not.toBe(baseline);
	});

	it("does not depend on the order the tools were declared in", () => {
		const tools = [
			{ name: "node", version: "24.11.0" },
			{ name: "bun", version: "1.3.3" },
		];
		expect(keySegments(keyOptions({ tools }))[2]).toBe(keySegments(keyOptions({ tools: [...tools].reverse() }))[2]);
	});

	it("perturbs the version segment with the cache bust, and nothing else", () => {
		const plain = keySegments(keyOptions());
		const busted = keySegments(keyOptions({ cacheBust: Option.some("npm-ubuntu-123") }));
		expect(busted[2]).not.toBe(plain[2]);
		expect(busted[0]).toBe(plain[0]);
		expect(busted[1]).toBe(plain[1]);
		expect(busted[3]).toBe(plain[3]);
		expect(busted[4]).toBe(plain[4]);
	});

	it("separates branches, and hashes the branchless case as a literal", () => {
		expect(keySegments(keyOptions({ branch: "dev" }))[3]).not.toBe(keySegments(keyOptions({ branch: "main" }))[3]);
		// A detached or tagged ref yields no branch name; legacy hashed "null"
		// rather than the empty string (oracle 12) and the pairing depends on it.
		expect(keySegments(keyOptions({ branch: "" }))[3]).toBe(keySegments(keyOptions({ branch: "null" }))[3]);
	});

	it("is deterministic across calls", () => {
		expect(keySegments(keyOptions())).toEqual(keySegments(keyOptions()));
	});
});

describe("RESTORE_DEPTHS", () => {
	it("falls back within the branch, then across branches, and no further", () => {
		const key = CacheKey.of("linux", "x64", "aaaaaaaa", "bbbbbbbb", "cccccccc").withRestoreDepths(RESTORE_DEPTHS);
		expect(key.restoreKeys).toEqual(["linux-x64-aaaaaaaa-bbbbbbbb-", "linux-x64-aaaaaaaa-"]);
	});

	it("keeps every rung a prefix of the primary key", () => {
		const key = CacheKey.of("linux", "x64", "aaaaaaaa", "bbbbbbbb", "cccccccc").withRestoreDepths(RESTORE_DEPTHS);
		for (const rung of key.restoreKeys) {
			expect(key.key.startsWith(rung)).toBe(true);
			expect(rung.endsWith("-")).toBe(true);
		}
	});

	it("stops short of the default ladder, which drops the version digest", () => {
		// The reason the policy is carried on the key at all: left to derive its
		// own, `CacheKey` offers `linux-x64-` and `linux-` too, and a cache built
		// for a different Node restores against either.
		const segments = CacheKey.of("linux", "x64", "aaaaaaaa", "bbbbbbbb", "cccccccc");
		expect(segments.restoreKeys).toHaveLength(4);
		expect(segments.withRestoreDepths(RESTORE_DEPTHS).restoreKeys).toHaveLength(2);
	});
});
