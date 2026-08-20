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

import { CacheKey } from "@effected/github-actions";
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

/** How many hex characters of the bust digest the key segment carries. */
const DIGEST_LENGTH = 8;

/**
 * The Actions cache key the built kcov tree is stored under, ladder and all.
 *
 * @remarks
 * A typed `CacheKey` rather than a hand-rolled primary/prefix pair: the kit
 * already owns this concept, `ActionCache.restore` reads the rungs straight off
 * the key, and that is what makes the primary and its fallbacks unable to drift
 * apart. `restore-cache` states the same rule for the dependency cache.
 *
 * The segments are `kcov-<version>-<imageOs>-<arch>-<bustDigest>[-<imageVersion>]`,
 * with one rung that keeps everything but `imageVersion`.
 *
 * **`ImageOS` in the rung, `ImageVersion` in the primary.** This is not a
 * reversal of the earlier ImageOS-over-ImageVersion decision — that decision
 * assumed `ImageVersion` as the *sole* key, where a roughly weekly bump means a
 * cold cache and a multi-minute rebuild for nothing. It was incomplete rather
 * than wrong: with an `ImageOS` rung underneath it, a bump misses the primary,
 * restores warm off the rung, and re-saves under the new primary. The cache
 * stays warm across a bump *and* gains what a single key can never have.
 *
 * What it gains is **self-healing on the rung**, and the qualifier is exact.
 * Cache entries are immutable and a save to an existing key is a success, so
 * under a single key a tree whose system libraries have moved is poisoned
 * permanently: every run restores it, fails the verify probe, rebuilds, saves
 * to the same taken key, and throws the good tree away — correct every time and
 * permanently slow, for the ~2 years an LTS `ImageOS` lives. With the ladder, a
 * **fallback-rung** restore that fails its probe rebuilds onto a *new* primary,
 * and the next run exact-hits a binary that works.
 *
 * An **exact-key** restore that fails its probe is not healed, and this is the
 * residual the ladder does not remove: the rebuild's key is the one it just
 * restored from, which is taken, so the save is a no-op and the next run
 * repeats restore → probe → rebuild. What the ladder buys there is a *bound*.
 * The poisoning lasts until any primary component moves — in practice the next
 * `ImageVersion` bump, roughly a week — rather than until `ImageOS` turns over.
 * One image-version window instead of two years. Closing it entirely would need
 * a discriminator for failed exact restores, which is not worth a key segment
 * every run pays for to shorten a window this rare.
 *
 * **The bust is a digest segment the rung retains** (oracle 15, and the same
 * shape as `cache-config`'s version digest): it lets a busted run keep the key
 * layout while matching nothing an unbusted run wrote, *and* — the part a
 * trailing bust segment gets wrong — stops an unbusted run's rung from
 * prefix-matching a busted entry in the other direction. A busted run then also
 * drops its ladder entirely, so the restore proves an exact hit rather than
 * being satisfied by a rung.
 *
 * `imageVersion` is an **argument** and `Option.none()` is a first-class case: a
 * self-hosted runner sets no such variable. The primary then collapses onto what
 * would have been the rung and the ladder is dropped, degrading exactly to the
 * previous single-key behavior rather than minting a `…-undefined` key nothing
 * will ever match, or a dead rung nothing can match either.
 */
export const kcovCacheKey = (
	version: string,
	imageOs: string,
	arch: string,
	bust: Option.Option<string>,
	imageVersion: Option.Option<string> = Option.none(),
): CacheKey => {
	const bustDigest = CacheKey.digest(Option.match(bust, { onNone: () => "", onSome: (value) => value }), DIGEST_LENGTH);
	const base = ["kcov", version, imageOs, arch, bustDigest] as const;
	const key = Option.match(imageVersion, {
		onNone: () => CacheKey.of(...base),
		onSome: (value) => CacheKey.of(...base, value),
	});
	// Zero rungs is a *policy*, distinct from absence — absence still selects
	// `CacheKey`'s default every-prefix ladder, whose shorter rungs would drop the
	// bust digest and the arch.
	return Option.isSome(bust) || Option.isNone(imageVersion)
		? key.withoutRestoreKeys()
		: key.withRestoreDepths([base.length]);
};
