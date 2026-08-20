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

/** The two-part Actions cache key the built kcov tree is stored under. */
export interface KcovCacheKey {
	/** The key a save writes and an exact restore matches. */
	readonly primary: string;
	/**
	 * The fallback rung, handed to `ActionCache.restore` as its restore-key
	 * ladder: any entry whose key starts with this prefix will do.
	 */
	readonly restorePrefix: string;
}

/**
 * The Actions cache key the built kcov tree is stored under, as a primary key
 * and the prefix a restore falls back to.
 *
 * @remarks
 * The prefix is `ImageOS` (`ubuntu24`, `macos15`) and the primary appends
 * `ImageVersion`. That is **not** a reversal of the earlier
 * ImageOS-over-ImageVersion decision — that decision assumed `ImageVersion` as
 * the *sole* key, where a roughly weekly bump means a cold cache and a
 * multi-minute rebuild for nothing. It was incomplete rather than wrong: with
 * an `ImageOS` prefix underneath it, a bump misses the primary, restores warm
 * from the prefix, and re-saves under the new primary. The cache stays warm
 * across a bump *and* gains what a single key can never have.
 *
 * What it gains is **self-healing**. Cache entries are immutable and a save to
 * an existing key is a success, so under a single key a tree whose system
 * libraries have moved is poisoned permanently: every run restores it, fails
 * the verify probe, rebuilds, saves to the same taken key, and throws the good
 * tree away — correct every time and permanently slow, for the ~2 years an LTS
 * `ImageOS` lives. With the ladder, the rebuild lands on a *new* primary, and
 * the next run exact-hits a binary that works.
 *
 * `imageVersion` is an **argument** and `Option.none()` is a first-class case:
 * a self-hosted runner sets no such variable, and the primary then collapses to
 * the prefix, degrading exactly to the previous single-key behavior rather than
 * minting a `…-undefined` key nothing will ever match.
 *
 * `bust` sits in the **prefix**, not on the end of the primary, so that
 * `cache-bust` still does what it is documented to do. Appended after
 * `imageVersion` it would namespace the primary while leaving the fallback rung
 * matching every un-busted entry — a forced miss that silently restores anyway.
 */
export const kcovCacheKey = (
	version: string,
	imageOs: string,
	arch: string,
	bust: Option.Option<string>,
	imageVersion: Option.Option<string> = Option.none(),
): KcovCacheKey => {
	const base = `kcov-${version}-${imageOs}-${arch}`;
	const restorePrefix = Option.match(bust, { onNone: () => base, onSome: (value) => `${base}-${value}` });
	return {
		primary: Option.match(imageVersion, {
			onNone: () => restorePrefix,
			onSome: (value) => `${restorePrefix}-${value}`,
		}),
		restorePrefix,
	};
};
