/**
 * Everything the installer needs to put the BATS toolchain on the runner.
 *
 * @remarks
 * Unlike `descriptors/biome.ts` and the runtime descriptors, nothing here takes
 * a host: bats-core and all four helper libraries are shell scripts, published
 * as one platform-independent source tarball each. There is no asset table
 * because there are no assets to choose between.
 *
 * @module descriptors/bats
 */

/** The pinned bats-core version. Bumped by changeset, never by an input. */
export const BATS_CORE_VERSION = "1.14.0";

/**
 * How a helper library's tarball is laid out once extracted.
 *
 * @remarks
 * `load-and-src` is the bats-core org's shape — a `load.bash` beside a `src/`
 * directory. `flat` is `jasonkarns/bats-mock`'s: `stub.bash` and `binstub` at
 * the root, and a `load.bash` that may or may not be there.
 */
export type BatsLibraryLayout = "load-and-src" | "flat";

/** One helper library, resolved to a tarball and a layout. */
export interface BatsLibraryPlan {
	readonly name: string;
	readonly version: string;
	readonly url: string;
	/** The archive's own wrapper directory, stripped before install. */
	readonly archiveSubPath: string;
	readonly layout: BatsLibraryLayout;
}

/** The pinned helper-library versions, in install order. */
const LIBRARY_VERSIONS = {
	"bats-support": "0.3.0",
	"bats-assert": "2.2.4",
	"bats-file": "0.4.0",
	"bats-mock": "1.2.5",
} as const;

/**
 * bats-core itself.
 *
 * @remarks
 * `binSubPath` is `bin` and no install step is needed: in the release tarball
 * `bin/bats` is a regular 755 file — not a symlink into `libexec` — that
 * resolves its own `libexec/bats-core` relative to `$0` via `readlink -f`.
 * Extracting the tarball and putting `<root>/bin` on `PATH` is the whole
 * install, which is why this action needs neither git nor `install.sh` where
 * the devcontainer feature script needs both.
 */
export const batsCorePlan = (): {
	readonly version: string;
	readonly url: string;
	readonly archiveSubPath: string;
	readonly binSubPath: string;
} => ({
	version: BATS_CORE_VERSION,
	url: `https://github.com/bats-core/bats-core/archive/refs/tags/v${BATS_CORE_VERSION}.tar.gz`,
	archiveSubPath: `bats-core-${BATS_CORE_VERSION}`,
	binSubPath: "bin",
});

/**
 * The four helper libraries, in install order.
 *
 * @remarks
 * `bats-mock` is the odd one and is spelled out rather than derived: it comes
 * from `jasonkarns/bats-mock` rather than the `bats-core` org, and ships the
 * `flat` layout. Deriving its url from the name would silently point at a
 * `bats-core/bats-mock` that does not exist.
 */
export const batsLibraryPlans = (): ReadonlyArray<BatsLibraryPlan> => [
	library("bats-support"),
	library("bats-assert"),
	library("bats-file"),
	{
		name: "bats-mock",
		version: LIBRARY_VERSIONS["bats-mock"],
		url: `https://github.com/jasonkarns/bats-mock/archive/refs/tags/v${LIBRARY_VERSIONS["bats-mock"]}.tar.gz`,
		archiveSubPath: `bats-mock-${LIBRARY_VERSIONS["bats-mock"]}`,
		layout: "flat",
	},
];

/** One bats-core-org library, whose url and layout are uniform. */
const library = (name: "bats-support" | "bats-assert" | "bats-file"): BatsLibraryPlan => ({
	name,
	version: LIBRARY_VERSIONS[name],
	url: `https://github.com/bats-core/${name}/archive/refs/tags/v${LIBRARY_VERSIONS[name]}.tar.gz`,
	archiveSubPath: `${name}-${LIBRARY_VERSIONS[name]}`,
	layout: "load-and-src",
});
