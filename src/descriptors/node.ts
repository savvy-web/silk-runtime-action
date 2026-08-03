import { Result } from "effect";
import type { RuntimeDescriptor, RuntimePlan } from "./descriptor.js";

/**
 * Node's own arch spelling, where it differs from `process.arch`.
 *
 * @remarks
 * Anything unmapped passes through, which is legacy behavior
 * (`legacy-v1/descriptors/node.ts:20`): an arch nodejs.org does not publish
 * becomes a 404 at download time rather than a resolve failure here. Node
 * builds for far more architectures than a fixed table would admit, so
 * guessing wrong in the direction of "try it" is the cheaper mistake.
 */
const ARCHES: Record<string, string> = { x64: "x64", arm64: "arm64", arm: "armv7l" };

/**
 * Node.js, from `https://nodejs.org/dist`.
 *
 * @remarks
 * Both archives nest everything inside a `node-v{version}-{platform}-{arch}`
 * wrapper directory. The tarball has `--strip=1` remove it during extraction,
 * leaving `bin` at the top; the zip has no equivalent, so the Windows plan
 * names the wrapper as its `archiveSubPath` and the installer descends into it
 * before caching. Legacy did neither (`legacy-v1/descriptors/node.ts:33-38`) —
 * its `PATH` entry pointed at the cache root and never reached `node.exe`, and
 * its verify passed anyway because it probed the runner's preinstalled Node.
 */
export const node: RuntimeDescriptor = {
	plan: (version, platform, arch) => {
		const windows = platform === "win32";
		const stem = `node-v${version}-${windows ? "win" : platform}-${ARCHES[arch] ?? arch}`;
		const plan: RuntimePlan = windows
			? {
					url: `https://nodejs.org/dist/v${version}/${stem}.zip`,
					archive: "zip",
					archiveSubPath: stem,
					binary: "node.exe",
				}
			: {
					url: `https://nodejs.org/dist/v${version}/${stem}.tar.gz`,
					archive: "tar.gz",
					binSubPath: "bin",
					tarFlags: ["xz", "--strip=1", "-f"],
					binary: "node",
				};
		return Result.succeed(plan);
	},
};
