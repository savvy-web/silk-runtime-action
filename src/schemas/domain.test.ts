import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AbsoluteVersion, DevEngineEntry, DevEngines } from "./domain.js";

const decodeAbsoluteVersion = Schema.decodeUnknownResult(AbsoluteVersion);
const decodeDevEngineEntry = Schema.decodeUnknownResult(DevEngineEntry);
const decodeDevEngines = Schema.decodeUnknownResult(DevEngines);

describe("AbsoluteVersion", () => {
	describe("valid versions", () => {
		it("accepts a plain semver version", () => {
			expect(Result.isSuccess(decodeAbsoluteVersion("24.11.0"))).toBe(true);
		});

		it("accepts a minimal semver version", () => {
			expect(Result.isSuccess(decodeAbsoluteVersion("1.0.0"))).toBe(true);
		});

		it("accepts a prerelease version", () => {
			expect(Result.isSuccess(decodeAbsoluteVersion("1.0.0-beta.1"))).toBe(true);
		});

		it("accepts a version with prerelease and build metadata", () => {
			expect(Result.isSuccess(decodeAbsoluteVersion("1.0.0-beta.1+build.123"))).toBe(true);
		});
	});

	describe("invalid versions", () => {
		it("rejects caret ranges", () => {
			expect(Result.isFailure(decodeAbsoluteVersion("^24.0.0"))).toBe(true);
		});

		it("rejects tilde ranges", () => {
			expect(Result.isFailure(decodeAbsoluteVersion("~24.0.0"))).toBe(true);
		});

		it("rejects gte ranges", () => {
			expect(Result.isFailure(decodeAbsoluteVersion(">=24.0.0"))).toBe(true);
		});

		it("rejects wildcard *", () => {
			expect(Result.isFailure(decodeAbsoluteVersion("*"))).toBe(true);
		});

		it("rejects x wildcard in major", () => {
			expect(Result.isFailure(decodeAbsoluteVersion("24.x"))).toBe(true);
		});

		it("rejects x wildcard in patch", () => {
			expect(Result.isFailure(decodeAbsoluteVersion("24.0.x"))).toBe(true);
		});
	});
});

describe("DevEngineEntry", () => {
	describe("valid entries", () => {
		it("accepts minimal entry with name and version", () => {
			const result = decodeDevEngineEntry({ name: "node", version: "24.11.0" });
			expect(Result.isSuccess(result)).toBe(true);
		});

		it("accepts entry with optional onFail field", () => {
			const result = decodeDevEngineEntry({ name: "node", version: "24.11.0", onFail: "error" });
			expect(Result.isSuccess(result)).toBe(true);
		});

		it("accepts pnpm package manager entry", () => {
			const result = decodeDevEngineEntry({ name: "pnpm", version: "10.20.0", onFail: "error" });
			expect(Result.isSuccess(result)).toBe(true);
		});
	});

	describe("invalid entries", () => {
		it("rejects entry with semver range version", () => {
			const result = decodeDevEngineEntry({ name: "node", version: "^24.0.0" });
			expect(Result.isFailure(result)).toBe(true);
		});

		it("rejects entry missing name", () => {
			const result = decodeDevEngineEntry({ version: "24.11.0" });
			expect(Result.isFailure(result)).toBe(true);
		});

		it("rejects entry missing version", () => {
			const result = decodeDevEngineEntry({ name: "node" });
			expect(Result.isFailure(result)).toBe(true);
		});

		it("rejects non-object input", () => {
			const result = decodeDevEngineEntry("not-an-object");
			expect(Result.isFailure(result)).toBe(true);
		});
	});
});

describe("DevEngines", () => {
	describe("valid devEngines", () => {
		it("accepts single runtime object", () => {
			const result = decodeDevEngines({
				runtime: { name: "node", version: "24.11.0" },
				packageManager: { name: "pnpm", version: "10.20.0" },
			});
			expect(Result.isSuccess(result)).toBe(true);
		});

		it("accepts array of runtimes", () => {
			const result = decodeDevEngines({
				runtime: [
					{ name: "node", version: "24.11.0" },
					{ name: "bun", version: "1.3.3" },
				],
				packageManager: { name: "bun", version: "1.3.3" },
			});
			expect(Result.isSuccess(result)).toBe(true);
		});

		it("accepts entries with onFail field", () => {
			const result = decodeDevEngines({
				runtime: { name: "node", version: "24.11.0", onFail: "error" },
				packageManager: { name: "pnpm", version: "10.20.0", onFail: "error" },
			});
			expect(Result.isSuccess(result)).toBe(true);
		});
	});

	describe("invalid devEngines", () => {
		it("rejects missing packageManager", () => {
			const result = decodeDevEngines({
				runtime: { name: "node", version: "24.11.0" },
			});
			expect(Result.isFailure(result)).toBe(true);
		});

		it("rejects missing runtime", () => {
			const result = decodeDevEngines({
				packageManager: { name: "pnpm", version: "10.20.0" },
			});
			expect(Result.isFailure(result)).toBe(true);
		});

		it("rejects invalid version in packageManager", () => {
			const result = decodeDevEngines({
				runtime: { name: "node", version: "24.11.0" },
				packageManager: { name: "pnpm", version: "^10.0.0" },
			});
			expect(Result.isFailure(result)).toBe(true);
		});

		it("rejects invalid version in runtime", () => {
			const result = decodeDevEngines({
				runtime: { name: "node", version: "~24.0.0" },
				packageManager: { name: "pnpm", version: "10.20.0" },
			});
			expect(Result.isFailure(result)).toBe(true);
		});
	});
});
