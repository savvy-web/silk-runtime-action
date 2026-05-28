import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { AbsoluteVersion, DevEngineEntry, DevEngines } from "./domain.js";

const decodeAbsoluteVersion = Schema.decodeUnknownEither(AbsoluteVersion);
const decodeDevEngineEntry = Schema.decodeUnknownEither(DevEngineEntry);
const decodeDevEngines = Schema.decodeUnknownEither(DevEngines);

describe("AbsoluteVersion", () => {
	describe("valid versions", () => {
		it("accepts a plain semver version", () => {
			expect(Either.isRight(decodeAbsoluteVersion("24.11.0"))).toBe(true);
		});

		it("accepts a minimal semver version", () => {
			expect(Either.isRight(decodeAbsoluteVersion("1.0.0"))).toBe(true);
		});

		it("accepts a prerelease version", () => {
			expect(Either.isRight(decodeAbsoluteVersion("1.0.0-beta.1"))).toBe(true);
		});

		it("accepts a version with prerelease and build metadata", () => {
			expect(Either.isRight(decodeAbsoluteVersion("1.0.0-beta.1+build.123"))).toBe(true);
		});
	});

	describe("invalid versions", () => {
		it("rejects caret ranges", () => {
			expect(Either.isLeft(decodeAbsoluteVersion("^24.0.0"))).toBe(true);
		});

		it("rejects tilde ranges", () => {
			expect(Either.isLeft(decodeAbsoluteVersion("~24.0.0"))).toBe(true);
		});

		it("rejects gte ranges", () => {
			expect(Either.isLeft(decodeAbsoluteVersion(">=24.0.0"))).toBe(true);
		});

		it("rejects wildcard *", () => {
			expect(Either.isLeft(decodeAbsoluteVersion("*"))).toBe(true);
		});

		it("rejects x wildcard in major", () => {
			expect(Either.isLeft(decodeAbsoluteVersion("24.x"))).toBe(true);
		});

		it("rejects x wildcard in patch", () => {
			expect(Either.isLeft(decodeAbsoluteVersion("24.0.x"))).toBe(true);
		});
	});
});

describe("DevEngineEntry", () => {
	describe("valid entries", () => {
		it("accepts minimal entry with name and version", () => {
			const result = decodeDevEngineEntry({ name: "node", version: "24.11.0" });
			expect(Either.isRight(result)).toBe(true);
		});

		it("accepts entry with optional onFail field", () => {
			const result = decodeDevEngineEntry({ name: "node", version: "24.11.0", onFail: "error" });
			expect(Either.isRight(result)).toBe(true);
		});

		it("accepts pnpm package manager entry", () => {
			const result = decodeDevEngineEntry({ name: "pnpm", version: "10.20.0", onFail: "error" });
			expect(Either.isRight(result)).toBe(true);
		});
	});

	describe("invalid entries", () => {
		it("rejects entry with semver range version", () => {
			const result = decodeDevEngineEntry({ name: "node", version: "^24.0.0" });
			expect(Either.isLeft(result)).toBe(true);
		});

		it("rejects entry missing name", () => {
			const result = decodeDevEngineEntry({ version: "24.11.0" });
			expect(Either.isLeft(result)).toBe(true);
		});

		it("rejects entry missing version", () => {
			const result = decodeDevEngineEntry({ name: "node" });
			expect(Either.isLeft(result)).toBe(true);
		});

		it("rejects non-object input", () => {
			const result = decodeDevEngineEntry("not-an-object");
			expect(Either.isLeft(result)).toBe(true);
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
			expect(Either.isRight(result)).toBe(true);
		});

		it("accepts array of runtimes", () => {
			const result = decodeDevEngines({
				runtime: [
					{ name: "node", version: "24.11.0" },
					{ name: "bun", version: "1.3.3" },
				],
				packageManager: { name: "bun", version: "1.3.3" },
			});
			expect(Either.isRight(result)).toBe(true);
		});

		it("accepts entries with onFail field", () => {
			const result = decodeDevEngines({
				runtime: { name: "node", version: "24.11.0", onFail: "error" },
				packageManager: { name: "pnpm", version: "10.20.0", onFail: "error" },
			});
			expect(Either.isRight(result)).toBe(true);
		});
	});

	describe("invalid devEngines", () => {
		it("rejects missing packageManager", () => {
			const result = decodeDevEngines({
				runtime: { name: "node", version: "24.11.0" },
			});
			expect(Either.isLeft(result)).toBe(true);
		});

		it("rejects missing runtime", () => {
			const result = decodeDevEngines({
				packageManager: { name: "pnpm", version: "10.20.0" },
			});
			expect(Either.isLeft(result)).toBe(true);
		});

		it("rejects invalid version in packageManager", () => {
			const result = decodeDevEngines({
				runtime: { name: "node", version: "24.11.0" },
				packageManager: { name: "pnpm", version: "^10.0.0" },
			});
			expect(Either.isLeft(result)).toBe(true);
		});

		it("rejects invalid version in runtime", () => {
			const result = decodeDevEngines({
				runtime: { name: "node", version: "~24.0.0" },
				packageManager: { name: "pnpm", version: "10.20.0" },
			});
			expect(Either.isLeft(result)).toBe(true);
		});
	});
});
