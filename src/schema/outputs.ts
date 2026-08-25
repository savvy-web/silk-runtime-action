import type { ActionOutputError } from "@effected/github-actions";
import { ActionOutputs } from "@effected/github-actions";
import { Effect } from "effect";

/**
 * The 22 `action.yml` output names, verbatim, as a const tuple.
 */
export const OUTPUT_NAMES = [
	"node-version",
	"node-enabled",
	"bun-version",
	"bun-enabled",
	"deno-version",
	"deno-enabled",
	"package-manager",
	"package-manager-version",
	"biome-version",
	"biome-enabled",
	"bats-enabled",
	"bats-version",
	"bats-lib-path",
	"kcov-enabled",
	"kcov-version",
	"kcov-cache-hit",
	"turbo-enabled",
	"turbo-cache-backend",
	"turbo-cache-port",
	"cache-hit",
	"store-cache-hit",
	"lockfiles",
	"cache-paths",
] as const;

/**
 * A single `action.yml` output name.
 */
export type OutputName = (typeof OUTPUT_NAMES)[number];

/**
 * The fully-typed shape of all 22 `action.yml` outputs.
 */
export interface OutputsModel {
	readonly nodeVersion: string;
	readonly nodeEnabled: boolean;
	readonly bunVersion: string;
	readonly bunEnabled: boolean;
	readonly denoVersion: string;
	readonly denoEnabled: boolean;
	readonly packageManager: string;
	readonly packageManagerVersion: string;
	readonly biomeVersion: string;
	readonly biomeEnabled: boolean;
	readonly batsEnabled: boolean;
	readonly batsVersion: string;
	readonly batsLibPath: string;
	readonly kcovEnabled: boolean;
	readonly kcovVersion: string;
	readonly kcovCacheHit: boolean;
	readonly turboEnabled: boolean;
	readonly turboCacheBackend: "github" | "s3" | "remote" | "none";
	readonly turboCachePort: string;
	readonly cacheHit: "true" | "partial" | "false";
	/**
	 * How the package-manager store restore went.
	 *
	 * @remarks
	 * Separate from {@link OutputsModel.cacheHit} because the two entries hit and
	 * miss independently — that is the whole point of the split. A `"false"` here
	 * beside a `"true"` there is the shape of a job that restored its linked trees
	 * and will still download every package, which is exactly the failure this
	 * output exists to make visible.
	 */
	readonly storeCacheHit: "true" | "partial" | "false";
	readonly lockfiles: string;
	readonly cachePaths: string;
}

/**
 * All-disabled defaults: every version/list field empty, every boolean
 * `false`, `turboCacheBackend: "none"`, `cacheHit: "false"`. The baseline a
 * run starts from before any feature enables itself.
 */
export const initialOutputs: OutputsModel = {
	nodeVersion: "",
	nodeEnabled: false,
	bunVersion: "",
	bunEnabled: false,
	denoVersion: "",
	denoEnabled: false,
	packageManager: "",
	packageManagerVersion: "",
	biomeVersion: "",
	biomeEnabled: false,
	batsEnabled: false,
	batsVersion: "",
	batsLibPath: "",
	kcovEnabled: false,
	kcovVersion: "",
	kcovCacheHit: false,
	turboEnabled: false,
	turboCacheBackend: "none",
	turboCachePort: "",
	cacheHit: "false",
	storeCacheHit: "false",
	lockfiles: "",
	cachePaths: "",
};

/**
 * Publishes every `action.yml` output exactly once, via `ActionOutputs.set`.
 * Booleans are rendered with `String(v)` (`"true"` / `"false"`); the rest are
 * already strings.
 */
export const emitOutputs = (model: OutputsModel): Effect.Effect<void, ActionOutputError, ActionOutputs> =>
	Effect.gen(function* () {
		const outputs = yield* ActionOutputs;
		yield* outputs.set("node-version", model.nodeVersion);
		yield* outputs.set("node-enabled", String(model.nodeEnabled));
		yield* outputs.set("bun-version", model.bunVersion);
		yield* outputs.set("bun-enabled", String(model.bunEnabled));
		yield* outputs.set("deno-version", model.denoVersion);
		yield* outputs.set("deno-enabled", String(model.denoEnabled));
		yield* outputs.set("package-manager", model.packageManager);
		yield* outputs.set("package-manager-version", model.packageManagerVersion);
		yield* outputs.set("biome-version", model.biomeVersion);
		yield* outputs.set("biome-enabled", String(model.biomeEnabled));
		yield* outputs.set("bats-enabled", String(model.batsEnabled));
		yield* outputs.set("bats-version", model.batsVersion);
		yield* outputs.set("bats-lib-path", model.batsLibPath);
		yield* outputs.set("kcov-enabled", String(model.kcovEnabled));
		yield* outputs.set("kcov-version", model.kcovVersion);
		yield* outputs.set("kcov-cache-hit", String(model.kcovCacheHit));
		yield* outputs.set("turbo-enabled", String(model.turboEnabled));
		yield* outputs.set("turbo-cache-backend", model.turboCacheBackend);
		yield* outputs.set("turbo-cache-port", model.turboCachePort);
		yield* outputs.set("cache-hit", model.cacheHit);
		yield* outputs.set("store-cache-hit", model.storeCacheHit);
		yield* outputs.set("lockfiles", model.lockfiles);
		yield* outputs.set("cache-paths", model.cachePaths);
	});
