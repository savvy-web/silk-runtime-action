import { describe, expect, it } from "vitest";
import {
	CacheError,
	ConfigError,
	DependencyInstallError,
	PackageManagerSetupError,
	RuntimeInstallError,
} from "./errors.js";

describe("errors", () => {
	it("ConfigError exposes _tag and message getter", () => {
		const e = new ConfigError({ reason: "missing devEngines", file: "package.json" });
		expect(e._tag).toBe("ConfigError");
		expect(e.message).toBe("missing devEngines (at package.json)");
	});

	it("ConfigError without file uses reason only", () => {
		const e = new ConfigError({ reason: "bad shape" });
		expect(e.message).toBe("bad shape");
	});

	it("RuntimeInstallError formats runtime/version/reason", () => {
		const e = new RuntimeInstallError({ runtime: "node", version: "24.11.0", reason: "404" });
		expect(e._tag).toBe("RuntimeInstallError");
		expect(e.message).toBe("Failed to install node@24.11.0: 404");
	});

	it("PackageManagerSetupError formats packageManager/version/reason", () => {
		const e = new PackageManagerSetupError({
			packageManager: "pnpm",
			version: "10.33.4",
			reason: "corepack failed",
		});
		expect(e.message).toBe("Failed to setup pnpm@10.33.4: corepack failed");
	});

	it("DependencyInstallError formats packageManager/reason", () => {
		const e = new DependencyInstallError({ packageManager: "pnpm", reason: "lockfile drift" });
		expect(e.message).toBe("Failed to install dependencies with pnpm: lockfile drift");
	});

	it("CacheError formats operation/reason", () => {
		const e = new CacheError({ operation: "save", reason: "ENOSPC" });
		expect(e._tag).toBe("CacheError");
		expect(e.message).toBe("Cache save failed: ENOSPC");
	});
});
