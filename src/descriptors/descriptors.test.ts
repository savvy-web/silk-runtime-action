import { describe, expect, it } from "vitest";

import { binaryMap as biomeBinaryMap } from "./biome.js";
import { descriptor as bun } from "./bun.js";
import { descriptor as deno } from "./deno.js";
import { descriptor as node } from "./node.js";

// These are pure functions — no mocks, no Effect layers needed.

describe("node descriptor", () => {
	describe("getDownloadUrl", () => {
		it("linux/x64", () => {
			expect(node.getDownloadUrl("24.11.0", "linux", "x64")).toBe(
				"https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.gz",
			);
		});

		it("darwin/arm64", () => {
			expect(node.getDownloadUrl("24.11.0", "darwin", "arm64")).toBe(
				"https://nodejs.org/dist/v24.11.0/node-v24.11.0-darwin-arm64.tar.gz",
			);
		});

		it("win32/x64", () => {
			expect(node.getDownloadUrl("24.11.0", "win32", "x64")).toBe(
				"https://nodejs.org/dist/v24.11.0/node-v24.11.0-win-x64.zip",
			);
		});

		it("linux/arm maps to armv7l", () => {
			expect(node.getDownloadUrl("24.11.0", "linux", "arm")).toBe(
				"https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-armv7l.tar.gz",
			);
		});
	});

	describe("getToolInstallOptions", () => {
		it("linux → tar.gz with binSubPath bin", () => {
			expect(node.getToolInstallOptions("24.11.0", "linux", "x64")).toEqual({
				archiveType: "tar.gz",
				binSubPath: "bin",
				tarFlags: ["xz", "--strip=1", "-f"],
			});
		});

		it("darwin → tar.gz with binSubPath bin", () => {
			expect(node.getToolInstallOptions("24.11.0", "darwin", "arm64")).toEqual({
				archiveType: "tar.gz",
				binSubPath: "bin",
				tarFlags: ["xz", "--strip=1", "-f"],
			});
		});

		it("win32 → zip with no binSubPath", () => {
			const opts = node.getToolInstallOptions("24.11.0", "win32", "x64");
			expect(opts.archiveType).toBe("zip");
			expect(opts.binSubPath).toBeUndefined();
		});
	});

	it("verifyCommand starts with node", () => {
		expect(node.verifyCommand[0]).toBe("node");
	});
});

describe("bun descriptor", () => {
	describe("getDownloadUrl", () => {
		it("linux/x64", () => {
			expect(bun.getDownloadUrl("1.3.3", "linux", "x64")).toBe(
				"https://github.com/oven-sh/bun/releases/download/bun-v1.3.3/bun-linux-x64.zip",
			);
		});

		it("darwin/arm64 maps arm64 → aarch64", () => {
			const url = bun.getDownloadUrl("1.3.3", "darwin", "arm64");
			expect(url).toContain("bun-darwin-aarch64.zip");
		});

		it("win32/x64", () => {
			const url = bun.getDownloadUrl("1.3.3", "win32", "x64");
			expect(url).toContain("bun-windows-x64.zip");
		});

		it("linux/arm64 maps arm64 → aarch64", () => {
			const url = bun.getDownloadUrl("1.3.3", "linux", "arm64");
			expect(url).toContain("bun-linux-aarch64.zip");
		});
	});

	describe("getToolInstallOptions", () => {
		it("always returns zip with correct binSubPath", () => {
			expect(bun.getToolInstallOptions("1.3.3", "linux", "x64")).toEqual({
				archiveType: "zip",
				binSubPath: "bun-linux-x64",
			});
			expect(bun.getToolInstallOptions("1.3.3", "darwin", "arm64")).toEqual({
				archiveType: "zip",
				binSubPath: "bun-darwin-aarch64",
			});
			expect(bun.getToolInstallOptions("1.3.3", "win32", "x64")).toEqual({
				archiveType: "zip",
				binSubPath: "bun-windows-x64",
			});
		});
	});

	it("verifyCommand starts with bun", () => {
		expect(bun.verifyCommand[0]).toBe("bun");
	});
});

describe("deno descriptor", () => {
	describe("getDownloadUrl", () => {
		it("linux/x64 → x86_64-unknown-linux-gnu", () => {
			const url = deno.getDownloadUrl("2.5.6", "linux", "x64");
			expect(url).toContain("deno-x86_64-unknown-linux-gnu.zip");
		});

		it("darwin/arm64 → aarch64-apple-darwin", () => {
			const url = deno.getDownloadUrl("2.5.6", "darwin", "arm64");
			expect(url).toContain("deno-aarch64-apple-darwin.zip");
		});

		it("win32/x64 → x86_64-pc-windows-msvc", () => {
			const url = deno.getDownloadUrl("2.5.6", "win32", "x64");
			expect(url).toContain("deno-x86_64-pc-windows-msvc.zip");
		});

		it("linux/arm64 → aarch64-unknown-linux-gnu", () => {
			const url = deno.getDownloadUrl("2.5.6", "linux", "arm64");
			expect(url).toContain("deno-aarch64-unknown-linux-gnu.zip");
		});

		it("darwin/x64 → x86_64-apple-darwin", () => {
			const url = deno.getDownloadUrl("2.5.6", "darwin", "x64");
			expect(url).toContain("deno-x86_64-apple-darwin.zip");
		});

		it("throws for unsupported platform", () => {
			expect(() => deno.getDownloadUrl("2.5.6", "freebsd", "x64")).toThrow("Unsupported platform for Deno");
		});
	});

	describe("getToolInstallOptions", () => {
		it("always returns zip", () => {
			expect(deno.getToolInstallOptions("2.5.6", "linux", "x64")).toEqual({ archiveType: "zip" });
			expect(deno.getToolInstallOptions("2.5.6", "darwin", "arm64")).toEqual({ archiveType: "zip" });
			expect(deno.getToolInstallOptions("2.5.6", "win32", "x64")).toEqual({ archiveType: "zip" });
		});
	});

	it("verifyCommand starts with deno", () => {
		expect(deno.verifyCommand[0]).toBe("deno");
	});
});

describe("biome binaryMap", () => {
	it("has entries for linux x64 and arm64", () => {
		expect(biomeBinaryMap.linux.x64).toBe("biome-linux-x64");
		expect(biomeBinaryMap.linux.arm64).toBe("biome-linux-arm64");
	});

	it("has entries for darwin x64 and arm64", () => {
		expect(biomeBinaryMap.darwin.x64).toBe("biome-darwin-x64");
		expect(biomeBinaryMap.darwin.arm64).toBe("biome-darwin-arm64");
	});

	it("has .exe suffix for win32", () => {
		expect(biomeBinaryMap.win32.x64).toBe("biome-win32-x64.exe");
		expect(biomeBinaryMap.win32.arm64).toBe("biome-win32-arm64.exe");
	});

	it("returns undefined for unsupported platforms", () => {
		expect(biomeBinaryMap.freebsd).toBeUndefined();
	});
});
