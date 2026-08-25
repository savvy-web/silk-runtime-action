import { describe, expect, it } from "@effect/vitest";
import { CacheKey } from "@effected/github-actions";
import { Option } from "effect";

import { RuntimeConfig } from "../../../src/schema/domain.js";
import {
	EMPTY_LOCKFILE_SEGMENT,
	LOCKFILE_EXCLUSIONS,
	RESTORE_DEPTHS,
	STORE_RESTORE_DEPTHS,
	TURBO_LOCAL_CACHE_PATHS,
	activePackageManagers,
	cachePaths,
	defaultToolCacheBase,
	keySegments,
	lockfilePatterns,
	storeCachePaths,
	storeKeySegments,
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
	packageDirs: ["."],
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
	install: { deps: true, ignoreScripts: false },
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
	it("anchors each manager's names at the workspace root", () => {
		expect(lockfilePatterns(["npm"], [])).toEqual(["npm-shrinkwrap.json", "package-lock.json", ...EXCLUSIONS]);
		expect(lockfilePatterns(["pnpm"], [])).toEqual([
			".pnpmfile.cjs",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
			...EXCLUSIONS,
		]);
		expect(lockfilePatterns(["yarn"], [])).toEqual([".pnp.cjs", ".yarn/install-state.gz", "yarn.lock", ...EXCLUSIONS]);
		expect(lockfilePatterns(["bun"], [])).toEqual(["bun.lock", "bun.lockb", ...EXCLUSIONS]);
		expect(lockfilePatterns(["deno"], [])).toEqual(["deno.lock", ...EXCLUSIONS]);
	});

	it("globs no built-in name at any depth", () => {
		// The regression: `**\/pnpm-lock.yaml` hashed every fixture lockfile in the
		// tree, and the exclusions below only caught the two directory conventions
		// they happen to name. `spencerbeggs/effected` carries forty-one lockfiles
		// under `packages/*\/__test__/fixtures/`, and a repository spelling that
		// `test/fixtures/` instead would have keyed its cache on all of them.
		for (const manager of ["npm", "pnpm", "yarn", "bun", "deno"] as const) {
			const built = lockfilePatterns([manager], []).slice(0, -EXCLUSIONS.length);
			expect(built.filter((pattern) => pattern.includes("*"))).toEqual([]);
		}
	});

	it("unions multiple managers and sorts the union", () => {
		expect(lockfilePatterns(["pnpm", "deno"], [])).toEqual([
			".pnpmfile.cjs",
			"deno.lock",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
			...EXCLUSIONS,
		]);
	});

	it("appends additional patterns after the sort, in the order they were given", () => {
		expect(lockfilePatterns(["deno"], ["**/vendor.lock", "**/custom.lock"])).toEqual([
			"deno.lock",
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

describe("storeCachePaths", () => {
	it("uses each manager's default store directory on Linux", () => {
		expect(storeCachePaths(["npm"], "linux", "/home/runner")).toContain("/home/runner/.npm");
		expect(storeCachePaths(["pnpm"], "linux", "/home/runner")).toContain("/home/runner/.local/share/pnpm/store");
		// Classic and Berry both, because the manager's major is not known here.
		const yarn = storeCachePaths(["yarn"], "linux", "/home/runner");
		expect(yarn).toContain("/home/runner/.cache/yarn");
		expect(yarn).toContain("/home/runner/.yarn/berry/cache");
		expect(storeCachePaths(["bun"], "linux", "/home/runner")).toContain("/home/runner/.bun/install/cache");
		expect(storeCachePaths(["deno"], "linux", "/home/runner")).toContain("/home/runner/.cache/deno");
	});

	it("uses each manager's default store directory on macOS", () => {
		// The platform the old hand-rolled table was wrong about: it archived
		// pnpm's *linux* store here, so a macOS job cached an empty directory and
		// restored nothing. Classic's macOS cache is under `~/Library/Caches`,
		// which that table did not have a cell for at all.
		const home = "/Users/runner";
		expect(storeCachePaths(["npm"], "darwin", home)).toContain("/Users/runner/.npm");
		expect(storeCachePaths(["pnpm"], "darwin", home)).toContain("/Users/runner/Library/pnpm/store");
		const yarn = storeCachePaths(["yarn"], "darwin", home);
		expect(yarn).toContain("/Users/runner/Library/Caches/Yarn");
		expect(yarn).toContain("/Users/runner/.yarn/berry/cache");
		expect(storeCachePaths(["bun"], "darwin", home)).toContain("/Users/runner/.bun/install/cache");
	});

	it("uses each manager's default store directory on Windows", () => {
		const home = "C:\\Users\\runneradmin";
		expect(storeCachePaths(["npm"], "win32", home)).toContain("C:\\Users\\runneradmin\\AppData\\Local\\npm-cache");
		expect(storeCachePaths(["pnpm"], "win32", home)).toContain("C:\\Users\\runneradmin\\AppData\\Local\\pnpm\\store");
		const yarn = storeCachePaths(["yarn"], "win32", home);
		expect(yarn).toContain("C:\\Users\\runneradmin\\AppData\\Local\\Yarn\\Cache");
		expect(yarn).toContain("C:\\Users\\runneradmin\\AppData\\Local\\Yarn\\Berry\\cache");
		// bun documents no Windows divergence: the cache is under the user profile
		// on every platform, not `AppData` as the table this replaces claimed.
		expect(storeCachePaths(["bun"], "win32", home)).toContain("C:\\Users\\runneradmin\\.bun\\install\\cache");
		expect(storeCachePaths(["deno"], "win32", home)).toContain("C:\\Users\\runneradmin\\AppData\\Local\\deno");
	});

	it("de-duplicates a store two managers share, and sorts the result", () => {
		expect(storeCachePaths(["pnpm", "pnpm"], "linux", "/home/runner")).toEqual([
			"/home/runner/.local/share/pnpm/store",
		]);
		expect(storeCachePaths(["pnpm", "npm"], "linux", "/home/runner")).toEqual([
			"/home/runner/.local/share/pnpm/store",
			"/home/runner/.npm",
		]);
	});
});

describe("cachePaths", () => {
	it("holds no global store — those are archived under their own key", () => {
		// The split: a store is content-addressable and append-only, so keying it
		// on the branch and the exact lockfile digest threw the download away on
		// every branch cut for no correctness this cache needed.
		for (const manager of ["npm", "pnpm", "yarn", "bun", "deno"] as const) {
			const paths = cachePaths(pathOptions({ packageManagers: [manager] }));
			for (const store of storeCachePaths([manager], "linux", "/home/runner")) {
				expect(paths).not.toContain(store);
			}
		}
	});

	it("names one node_modules per workspace package, root first", () => {
		expect(cachePaths(pathOptions({ packageManagers: ["pnpm"], packageDirs: [".", "packages/a", "website"] }))).toEqual(
			["node_modules", "packages/a/node_modules", "website/node_modules"],
		);
	});

	it("globs no node_modules at any depth", () => {
		// The regression: `**\/node_modules` swept up every node_modules under the
		// checkout, including the ones inside `dist/` trees and test fixtures, so
		// the archive carried directories no install produced and no restore used.
		const paths = cachePaths(pathOptions({ packageManagers: ["pnpm"], packageDirs: [".", "packages/a"] }));
		expect(paths).not.toContain("**/node_modules");
		expect(paths.filter((path) => path.includes("*"))).toEqual([]);
	});

	it("adds the per-manager dependency directories (oracle 19)", () => {
		expect(cachePaths(pathOptions({ packageManagers: ["npm"] }))).toContain("node_modules");
		expect(cachePaths(pathOptions({ packageManagers: ["bun"] }))).toContain("node_modules");
		const yarn = cachePaths(pathOptions({ packageManagers: ["yarn"] }));
		expect(yarn).toContain("node_modules");
		expect(yarn).toContain(".yarn/cache");
		expect(yarn).toContain(".yarn/unplugged");
		expect(yarn).toContain(".yarn/install-state.gz");
		// deno resolves modules into its own store and never writes node_modules.
		expect(cachePaths(pathOptions({ packageManagers: ["deno"] }))).not.toContain("node_modules");
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
				packageDirs: [".", "packages/a"],
				additional: ["**/build", "**/dist"],
				turbo: true,
			}),
		);
		expect(paths).toEqual([
			"/opt/hostedtoolcache/node/24.11.0",
			"node_modules",
			"packages/a/node_modules",
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
		const paths = cachePaths(pathOptions({ packageManagers: ["pnpm"], additional: ["node_modules", "**/dist"] }));
		expect(paths.filter((path) => path === "node_modules")).toHaveLength(1);
		expect(paths).toEqual(["node_modules", "**/dist"]);
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

	it("separates a skipped install from a real one, so a deps-less run cannot poison the key", () => {
		// The regression: a job passing `install-deps: false` archived an empty
		// node_modules and an empty store under the key a full-install job used,
		// and every later run then reported an exact hit on a cache holding
		// nothing.
		const full = keySegments(keyOptions({ install: { deps: true, ignoreScripts: false } }));
		const skipped = keySegments(keyOptions({ install: { deps: false, ignoreScripts: false } }));
		expect(skipped[2]).not.toBe(full[2]);
	});

	it("separates an install that ran lifecycle scripts from one that did not", () => {
		const withScripts = keySegments(keyOptions({ install: { deps: true, ignoreScripts: false } }));
		const without = keySegments(keyOptions({ install: { deps: true, ignoreScripts: true } }));
		expect(without[2]).not.toBe(withScripts[2]);
	});

	it("collapses ignore-scripts when there is no install for it to change", () => {
		const off = keySegments(keyOptions({ install: { deps: false, ignoreScripts: false } }));
		const on = keySegments(keyOptions({ install: { deps: false, ignoreScripts: true } }));
		expect(on[2]).toBe(off[2]);
	});

	it("keeps the install policy in the version segment, and out of every other one", () => {
		const plain = keySegments(keyOptions());
		const skipped = keySegments(keyOptions({ install: { deps: false, ignoreScripts: false } }));
		expect(skipped[0]).toBe(plain[0]);
		expect(skipped[1]).toBe(plain[1]);
		expect(skipped[3]).toBe(plain[3]);
		expect(skipped[4]).toBe(plain[4]);
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

describe("storeKeySegments", () => {
	const storeOptions = (
		overrides: Partial<Parameters<typeof storeKeySegments>[0]> = {},
	): Parameters<typeof storeKeySegments>[0] => ({
		platform: "linux",
		arch: "x64",
		packageManagers: [{ name: "pnpm", version: "10.20.0" }],
		lockfileHash: Option.some("0123456789abcdef0123456789abcdef"),
		cacheBust: Option.none(),
		...overrides,
	});

	it("lays the key out as store-platform-arch-managerHash-lockfileHash", () => {
		const segments = storeKeySegments(storeOptions());
		expect(segments).toHaveLength(5);
		expect(segments[0]).toBe("store");
		expect(segments[1]).toBe("linux");
		expect(segments[2]).toBe("x64");
		expect(segments[4]).toBe("01234567");
	});

	it("leads with a literal no workspace key can collide with", () => {
		// The workspace key opens with the platform, so no rung of either ladder
		// can reach the other's entries.
		expect(storeKeySegments(storeOptions())[0]).not.toBe(keySegments(keyOptions())[0]);
	});

	it("does not depend on the branch, which is why it survives a branch cut", () => {
		// There is no branch input at all — the assertion is on the type as much
		// as the value. A store from another branch is as good as this branch's.
		expect(Object.keys(storeOptions())).not.toContain("branch");
	});

	it("does not depend on the runtimes, which cannot change a package tarball", () => {
		expect(Object.keys(storeOptions())).not.toContain("tools");
	});

	it("separates manager versions, because the store layout is versioned", () => {
		// pnpm keeps a v10/v11 subdirectory under the archived path, and a major
		// bump writes a new one rather than reusing the old.
		const ten = storeKeySegments(storeOptions({ packageManagers: [{ name: "pnpm", version: "10.20.0" }] }));
		const eleven = storeKeySegments(storeOptions({ packageManagers: [{ name: "pnpm", version: "11.0.0" }] }));
		expect(eleven[3]).not.toBe(ten[3]);
	});

	it("does not depend on the order the managers were declared in", () => {
		const managers = [
			{ name: "pnpm", version: "10.20.0" },
			{ name: "bun", version: "1.3.3" },
		];
		expect(storeKeySegments(storeOptions({ packageManagers: managers }))[3]).toBe(
			storeKeySegments(storeOptions({ packageManagers: [...managers].reverse() }))[3],
		);
	});

	it("keeps the lockfile digest on the primary key, so the entry can top up", () => {
		// Without it the key would never change, every run after the first would
		// report an exact hit, and — since an exact hit skips the save — the store
		// would freeze at whatever the first run happened to download.
		const first = storeKeySegments(storeOptions({ lockfileHash: Option.some("aaaaaaaabbbbbbbb") }));
		const second = storeKeySegments(storeOptions({ lockfileHash: Option.some("ccccccccdddddddd") }));
		expect(second[4]).not.toBe(first[4]);
		expect(second[3]).toBe(first[3]);
	});

	it("names the no-lockfile case rather than leaving the segment empty", () => {
		expect(storeKeySegments(storeOptions({ lockfileHash: Option.none() }))[4]).toBe(EMPTY_LOCKFILE_SEGMENT);
	});

	it("perturbs the manager digest with the cache bust, and nothing else", () => {
		const plain = storeKeySegments(storeOptions());
		const busted = storeKeySegments(storeOptions({ cacheBust: Option.some("npm-ubuntu-123") }));
		expect(busted[3]).not.toBe(plain[3]);
		expect(busted[0]).toBe(plain[0]);
		expect(busted[4]).toBe(plain[4]);
	});
});

describe("STORE_RESTORE_DEPTHS", () => {
	it("keeps one rung, which drops the lockfile digest and nothing more", () => {
		expect([...STORE_RESTORE_DEPTHS]).toEqual([4]);
	});

	it("stops short of dropping the manager version", () => {
		// Depth 3 would restore a store laid out for a different major.
		expect(STORE_RESTORE_DEPTHS).not.toContain(3);
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
