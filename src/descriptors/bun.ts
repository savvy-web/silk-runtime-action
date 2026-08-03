import { Result } from "effect";
import type { RuntimeDescriptor, RuntimePlan } from "./descriptor.js";

/**
 * Bun, from its GitHub releases.
 *
 * @remarks
 * Windows is pinned to `x64` regardless of the runner's architecture, because
 * bun publishes no aarch64 Windows build — an arm64 Windows runner gets the
 * x64 artifact and emulation rather than a 404
 * (`legacy-v1/descriptors/bun.ts:11-14`).
 *
 * The archive's single top-level folder repeats the target name, so the target
 * is both the file stem and the wrapper the installer strips before caching.
 * The binary sits at the root of that folder, so nothing remains inside the
 * cached tool to descend into.
 */
export const bun: RuntimeDescriptor = {
	plan: (version, platform, arch) => {
		const windows = platform === "win32";
		const bunArch = windows ? "x64" : arch === "arm64" ? "aarch64" : arch;
		const target = `bun-${windows ? "windows" : platform}-${bunArch}`;
		const plan: RuntimePlan = {
			url: `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${target}.zip`,
			archive: "zip",
			archiveSubPath: target,
			binary: windows ? "bun.exe" : "bun",
		};
		return Result.succeed(plan);
	},
};
