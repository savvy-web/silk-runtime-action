import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { KCOV_VERSION, kcov, kcovCacheKey } from "../../../src/descriptors/kcov.js";

describe("kcov.plan", () => {
	it("resolves the linux build recipe", () => {
		const planned = kcov.plan(KCOV_VERSION, "linux", "x64");
		assert.strictEqual(Result.isSuccess(planned), true);
		if (!Result.isSuccess(planned)) return;
		assert.strictEqual(planned.success.url, "https://github.com/SimonKagstrom/kcov/archive/refs/tags/v43.tar.gz");
		assert.strictEqual(planned.success.archiveSubPath, "kcov-43");
		assert.strictEqual(planned.success.binary, "kcov");
		assert.include(planned.success.buildDeps, "libdw-dev");
		assert.include(planned.success.buildDeps, "binutils-dev");
	});

	it("resolves a different build recipe on darwin", () => {
		const planned = kcov.plan(KCOV_VERSION, "darwin", "arm64");
		assert.strictEqual(Result.isSuccess(planned), true);
		if (!Result.isSuccess(planned)) return;
		assert.deepStrictEqual(planned.success.buildDeps, ["dwarfutils", "openssl@3"]);
	});

	it("refuses win32, where kcov does not build", () => {
		const planned = kcov.plan(KCOV_VERSION, "win32", "x64");
		assert.strictEqual(Result.isFailure(planned), true);
		if (!Result.isFailure(planned)) return;
		assert.strictEqual(planned.failure, "Unsupported platform for kcov: win32-x64");
	});
});

describe("kcovCacheKey", () => {
	const UNBUSTED = kcovCacheKey("43", "ubuntu24", "X64", Option.none(), Option.some("20260801.1"));

	it("puts image version in the primary and keeps everything else in the rung", () => {
		assert.match(UNBUSTED.key, /^kcov-43-ubuntu24-X64-[0-9a-f]{8}-20260801\.1$/);
		assert.deepStrictEqual(UNBUSTED.restoreKeys, [UNBUSTED.key.replace("20260801.1", "")]);
	});

	// A self-hosted runner sets no `ImageVersion`. The primary must collapse onto
	// what would have been the rung — no `-undefined` segment, and no dead rung
	// that nothing can ever match.
	it("collapses the primary onto the rung when there is no image version", () => {
		const key = kcovCacheKey("43", "ubuntu24", "X64", Option.none());
		assert.strictEqual(key.key, UNBUSTED.restoreKeys[0]?.slice(0, -1));
		assert.deepStrictEqual(key.restoreKeys, []);
	});

	// Oracle 15: a busted run drops the ladder entirely, so its restore proves an
	// exact hit rather than being satisfied by a rung.
	it("drops the ladder entirely when busted", () => {
		assert.deepStrictEqual(
			kcovCacheKey("43", "ubuntu24", "X64", Option.some("run-7"), Option.some("20260801.1")).restoreKeys,
			[],
		);
	});

	// The leak a trailing bust segment leaves: an unbusted run's rung would
	// prefix-match a busted entry. A retained digest segment stops it in BOTH
	// directions.
	it("keeps busted and unbusted keys from matching each other in either direction", () => {
		const busted = kcovCacheKey("43", "ubuntu24", "X64", Option.some("run-7"), Option.some("20260801.1"));
		assert.notStrictEqual(busted.key, UNBUSTED.key);
		for (const rung of UNBUSTED.restoreKeys) assert.strictEqual(busted.key.startsWith(rung), false);
		for (const rung of busted.restoreKeys) assert.strictEqual(UNBUSTED.key.startsWith(rung), false);
	});

	it("gives different busts different keys", () => {
		const seven = kcovCacheKey("43", "ubuntu24", "X64", Option.some("run-7"), Option.some("20260801.1"));
		const eight = kcovCacheKey("43", "ubuntu24", "X64", Option.some("run-8"), Option.some("20260801.1"));
		assert.notStrictEqual(seven.key, eight.key);
	});
});
