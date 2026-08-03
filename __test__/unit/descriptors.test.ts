import { describe, expect, it } from "@effect/vitest";
import { Result } from "effect";

import { biome } from "../../src/descriptors/biome.js";
import { bun } from "../../src/descriptors/bun.js";
import { deno } from "../../src/descriptors/deno.js";
import { node } from "../../src/descriptors/node.js";

/**
 * Unwraps a plan a descriptor is expected to produce, failing the test rather
 * than the type system when it does not.
 */
const plan = <A>(result: Result.Result<A, string>): A => {
	if (Result.isFailure(result)) throw new Error(`expected a plan, got: ${result.failure}`);
	return result.success;
};

describe("node descriptor", () => {
	it("plans a linux x64 tarball with a stripped bin subdirectory", () => {
		expect(plan(node.plan("24.11.0", "linux", "x64"))).toEqual({
			url: "https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.gz",
			archive: "tar.gz",
			binSubPath: "bin",
			tarFlags: ["xz", "--strip=1", "-f"],
			binary: "node",
		});
	});

	it("plans a darwin arm64 tarball", () => {
		expect(plan(node.plan("24.11.0", "darwin", "arm64")).url).toBe(
			"https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.gz",
		);
	});

	it("maps arm to armv7l", () => {
		expect(plan(node.plan("24.11.0", "linux", "arm")).url).toBe(
			"https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-armv7l.tar.gz",
		);
	});

	it("passes an unmapped arch through unchanged", () => {
		expect(plan(node.plan("24.11.0", "linux", "ppc64")).url).toBe(
			"https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-ppc64.tar.gz",
		);
	});

	it("strips the archive's wrapper directory on windows, rather than caching it", () => {
		expect(plan(node.plan("24.11.0", "win32", "x64"))).toEqual({
			url: "https://nodejs.org/dist/v24.11.0/node-v24.11.0-win-x64.zip",
			archive: "zip",
			archiveSubPath: "node-v24.11.0-win-x64",
			binary: "node.exe",
		});
	});

	it("plans a windows arm64 zip with a matching wrapper directory", () => {
		const planned = plan(node.plan("24.11.0", "win32", "arm64"));
		expect(planned.url).toBe("https://nodejs.org/dist/v24.11.0/node-v24.11.0-win-arm64.zip");
		expect(planned.archiveSubPath).toBe("node-v24.11.0-win-arm64");
		expect(planned.binSubPath).toBeUndefined();
	});
});

describe("bun descriptor", () => {
	it("strips the archive's top folder, rather than caching it", () => {
		expect(plan(bun.plan("1.3.3", "linux", "x64"))).toEqual({
			url: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-linux-x64.zip",
			archive: "zip",
			archiveSubPath: "bun-linux-x64",
			binary: "bun",
		});
	});

	it("maps arm64 to aarch64", () => {
		const planned = plan(bun.plan("1.3.3", "darwin", "arm64"));
		expect(planned.url).toBe("https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-darwin-aarch64.zip");
		expect(planned.archiveSubPath).toBe("bun-darwin-aarch64");
		expect(planned.binSubPath).toBeUndefined();
	});

	it("pins windows to x64, because bun publishes no aarch64 windows build", () => {
		expect(plan(bun.plan("1.3.3", "win32", "arm64"))).toEqual({
			url: "https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-windows-x64.zip",
			archive: "zip",
			archiveSubPath: "bun-windows-x64",
			binary: "bun.exe",
		});
	});
});

describe("deno descriptor", () => {
	it("plans a linux x64 zip with neither a wrapper to strip nor a bin subdirectory", () => {
		expect(plan(deno.plan("2.5.6", "linux", "x64"))).toEqual({
			url: "https://github.com/denoland/deno/releases/download/v2.5.6/deno-x86_64-unknown-linux-gnu.zip",
			archive: "zip",
			binary: "deno",
		});
	});

	it.each([
		["linux", "arm64", "aarch64-unknown-linux-gnu"],
		["darwin", "x64", "x86_64-apple-darwin"],
		["darwin", "arm64", "aarch64-apple-darwin"],
		["win32", "x64", "x86_64-pc-windows-msvc"],
	])("maps %s %s to the %s target triple", (platform, arch, target) => {
		expect(plan(deno.plan("2.5.6", platform, arch)).url).toBe(
			`https://github.com/denoland/deno/releases/download/v2.5.6/deno-${target}.zip`,
		);
	});

	it("names the windows binary deno.exe", () => {
		expect(plan(deno.plan("2.5.6", "win32", "x64")).binary).toBe("deno.exe");
	});

	it.each([
		["win32", "arm64"],
		["freebsd", "x64"],
	])("refuses an unsupported %s %s pair", (platform, arch) => {
		const result = deno.plan("2.5.6", platform, arch);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure).toBe(`Unsupported platform for Deno: ${platform}-${arch}`);
		}
	});
});

describe("biome descriptor", () => {
	it.each([
		["linux", "x64", "biome-linux-x64"],
		["linux", "arm64", "biome-linux-arm64"],
		["darwin", "x64", "biome-darwin-x64"],
		["darwin", "arm64", "biome-darwin-arm64"],
		["win32", "x64", "biome-win32-x64.exe"],
		["win32", "arm64", "biome-win32-arm64.exe"],
	])("plans the %s %s release asset", (platform, arch, asset) => {
		// The tag is an npm package name, so both the `@` and the `/` are
		// percent-encoded; the version rides unencoded (oracle 16).
		expect(plan(biome.plan("2.4.9", platform, arch)).url).toBe(
			`https://github.com/biomejs/biome/releases/download/%40biomejs%2Fbiome%402.4.9/${asset}`,
		);
	});

	it("caches the executable under a stable name, not the asset's", () => {
		// `biome-linux-x64` on the PATH would be a tool nobody can invoke by the
		// name a workflow writes (oracle 17).
		expect(plan(biome.plan("2.4.9", "linux", "x64")).binary).toBe("biome");
		expect(plan(biome.plan("2.4.9", "darwin", "arm64")).binary).toBe("biome");
		expect(plan(biome.plan("2.4.9", "win32", "x64")).binary).toBe("biome.exe");
	});

	it.each([
		["linux", "arm"],
		["freebsd", "x64"],
		["darwin", "ppc64"],
	])("refuses an unsupported %s %s pair", (platform, arch) => {
		const result = biome.plan("2.4.9", platform, arch);
		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(result.failure).toBe(`Unsupported platform for Biome: ${platform}-${arch}`);
		}
	});
});
