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
	it("embeds version, image os and arch in both rungs", () => {
		expect(kcovCacheKey("43", "ubuntu24", "X64", Option.none(), Option.some("20260801.1"))).toEqual({
			primary: "kcov-43-ubuntu24-X64-20260801.1",
			restorePrefix: "kcov-43-ubuntu24-X64",
		});
	});

	// A self-hosted runner sets no `ImageVersion`; the ladder must degrade to the
	// previous single-key behavior rather than mint a key nothing can match.
	it("collapses the primary onto the prefix when there is no image version", () => {
		expect(kcovCacheKey("43", "ubuntu24", "X64", Option.none())).toEqual({
			primary: "kcov-43-ubuntu24-X64",
			restorePrefix: "kcov-43-ubuntu24-X64",
		});
	});

	// `cache-bust` is documented to force a miss. On the end of the primary it
	// would leave the fallback rung matching every un-busted entry, so the forced
	// miss would silently restore anyway — it belongs in the prefix.
	it("busts both rungs, not just the primary", () => {
		expect(kcovCacheKey("43", "ubuntu24", "X64", Option.some("run-7"), Option.some("20260801.1"))).toEqual({
			primary: "kcov-43-ubuntu24-X64-run-7-20260801.1",
			restorePrefix: "kcov-43-ubuntu24-X64-run-7",
		});
	});
});
