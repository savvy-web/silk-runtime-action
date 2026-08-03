import type { Result } from "effect";

/**
 * Everything the installer needs to put one runtime on the runner, resolved
 * for one host.
 *
 * @remarks
 * A single value rather than the legacy pair of `getDownloadUrl` +
 * `getToolInstallOptions` (`legacy-v1/services/runtime-installer.ts:41-50`),
 * because both halves derive from the same platform/arch mapping and computing
 * it twice is how the two can disagree — bun's legacy descriptor resolved its
 * arch string once per call in each of them.
 *
 * Both subpaths are **relative** segments, joined by the caller through the
 * `Path` service. Legacy had one of them and interpolated it with a hard-coded
 * `/` (`:112`), which is wrong on the one platform that needs it.
 */
export interface RuntimePlan {
	/** Where the archive is fetched from. */
	readonly url: string;
	/** Which extraction the archive needs. */
	readonly archive: "tar.gz" | "zip";
	/**
	 * The archive's own wrapper directory, stripped **before** the tool is
	 * cached.
	 *
	 * @remarks
	 * The tool cache is shared: `<RUNNER_TOOL_CACHE>/<tool>/<version>/<arch>` is
	 * also written by the runner image and by `setup-node`/`setup-bun`, and none
	 * of those nest the tool inside a `node-v24.11.0-win-x64/` wrapper. Caching
	 * the wrapper would put a directory at that path that only this action knows
	 * how to read — and that its **own** cache-hit path could not read either,
	 * since a hit returns the cached root and has no extracted archive to
	 * descend into. Stripping it pre-cache keeps the cached root canonical for
	 * every reader.
	 */
	readonly archiveSubPath?: string;
	/**
	 * The directory **inside** the cached tool that holds the binary, when it is
	 * not the root — node's `bin` on Unix, and nothing else so far.
	 */
	readonly binSubPath?: string;
	/** Flags for `tar`, when the archive needs something other than the default. */
	readonly tarFlags?: ReadonlyArray<string>;
	/** The binary's file name, including the Windows extension. */
	readonly binary: string;
}

/**
 * A pure mapping from a requested version and a host to a {@link RuntimePlan}.
 *
 * @remarks
 * Pure and total: the host is an **argument**, never `process.platform` read
 * inside, so every platform is exercisable in a unit test without monkey
 * -patching the process. A host a runtime publishes no build for is a
 * `Result` failure carrying the message the installer reports, not a thrown
 * exception as in legacy (`legacy-v1/descriptors/deno.ts:29`).
 */
export interface RuntimeDescriptor {
	readonly plan: (version: string, platform: string, arch: string) => Result.Result<RuntimePlan, string>;
}
