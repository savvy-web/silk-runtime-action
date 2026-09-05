import { assert, describe, it } from "@effect/vitest";

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
		assert.strictEqual(error._tag, "CacheError");
		assert.strictEqual(error.reason, "restore");
		assert.strictEqual(error.message, "restore failed");
	});

	it("tells the two writes apart", () => {
		// `state` is main failing to hand the post phase what it restored; `save`
		// is the post phase failing to archive it. One literal for both would make
		// a log grep for a failed archive turn up runs that never attempted one.
		const reasons: ReadonlyArray<CacheError["reason"]> = ["key", "restore", "state", "save"];
		assert.deepStrictEqual(
			reasons.map((reason) => new CacheError({ reason, message: reason }).reason),
			["key", "restore", "state", "save"],
		);
	});
});

// The step itself is covered by `install-biome.test.ts`, next to the descriptor
// tests it depends on.
describe("installBiome", () => {
	it("BiomeInstallError carries its tag and reason", () => {
		const error = new BiomeInstallError({ reason: "cache", message: "cache write failed" });
		assert.strictEqual(error._tag, "BiomeInstallError");
		assert.strictEqual(error.reason, "cache");
		assert.strictEqual(error.message, "cache write failed");
	});
});

// The steps themselves are covered by `detect-biome.test.ts` and
// `detect-turbo.test.ts`; what is left here is the error class each one
// declares, alongside every other step's.
describe("detectBiome", () => {
	it("BiomeDetectError carries its tag and reason", () => {
		const error = new BiomeDetectError({ reason: "parse", message: "unparseable $schema" });
		assert.strictEqual(error._tag, "BiomeDetectError");
		assert.strictEqual(error.reason, "parse");
		assert.strictEqual(error.message, "unparseable $schema");
	});
});

describe("detectTurbo", () => {
	it("TurboDetectError carries its tag and reason", () => {
		const error = new TurboDetectError({ reason: "read", message: "could not read turbo.json" });
		assert.strictEqual(error._tag, "TurboDetectError");
		assert.strictEqual(error.reason, "read");
		assert.strictEqual(error.message, "could not read turbo.json");
	});
});

// `startTurboCache` is implemented, not stubbed — its tests live in
// turbo-cache.test.ts, next to the activation table it resolves with.
describe("startTurboCache", () => {
	it("TurboCacheError carries its tag and reason", () => {
		const error = new TurboCacheError({ reason: "readiness", message: "server never became ready" });
		assert.strictEqual(error._tag, "TurboCacheError");
		assert.strictEqual(error.reason, "readiness");
		assert.strictEqual(error.message, "server never became ready");
	});
});

// `writeSummary` is implemented, not stubbed — its tests live in
// summary.test.ts, beside the formatter tests in summary/format.test.ts.
describe("writeSummary", () => {
	it("SummaryError carries its tag and reason", () => {
		const error = new SummaryError({ reason: "write", message: "write failed" });
		assert.strictEqual(error._tag, "SummaryError");
		assert.strictEqual(error.reason, "write");
		assert.strictEqual(error.message, "write failed");
	});
});
