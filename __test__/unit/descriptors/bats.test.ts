import { describe, expect, it } from "@effect/vitest";

import { BATS_CORE_VERSION, batsCorePlan, batsLibraryPlans } from "../../../src/descriptors/bats.js";

describe("batsCorePlan", () => {
	it("resolves the pinned bats-core release tarball", () => {
		const plan = batsCorePlan();
		expect(plan.version).toBe("1.14.0");
		expect(plan.url).toBe("https://github.com/bats-core/bats-core/archive/refs/tags/v1.14.0.tar.gz");
		expect(plan.archiveSubPath).toBe("bats-core-1.14.0");
		expect(plan.binSubPath).toBe("bin");
	});

	it("agrees with the exported version constant", () => {
		expect(batsCorePlan().version).toBe(BATS_CORE_VERSION);
	});
});

describe("batsLibraryPlans", () => {
	it("resolves all four helper libraries at their pinned versions", () => {
		expect(batsLibraryPlans().map((lib) => [lib.name, lib.version])).toEqual([
			["bats-support", "0.3.0"],
			["bats-assert", "2.2.4"],
			["bats-file", "0.4.0"],
			["bats-mock", "1.2.5"],
		]);
	});

	it("sources bats-mock from jasonkarns, not the bats-core org", () => {
		const mock = batsLibraryPlans().find((lib) => lib.name === "bats-mock");
		expect(mock?.url).toBe("https://github.com/jasonkarns/bats-mock/archive/refs/tags/v1.2.5.tar.gz");
		expect(mock?.archiveSubPath).toBe("bats-mock-1.2.5");
		expect(mock?.layout).toBe("flat");
	});

	it("marks the three bats-core libraries as load-and-src", () => {
		const layouts = batsLibraryPlans()
			.filter((lib) => lib.name !== "bats-mock")
			.map((lib) => lib.layout);
		expect(layouts).toEqual(["load-and-src", "load-and-src", "load-and-src"]);
	});

	it("builds every bats-core library url from the bats-core org", () => {
		for (const lib of batsLibraryPlans().filter((l) => l.name !== "bats-mock")) {
			expect(lib.url).toBe(`https://github.com/bats-core/${lib.name}/archive/refs/tags/v${lib.version}.tar.gz`);
		}
	});
});
