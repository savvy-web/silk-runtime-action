import { describe, expect, it } from "@effect/vitest";
import { Option, Result } from "effect";

import { KCOV_VERSION, kcov, kcovCacheKey } from "../../../src/descriptors/kcov.js";

describe("kcov.plan", () => {
	it("resolves the linux build recipe", () => {
		const planned = kcov.plan(KCOV_VERSION, "linux", "x64");
		expect(Result.isSuccess(planned)).toBe(true);
		if (!Result.isSuccess(planned)) return;
		expect(planned.success.url).toBe("https://github.com/SimonKagstrom/kcov/archive/refs/tags/v43.tar.gz");
		expect(planned.success.archiveSubPath).toBe("kcov-43");
		expect(planned.success.binary).toBe("kcov");
		expect(planned.success.buildDeps).toContain("libdw-dev");
		expect(planned.success.buildDeps).toContain("binutils-dev");
	});

	it("resolves a different build recipe on darwin", () => {
		const planned = kcov.plan(KCOV_VERSION, "darwin", "arm64");
		expect(Result.isSuccess(planned)).toBe(true);
		if (!Result.isSuccess(planned)) return;
		expect(planned.success.buildDeps).toEqual(["dwarfutils", "openssl@3"]);
	});

	it("refuses win32, where kcov does not build", () => {
		const planned = kcov.plan(KCOV_VERSION, "win32", "x64");
		expect(Result.isFailure(planned)).toBe(true);
		if (!Result.isFailure(planned)) return;
		expect(planned.failure).toBe("Unsupported platform for kcov: win32-x64");
	});
});

describe("kcovCacheKey", () => {
	const UNBUSTED = kcovCacheKey("43", "ubuntu24", "X64", Option.none(), Option.some("20260801.1"));

	it("puts image version in the primary and keeps everything else in the rung", () => {
		expect(UNBUSTED.key).toMatch(/^kcov-43-ubuntu24-X64-[0-9a-f]{8}-20260801\.1$/);
		expect(UNBUSTED.restoreKeys).toEqual([UNBUSTED.key.replace("20260801.1", "")]);
	});

	// A self-hosted runner sets no `ImageVersion`. The primary must collapse onto
	// what would have been the rung — no `-undefined` segment, and no dead rung
	// that nothing can ever match.
	it("collapses the primary onto the rung when there is no image version", () => {
		const key = kcovCacheKey("43", "ubuntu24", "X64", Option.none());
		expect(key.key).toBe(UNBUSTED.restoreKeys[0]?.slice(0, -1));
		expect(key.restoreKeys).toEqual([]);
	});

	// Oracle 15: a busted run drops the ladder entirely, so its restore proves an
	// exact hit rather than being satisfied by a rung.
	it("drops the ladder entirely when busted", () => {
		expect(kcovCacheKey("43", "ubuntu24", "X64", Option.some("run-7"), Option.some("20260801.1")).restoreKeys).toEqual(
			[],
		);
	});

	// The leak a trailing bust segment leaves: an unbusted run's rung would
	// prefix-match a busted entry. A retained digest segment stops it in BOTH
	// directions.
	it("keeps busted and unbusted keys from matching each other in either direction", () => {
		const busted = kcovCacheKey("43", "ubuntu24", "X64", Option.some("run-7"), Option.some("20260801.1"));
		expect(busted.key).not.toBe(UNBUSTED.key);
		for (const rung of UNBUSTED.restoreKeys) expect(busted.key.startsWith(rung)).toBe(false);
		for (const rung of busted.restoreKeys) expect(UNBUSTED.key.startsWith(rung)).toBe(false);
	});

	it("gives different busts different keys", () => {
		const seven = kcovCacheKey("43", "ubuntu24", "X64", Option.some("run-7"), Option.some("20260801.1"));
		const eight = kcovCacheKey("43", "ubuntu24", "X64", Option.some("run-8"), Option.some("20260801.1"));
		expect(seven.key).not.toBe(eight.key);
	});
});
