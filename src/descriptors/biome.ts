import { Result } from "effect";

/**
 * Everything the installer needs to put Biome on the runner, resolved for one
 * host.
 *
 * @remarks
 * Not a {@link RuntimePlan}: Biome ships a bare executable, so there is no
 * archive, no extraction and no layout fixup — the two fields left are the only
 * two that vary. `ToolInstaller.provisionFile` takes exactly this pair.
 */
export interface BiomePlan {
	/** Where the executable is fetched from. */
	readonly url: string;
	/**
	 * The name the executable is cached under, and therefore what it is invoked
	 * as once its directory is on the `PATH`.
	 *
	 * @remarks
	 * Deliberately *not* the asset's own name: the release asset is
	 * `biome-linux-x64`, and caching it under that name would put a tool on the
	 * `PATH` that answers to a host-specific spelling nobody writes in a
	 * workflow. v1 renamed it the same way (oracle 17).
	 */
	readonly binary: string;
}

/**
 * Biome's release assets, by platform and arch (oracle 14).
 *
 * @remarks
 * The six combinations biome publishes, verbatim — no musl variant and no
 * freebsd, so a musl runner resolves the gnu asset exactly as v1 did. The
 * `.exe` suffix is part of the asset name on Windows and is not derived.
 */
const ASSETS: Record<string, Record<string, string>> = {
	linux: { x64: "biome-linux-x64", arm64: "biome-linux-arm64" },
	darwin: { x64: "biome-darwin-x64", arm64: "biome-darwin-arm64" },
	win32: { x64: "biome-win32-x64.exe", arm64: "biome-win32-arm64.exe" },
};

/**
 * The release tag's npm-package prefix, percent-encoded.
 *
 * @remarks
 * biome tags releases as `@biomejs/biome@2.4.9`, and both the `@` and the `/`
 * have to be encoded to survive the url path. The version itself is
 * interpolated unencoded, matching v1 (oracle 16) — a version with a character
 * needing encoding is not a version biome has ever published.
 */
const TAG_PREFIX = "%40biomejs%2Fbiome%40";

/**
 * Biome, from its GitHub releases.
 *
 * @remarks
 * Pure and total in the same sense as the runtime descriptors: the host is an
 * **argument**, so every platform is exercisable in a unit test. v1 read
 * `os.platform()` inside the install step, which is why no v1 test ever covered
 * a second platform (oracle 13).
 */
export const biome = {
	plan: (version: string, platform: string, arch: string): Result.Result<BiomePlan, string> => {
		const asset = ASSETS[platform]?.[arch];
		if (asset === undefined) return Result.fail(`Unsupported platform for Biome: ${platform}-${arch}`);
		return Result.succeed({
			url: `https://github.com/biomejs/biome/releases/download/${TAG_PREFIX}${version}/${asset}`,
			binary: platform === "win32" ? "biome.exe" : "biome",
		});
	},
};
