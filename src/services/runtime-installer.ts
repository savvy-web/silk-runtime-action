import { ActionOutputs, CommandRunner, ToolInstaller } from "@savvy-web/github-action-effects";
import { Context, Effect, Layer } from "effect";
import { descriptor as bunDescriptor } from "../descriptors/bun.js";
import { descriptor as denoDescriptor } from "../descriptors/deno.js";
import { descriptor as nodeDescriptor } from "../descriptors/node.js";
import { RuntimeInstallError } from "../errors/errors.js";

/**
 * Extract a human-readable reason from an error.
 * Effect TaggedErrors have a `message` that may be empty and store data in custom fields.
 */
export const extractErrorReason = (error: unknown): string => {
	if (error && typeof error === "object") {
		const e = error as Record<string, unknown>;
		if (typeof e.reason === "string" && e.reason) return e.reason;
		if (typeof e.message === "string" && e.message) return e.message;
		if (typeof e._tag === "string") return `${e._tag}${e.reason ? `: ${e.reason}` : ""}`;
	}
	if (error instanceof Error && error.message) return error.message;
	const str = String(error);
	return str || "Unknown error";
};

/**
 * Formats structured cause detail from an error's cause field.
 * Returns a human-readable string or undefined if no structured cause exists.
 */
export const formatCauseDetail = (error: unknown): string | undefined => {
	if (error && typeof error === "object" && "cause" in error) {
		const cause = (error as { cause?: Record<string, unknown> }).cause;
		if (cause) {
			return `reason=${cause.reason ?? "?"}, operation=${cause.operation ?? "?"}, key=${cause.key ?? "?"}`;
		}
	}
	return undefined;
};

/**
 * Descriptor for a runtime or tool that can be installed.
 */
export interface RuntimeDescriptor {
	readonly name: string;
	readonly getDownloadUrl: (version: string, platform: string, arch: string) => string;
	readonly getToolInstallOptions: (
		version: string,
		platform: string,
		arch: string,
	) => Partial<{ archiveType: "tar.gz" | "tar.xz" | "zip"; binSubPath: string; tarFlags: ReadonlyArray<string> }>;
	readonly verifyCommand: readonly [string, ...string[]];
}

/**
 * Result of a successful runtime installation.
 */
export interface InstalledRuntime {
	readonly name: string;
	readonly version: string;
	readonly path: string;
}

/**
 * Service shape for installing a specific runtime.
 */
export interface RuntimeInstallerShape {
	readonly install: (
		version: string,
	) => Effect.Effect<InstalledRuntime, RuntimeInstallError, ToolInstaller | CommandRunner | ActionOutputs>;
}

/**
 * Service for installing a specific runtime.
 *
 * Context.Service class form so callers can `yield* RuntimeInstaller` and
 * downstream typing resolves through the static service identity.
 */
export class RuntimeInstaller extends Context.Service<RuntimeInstaller, RuntimeInstallerShape>()("RuntimeInstaller") {}

/**
 * Factory: creates a RuntimeInstaller from a descriptor.
 */
export const makeRuntimeInstaller = (descriptor: RuntimeDescriptor): RuntimeInstallerShape => ({
	install: (version) =>
		Effect.gen(function* () {
			const toolInstaller = yield* ToolInstaller;
			const runner = yield* CommandRunner;
			const outputs = yield* ActionOutputs;

			const url = yield* Effect.try({
				try: () => descriptor.getDownloadUrl(version, process.platform, process.arch),
				catch: (e) => e,
			});
			const options = yield* Effect.try({
				try: () => descriptor.getToolInstallOptions(version, process.platform, process.arch),
				catch: (e) => e,
			});

			// Download the archive
			const downloadedPath = yield* toolInstaller.download(url);

			// Extract the archive
			let extractedDir: string;
			if (options.archiveType === "zip") {
				extractedDir = yield* toolInstaller.extractZip(downloadedPath);
			} else {
				extractedDir = yield* toolInstaller.extractTar(downloadedPath, undefined, options.tarFlags);
			}

			// Cache the extracted directory
			const cachedPath = yield* toolInstaller.cacheDir(extractedDir, descriptor.name, version);

			// Determine the path to add to PATH (may include binSubPath)
			const toolPath = options.binSubPath ? `${cachedPath}/${options.binSubPath}` : cachedPath;

			// Add to PATH
			yield* outputs.addPath(toolPath);

			// Verify the installation
			yield* runner.exec(descriptor.verifyCommand[0], [...descriptor.verifyCommand.slice(1)]);

			return { name: descriptor.name, version, path: toolPath } satisfies InstalledRuntime;
		}).pipe(
			Effect.catch((error) =>
				Effect.fail(
					new RuntimeInstallError({
						runtime: descriptor.name,
						version,
						reason: extractErrorReason(error),
						cause: error,
					}),
				),
			),
		),
});

/**
 * Pre-built layers for each supported runtime.
 */
export const NodeInstallerLive = Layer.succeed(RuntimeInstaller, makeRuntimeInstaller(nodeDescriptor));
export const BunInstallerLive = Layer.succeed(RuntimeInstaller, makeRuntimeInstaller(bunDescriptor));
export const DenoInstallerLive = Layer.succeed(RuntimeInstaller, makeRuntimeInstaller(denoDescriptor));

/**
 * Returns the appropriate installer layer for the given runtime name.
 */
export const installerLayerFor = (name: string): Layer.Layer<RuntimeInstaller, RuntimeInstallError> => {
	switch (name) {
		case "node":
			return NodeInstallerLive;
		case "bun":
			return BunInstallerLive;
		case "deno":
			return DenoInstallerLive;
		default:
			return Layer.effect(
				RuntimeInstaller,
				Effect.fail(
					new RuntimeInstallError({
						runtime: name,
						version: "unknown",
						reason: `Unknown runtime: ${name}`,
					}),
				),
			);
	}
};
