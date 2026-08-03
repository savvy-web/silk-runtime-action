import { describe, expect, it } from "@effect/vitest";

import { BiomeDetectError } from "../../../src/steps/detect-biome.js";
import { TurboDetectError } from "../../../src/steps/detect-turbo.js";
import { BiomeInstallError } from "../../../src/steps/install-biome.js";
import { CacheError } from "../../../src/steps/restore-cache.js";
import { SummaryError } from "../../../src/steps/summary.js";
import { TurboCacheError } from "../../../src/steps/turbo-cache.js";

// `loadConfig` is implemented, not stubbed — its tests live in load-config.test.ts.

// `installRuntimes` is implemented, not stubbed — its tests live in
// install-runtimes.test.ts, next to the descriptor tests it depends on.

// `installDependencies` is implemented, not stubbed — its tests live in
// install-dependencies.test.ts.

// `setupPackageManager` is implemented, not stubbed — its tests live in
// setup-package-manager.test.ts.

// `restoreCache` is implemented, not stubbed — its tests live in
// restore-cache.test.ts, next to the pure helpers it derives its key and paths
// with.

describe("CacheError", () => {
	it("carries its tag and reason", () => {
		const error = new CacheError({ reason: "restore", message: "restore failed" });
		expect(error._tag).toBe("CacheError");
		expect(error.reason).toBe("restore");
		expect(error.message).toBe("restore failed");
	});

	it("tells the two writes apart", () => {
		// `state` is main failing to hand the post phase what it restored; `save`
		// is the post phase failing to archive it. One literal for both would make
		// a log grep for a failed archive turn up runs that never attempted one.
		const reasons: ReadonlyArray<CacheError["reason"]> = ["key", "restore", "state", "save"];
		expect(reasons.map((reason) => new CacheError({ reason, message: reason }).reason)).toEqual([
			"key",
			"restore",
			"state",
			"save",
		]);
	});
});

// The step itself is covered by `install-biome.test.ts`, next to the descriptor
// tests it depends on.
describe("installBiome", () => {
	it("BiomeInstallError carries its tag and reason", () => {
		const error = new BiomeInstallError({ reason: "cache", message: "cache write failed" });
		expect(error._tag).toBe("BiomeInstallError");
		expect(error.reason).toBe("cache");
		expect(error.message).toBe("cache write failed");
	});
});

// The steps themselves are covered by `detect-biome.test.ts` and
// `detect-turbo.test.ts`; what is left here is the error class each one
// declares, alongside every other step's.
describe("detectBiome", () => {
	it("BiomeDetectError carries its tag and reason", () => {
		const error = new BiomeDetectError({ reason: "parse", message: "unparseable $schema" });
		expect(error._tag).toBe("BiomeDetectError");
		expect(error.reason).toBe("parse");
		expect(error.message).toBe("unparseable $schema");
	});
});

describe("detectTurbo", () => {
	it("TurboDetectError carries its tag and reason", () => {
		const error = new TurboDetectError({ reason: "read", message: "could not read turbo.json" });
		expect(error._tag).toBe("TurboDetectError");
		expect(error.reason).toBe("read");
		expect(error.message).toBe("could not read turbo.json");
	});
});

// `startTurboCache` is implemented, not stubbed — its tests live in
// turbo-cache.test.ts, next to the activation table it resolves with.
describe("startTurboCache", () => {
	it("TurboCacheError carries its tag and reason", () => {
		const error = new TurboCacheError({ reason: "readiness", message: "server never became ready" });
		expect(error._tag).toBe("TurboCacheError");
		expect(error.reason).toBe("readiness");
		expect(error.message).toBe("server never became ready");
	});
});

// `writeSummary` is implemented, not stubbed — its tests live in
// summary.test.ts, beside the formatter tests in summary/format.test.ts.
describe("writeSummary", () => {
	it("SummaryError carries its tag and reason", () => {
		const error = new SummaryError({ reason: "render", message: "render failed" });
		expect(error._tag).toBe("SummaryError");
		expect(error.reason).toBe("render");
		expect(error.message).toBe("render failed");
	});
});
