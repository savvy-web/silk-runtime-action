/**
 * Everything the installer needs to build kcov on one host.
 *
 * @remarks
 * kcov is **built from source on every supported platform**, which is a
 * conclusion rather than a preference. The last release publishing a binary
 * asset is v42, and that binary links `libbfd-2.38-system.so` /
 * `libopcodes-2.38-system.so` — binutils 2.38, i.e. Ubuntu 22.04 — so it does
 * not load on the 24.04 runner image. Homebrew publishes exactly one bottle
 * (`arm64_tahoe`, macOS 26), so `brew install kcov` on macOS 15 compiles inside
 * Homebrew anyway. Building here, into a cache this action controls, is the
 * only path that is both current and fast on the second run.
 *
 * @module descriptors/kcov
 */

import { Option, Result } from "effect";

/** The pinned kcov version. Bumped by changeset, never by an input. */
export const KCOV_VERSION = "43";

/** Everything the kcov install needs, resolved for one host. */
export interface KcovPlan {
	readonly version: string;
	/** Where the source tarball is fetched from. */
	readonly url: string;
	/** The archive's own wrapper directory, stripped before the build. */
	readonly archiveSubPath: string;
	/**
	 * Package names to install before `cmake` runs, in the host's own package
	 * manager's vocabulary — apt on Linux, Homebrew on macOS.
	 */
	readonly buildDeps: ReadonlyArray<string>;
	readonly binary: string;
}

/** apt packages kcov's cmake build needs on Linux. */
const LINUX_BUILD_DEPS = [
	"cmake",
	"g++",
	"libdw-dev",
	"binutils-dev",
	"libcurl4-openssl-dev",
	"zlib1g-dev",
	"pkg-config",
] as const;

/**
 * Homebrew formulae kcov's cmake build needs on macOS.
 *
 * @remarks
 * `cmake` is absent deliberately — it is preinstalled on GitHub's macOS runner
 * images, and asking Homebrew to install it costs a formula resolution for
 * nothing. These two are exactly the Homebrew `kcov` formula's own
 * dependencies.
 */
const DARWIN_BUILD_DEPS = ["dwarfutils", "openssl@3"] as const;

/**
 * kcov, from its GitHub source tarball.
 *
 * @remarks
 * Pure and total in the same sense as the runtime descriptors: the host is an
 * **argument**, so every platform is exercisable in a unit test.
 *
 * Windows is a `Result` failure rather than a silent skip — kcov has no Windows
 * build at all, and the caller renders the message as the warning that explains
 * why `kcov-enabled` is `false`.
 */
export const kcov = {
	plan: (version: string, platform: string, arch: string): Result.Result<KcovPlan, string> => {
		const buildDeps = platform === "linux" ? LINUX_BUILD_DEPS : platform === "darwin" ? DARWIN_BUILD_DEPS : undefined;
		if (buildDeps === undefined) return Result.fail(`Unsupported platform for kcov: ${platform}-${arch}`);
		return Result.succeed({
			version,
			url: `https://github.com/SimonKagstrom/kcov/archive/refs/tags/v${version}.tar.gz`,
			archiveSubPath: `kcov-${version}`,
			buildDeps,
			binary: "kcov",
		});
	},
};

/**
 * The Actions cache key the built kcov tree is stored under.
 *
 * @remarks
 * `imageOs` is `ImageOS` (`ubuntu24`, `macos15`) and **not** `ImageVersion`.
 * `ImageVersion` bumps roughly weekly, which would reduce this cache to near
 * -uselessness; `ImageOS` is stable across an image generation. The residual
 * risk — system libraries moving *within* one generation, leaving a key valid
 * and its binary unloadable — is what the install step's verify probe exists to
 * catch. The key narrows the window; the probe closes it.
 */
export const kcovCacheKey = (version: string, imageOs: string, arch: string, bust: Option.Option<string>): string => {
	const base = `kcov-${version}-${imageOs}-${arch}`;
	return Option.match(bust, { onNone: () => base, onSome: (value) => `${base}-${value}` });
};
