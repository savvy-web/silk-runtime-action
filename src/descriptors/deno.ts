import { Result } from "effect";
import type { RuntimeDescriptor, RuntimePlan } from "./descriptor.js";

/**
 * Deno names its artifacts by Rust target triple, so the mapping is a closed
 * table rather than a pair of substitutions — and a host outside it is a
 * refusal, not a guess (`legacy-v1/descriptors/deno.ts:9-22`).
 */
const TARGETS: Record<string, Record<string, string>> = {
	linux: { x64: "x86_64-unknown-linux-gnu", arm64: "aarch64-unknown-linux-gnu" },
	darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
	win32: { x64: "x86_64-pc-windows-msvc" },
};

/**
 * Deno, from its GitHub releases.
 *
 * @remarks
 * The zip holds the binary alone — no wrapper to strip, nothing to descend
 * into: the cached tool directory *is* the bin directory.
 */
export const deno: RuntimeDescriptor = {
	plan: (version, platform, arch) => {
		const target = TARGETS[platform]?.[arch];
		if (target === undefined) return Result.fail(`Unsupported platform for Deno: ${platform}-${arch}`);
		const plan: RuntimePlan = {
			url: `https://github.com/denoland/deno/releases/download/v${version}/deno-${target}.zip`,
			archive: "zip",
			binary: platform === "win32" ? "deno.exe" : "deno",
		};
		return Result.succeed(plan);
	},
};
