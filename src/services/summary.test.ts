// src/services/summary.test.ts
import { describe, expect, it } from "vitest";
import type { RuntimeSummary } from "./summary.js";
import { buildRuntimeSummary, formatCacheLine, formatDetectLine, formatTurboLine } from "./summary.js";

describe("formatTurboLine", () => {
	it("describes an embedded backend with its port", () => {
		expect(formatTurboLine("github", 41230)).toBe("github · server ready (:41230)");
		expect(formatTurboLine("s3", 41230)).toBe("s3 · server ready (:41230)");
	});
	it("describes passthrough and disabled", () => {
		expect(formatTurboLine("remote", null)).toBe("passthrough (Vercel)");
		expect(formatTurboLine("none", null)).toBe("disabled");
	});
});

describe("formatDetectLine", () => {
	it("joins runtimes, package manager, biome, and turbo", () => {
		const line = formatDetectLine({
			runtimes: [{ name: "node", version: "26.3.1" }],
			packageManager: { name: "pnpm", version: "11.8.0" },
			biome: "2.4.16",
			turbo: true,
		});
		expect(line).toBe("node 26.3.1 · pnpm 11.8.0 · biome 2.4.16 · turbo");
	});
	it("omits biome and turbo when absent", () => {
		const line = formatDetectLine({
			runtimes: [{ name: "node", version: "26.3.1" }],
			packageManager: { name: "pnpm", version: "11.8.0" },
			biome: null,
			turbo: false,
		});
		expect(line).toBe("node 26.3.1 · pnpm 11.8.0");
	});
});

describe("formatCacheLine", () => {
	it("renders hit/partial/miss with lockfile count and pluralization", () => {
		expect(formatCacheLine("exact", 3)).toBe("exact hit (3 lockfiles)");
		expect(formatCacheLine("partial", 1)).toBe("partial hit (1 lockfile)");
		expect(formatCacheLine("none", 0)).toBe("miss (0 lockfiles)");
	});
});

describe("buildRuntimeSummary", () => {
	const base: RuntimeSummary = {
		runtimes: [{ name: "node", version: "26.3.1" }],
		packageManager: { name: "pnpm", version: "11.8.0" },
		biome: "2.4.16",
		turbo: { backend: "github", port: 41230 },
		cacheHit: "exact",
		dependenciesInstalled: true,
		cacheKey: "linux-aaaa1111-bbbb2222-cccc3333",
		lockfiles: ["pnpm-lock.yaml"],
	};

	it("renders the heading, a table with all rows, and a cache-details section", () => {
		const md = buildRuntimeSummary(base);
		expect(md).toContain("## 🚀 Runtime Setup");
		expect(md).toContain("| Runtime(s) | node 26.3.1 |");
		expect(md).toContain("| Package manager | pnpm 11.8.0 |");
		expect(md).toContain("| Biome | 2.4.16 |");
		expect(md).toContain("| Turbo cache | github · server ready (:41230) |");
		expect(md).toContain("| Dependency cache | ✅ exact hit |");
		expect(md).toContain("| Dependencies | installed |");
		expect(md).toContain("<details>");
		expect(md).toContain("linux-aaaa1111-bbbb2222-cccc3333");
		expect(md).toContain("pnpm-lock.yaml");
	});

	it("omits the Biome row when biome is null", () => {
		const md = buildRuntimeSummary({ ...base, biome: null });
		expect(md).not.toContain("| Biome |");
	});

	it("shows skipped dependencies and a partial-cache cell", () => {
		const md = buildRuntimeSummary({ ...base, dependenciesInstalled: false, cacheHit: "partial" });
		expect(md).toContain("| Dependencies | skipped |");
		expect(md).toContain("| Dependency cache | ♻️ partial hit |");
	});
});
