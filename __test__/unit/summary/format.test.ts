import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";

import { CacheState } from "../../../src/state.js";
import {
	buildRuntimeSummary,
	cacheCell,
	formatDetectLine,
	formatTurboLine,
	kcovCell,
} from "../../../src/summary/format.js";

/** A restore outcome, as the panel's three cells are derived from one. */
const cacheState = (options: {
	readonly restoredKey?: string;
	readonly primaryKey?: string;
	readonly lockfiles?: ReadonlyArray<string>;
}): CacheState =>
	CacheState.make({
		paths: ["**/node_modules"],
		primaryKey: options.primaryKey ?? "silk-linux-x64-abc",
		restoredKey: options.restoredKey === undefined ? Option.none() : Option.some(options.restoredKey),
		lockfiles: options.lockfiles ?? [],
	});

describe("formatDetectLine", () => {
	it("joins every detected fact with a middle dot", () => {
		expect(
			formatDetectLine({
				runtimes: [{ name: "node", version: "26.3.1" }],
				packageManager: { name: "pnpm", version: "11.8.0" },
				biome: Option.some("2.4.16"),
				turbo: true,
				bats: false,
			}),
		).toBe("node 26.3.1 · pnpm 11.8.0 · biome 2.4.16 · turbo");
	});

	it("omits the biome and turbo parts when neither was detected", () => {
		expect(
			formatDetectLine({
				runtimes: [{ name: "node", version: "26.3.1" }],
				packageManager: { name: "pnpm", version: "11.8.0" },
				biome: Option.none(),
				turbo: false,
				bats: false,
			}),
		).toBe("node 26.3.1 · pnpm 11.8.0");
	});

	it("lists every runtime ahead of the package manager, in declaration order", () => {
		expect(
			formatDetectLine({
				runtimes: [
					{ name: "node", version: "24.11.0" },
					{ name: "bun", version: "1.3.3" },
				],
				packageManager: { name: "bun", version: "1.3.3" },
				biome: Option.none(),
				turbo: true,
				bats: false,
			}),
		).toBe("node 24.11.0 · bun 1.3.3 · bun 1.3.3 · turbo");
	});

	it("spells the tool name in lowercase, unlike the panel's row label", () => {
		// Ruling 55: `biome` here, `Biome` in the table — kept verbatim rather
		// than harmonized.
		const line = formatDetectLine({
			runtimes: [],
			packageManager: { name: "npm", version: "11.0.0" },
			biome: Option.some("2.4.16"),
			turbo: false,
			bats: false,
		});
		expect(line).toContain("biome 2.4.16");
		expect(line).not.toContain("Biome");
	});
});

describe("formatDetectLine with bats", () => {
	it("appends bats after turbo as a bare word", () => {
		expect(
			formatDetectLine({
				runtimes: [{ name: "node", version: "24.11.0" }],
				packageManager: { name: "pnpm", version: "10.20.0" },
				biome: Option.none(),
				turbo: true,
				bats: true,
			}),
		).toBe("node 24.11.0 · pnpm 10.20.0 · turbo · bats");
	});

	it("omits bats when not detected", () => {
		expect(
			formatDetectLine({
				runtimes: [{ name: "node", version: "24.11.0" }],
				packageManager: { name: "pnpm", version: "10.20.0" },
				biome: Option.none(),
				turbo: false,
				bats: false,
			}),
		).toBe("node 24.11.0 · pnpm 10.20.0");
	});
});

describe("kcovCell", () => {
	it("reports a cache hit", () => {
		expect(kcovCell({ _tag: "installed", version: "43", cacheHit: true })).toBe("43 · ✅ cached");
	});

	it("reports a build", () => {
		expect(kcovCell({ _tag: "installed", version: "43", cacheHit: false })).toBe("43 · ⬜ built");
	});

	it("reports a requested-but-failed install rather than staying silent", () => {
		expect(kcovCell({ _tag: "unavailable" })).toBe("⚠️ unavailable");
	});
});

describe("formatTurboLine", () => {
	it("reports no backend as disabled", () => {
		expect(formatTurboLine("none", Option.none())).toBe("disabled");
	});

	it("names Vercel for a passthrough", () => {
		expect(formatTurboLine("remote", Option.none())).toBe("passthrough (Vercel)");
	});

	it("names the embedded backend and the port it bound", () => {
		expect(formatTurboLine("github", Option.some(41230))).toBe("github · server ready (:41230)");
		expect(formatTurboLine("s3", Option.some(41230))).toBe("s3 · server ready (:41230)");
	});

	it("drops the port when the embedded server bound none", () => {
		expect(formatTurboLine("github", Option.none())).toBe("github · server ready");
	});
});

describe("cacheCell", () => {
	it("marks a restore that landed on the key it asked for", () => {
		expect(cacheCell(cacheState({ restoredKey: "silk-linux-x64-abc" }))).toBe("✅ exact hit");
	});

	it("marks a restore that landed on a fallback rung", () => {
		expect(cacheCell(cacheState({ restoredKey: "silk-linux-x64" }))).toBe("♻️ partial hit");
	});

	it("marks a restore that landed on nothing", () => {
		expect(cacheCell(cacheState({}))).toBe("⬜ miss");
	});
});

describe("buildRuntimeSummary", () => {
	/** Everything detected, installed and restored — the maximal panel. */
	const complete = {
		runtimes: [
			{ name: "node", version: "26.3.1" },
			{ name: "bun", version: "1.3.3" },
		],
		packageManager: { name: "pnpm", version: "11.8.0" },
		biome: Option.some("2.4.16"),
		turbo: { backend: "github", port: Option.some(41230) },
		cache: cacheState({ restoredKey: "silk-linux-x64-abc", lockfiles: ["pnpm-lock.yaml", "deno.lock"] }),
		dependenciesInstalled: true,
		bats: Option.none(),
		kcov: Option.none(),
	} as const;

	it("renders the whole panel, verbatim", () => {
		expect(buildRuntimeSummary(complete)).toBe(
			[
				"## 🚀 Runtime Setup",
				"",
				"| Component | Detail |",
				"| --- | --- |",
				"| Runtime(s) | node 26.3.1, bun 1.3.3 |",
				"| Package manager | pnpm 11.8.0 |",
				"| Biome | 2.4.16 |",
				"| Turbo cache | github · server ready (:41230) |",
				"| Dependency cache | ✅ exact hit |",
				"| Dependencies | installed |",
				"",
				"<details>",
				"<summary>Cache details</summary>",
				"",
				"- Cache key: `silk-linux-x64-abc`",
				"- Lockfiles: `pnpm-lock.yaml`, `deno.lock`",
				"",
				"</details>",
			].join("\n"),
		);
	});

	it("omits the Biome row entirely when none was installed", () => {
		const panel = buildRuntimeSummary({ ...complete, biome: Option.none() });
		expect(panel).not.toContain("Biome");
		// The rows around it keep their order and their neighbours.
		expect(panel).toContain("| Package manager | pnpm 11.8.0 |\n| Turbo cache |");
	});

	it("keeps every other row when the run installed and cached nothing", () => {
		const panel = buildRuntimeSummary({
			...complete,
			biome: Option.none(),
			turbo: { backend: "none", port: Option.none() },
			cache: cacheState({ primaryKey: "" }),
			dependenciesInstalled: false,
		});
		expect(panel).toContain("| Turbo cache | disabled |");
		expect(panel).toContain("| Dependency cache | ⬜ miss |");
		expect(panel).toContain("| Dependencies | skipped |");
	});

	it("says so in the details when no lockfile matched", () => {
		// Unconditional row (oracle 10): the absence is an answer, not a missing
		// line — a miss with no lockfiles at all is a different problem from a
		// miss with three.
		const panel = buildRuntimeSummary({ ...complete, cache: cacheState({ lockfiles: [] }) });
		expect(panel).toContain("- Lockfiles: none");
	});

	it("drops the cache-key item when the key could not be computed", () => {
		const panel = buildRuntimeSummary({
			...complete,
			cache: cacheState({ primaryKey: "", lockfiles: ["pnpm-lock.yaml"] }),
		});
		expect(panel).not.toContain("Cache key:");
		expect(panel).toContain("- Lockfiles: `pnpm-lock.yaml`");
	});
});

describe("buildRuntimeSummary with bats and kcov", () => {
	/** Everything detected, installed and restored — the maximal panel. */
	const baseFacts = {
		runtimes: [
			{ name: "node", version: "26.3.1" },
			{ name: "bun", version: "1.3.3" },
		],
		packageManager: { name: "pnpm", version: "11.8.0" },
		biome: Option.some("2.4.16"),
		turbo: { backend: "github", port: Option.some(41230) },
		cache: cacheState({ restoredKey: "silk-linux-x64-abc", lockfiles: ["pnpm-lock.yaml", "deno.lock"] }),
		dependenciesInstalled: true,
		bats: Option.none(),
		kcov: Option.none(),
	} as const;

	it("renders the BATS row with library versions inline", () => {
		const panel = buildRuntimeSummary({
			...baseFacts,
			bats: Option.some({
				version: "1.14.0",
				libraries: [
					{ name: "bats-support", version: "0.3.0" },
					{ name: "bats-assert", version: "2.2.4" },
					{ name: "bats-file", version: "0.4.0" },
					{ name: "bats-mock", version: "1.2.5" },
				],
			}),
			kcov: Option.some({ _tag: "installed", version: "43", cacheHit: true }),
		});
		expect(panel).toContain("1.14.0 · support 0.3.0 · assert 2.2.4 · file 0.4.0 · mock 1.2.5");
		expect(panel).toContain("43 · ✅ cached");
	});

	it("omits both rows when neither tool was requested", () => {
		const panel = buildRuntimeSummary({ ...baseFacts, bats: Option.none(), kcov: Option.none() });
		expect(panel).not.toContain("BATS");
		expect(panel).not.toContain("kcov");
	});

	it("renders the kcov row as unavailable when it was requested and failed", () => {
		const panel = buildRuntimeSummary({
			...baseFacts,
			bats: Option.some({ version: "1.14.0", libraries: [] }),
			kcov: Option.some({ _tag: "unavailable" }),
		});
		expect(panel).toContain("⚠️ unavailable");
	});
});
