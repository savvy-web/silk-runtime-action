/**
 * Provisions kcov, from the Actions cache when it can and from source when it
 * must.
 *
 * @module steps/install-kcov
 */

import { Run } from "@effected/commands";
import type { ActionLogger } from "@effected/github-actions";
import { ActionCache, ActionOutputs, ActionState, ToolInstaller } from "@effected/github-actions";
import { Data, Effect, FileSystem, Option, Path, Result } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { ChildProcess } from "effect/unstable/process";

import type { KcovPlan } from "../descriptors/kcov.js";
import { KCOV_VERSION, kcov, kcovCacheKey } from "../descriptors/kcov.js";
import { KcovCacheState, STATE_KEYS } from "../state.js";
import type { Host } from "./install-runtimes.js";
import { currentHost } from "./install-runtimes.js";

/**
 * Raised when kcov cannot be provisioned.
 *
 * @remarks
 * `verify` is distinct from `build` on purpose: a build that succeeded and then
 * produced a binary that will not run is a different problem from one that
 * failed to compile, and the warning a consumer reads should say which.
 */
export class KcovInstallError extends Data.TaggedError("KcovInstallError")<{
	readonly reason: "detect" | "download" | "build" | "verify" | "publish";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** What this step put on the runner. */
export interface InstalledKcov {
	readonly version: string;
	readonly binDir: string;
	readonly cacheHit: boolean;
}

/**
 * An environment value that is actually present, treating `""` as absent.
 *
 * @remarks
 * The runner exports an empty string for a variable it has no value for, which
 * `??` happily keeps — and an empty key segment is worse than a missing one,
 * because it mints a namespace nothing else on that runner will ever match.
 */
const nonEmpty = (value: string | undefined): string | undefined =>
	value === undefined || value === "" ? undefined : value;

/**
 * Whether `kcov --version` runs at all.
 *
 * @remarks
 * `Run.succeeds` already collapses a spawn failure — an absent executable, a
 * missing shared library, a refused exec — to `false`, so there is nothing to
 * catch: every way a restored binary can fail to load arrives here as the same
 * `false`, which is exactly the granularity the caller acts on.
 */
const probe = (binary: string): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Run.succeeds(ChildProcess.make(binary, ["--version"]));

/**
 * Runs one build command, mapping anything but a zero exit to `build`.
 *
 * @remarks
 * `Run.collect` rather than `Run.text`: a non-zero exit is a *result* there, so
 * the failing command's `stderr` is readable and lands in the message. `Run.text`
 * would fail the effect and throw that distinction away, leaving a caller with
 * "the build failed" and no cmake or apt diagnostic to act on.
 */
const step = (
	command: ChildProcess.Command,
	label: string,
): Effect.Effect<void, KcovInstallError, ChildProcessSpawner.ChildProcessSpawner> =>
	Run.collect(command).pipe(
		Effect.catch((cause) =>
			Effect.fail(
				new KcovInstallError({ reason: "build", message: `${label} could not be run: ${cause.message}`, cause }),
			),
		),
		Effect.flatMap((output) =>
			output.exitCode === 0
				? Effect.void
				: Effect.fail(
						new KcovInstallError({
							reason: "build",
							message: `${label} failed (exit ${output.exitCode}): ${output.stderr.trim()}`,
						}),
					),
		),
	);

/**
 * Makes the installed tree reachable to every later step in the job.
 *
 * @remarks
 * `KCOV_PATH` is exported beside the `PATH` entry for the same reason
 * `install-bats` exports `BATS_PATH`: a consumer that spawns the binary
 * directly should not have to re-derive the tool-cache layout, and a `PATH`
 * entry alone leaves it guessing.
 */
const publish = (
	binDir: string,
	binary: string,
	version: string,
): Effect.Effect<void, KcovInstallError, ActionOutputs> =>
	Effect.gen(function* () {
		const outputs = yield* ActionOutputs;
		const guard = (effect: Effect.Effect<void, { readonly message: string }>) =>
			effect.pipe(
				Effect.catch((cause) =>
					Effect.fail(
						new KcovInstallError({
							reason: "publish",
							message: `kcov ${version} could not be published: ${cause.message}`,
							cause,
						}),
					),
				),
			);
		yield* guard(outputs.addPath(binDir));
		yield* guard(outputs.exportVariable("KCOV_PATH", binary));
	});

/**
 * Compiles kcov from its source tarball into `prefix`.
 *
 * @remarks
 * This is the one place the action shells out to a **system** package manager,
 * and it is why `sudo` matters: on a runner without it the dependency install
 * fails, this step fails typed with `build`, and the caller degrades to a
 * warning — bats without coverage — rather than aborting the job.
 *
 * The dependency install runs only here, on the miss path. A cache hit whose
 * probe passed needs neither apt nor Homebrew, which is most of what the cache
 * is worth.
 */
const build = (
	plan: KcovPlan,
	prefix: string,
	host: Host,
): Effect.Effect<
	void,
	KcovInstallError,
	ToolInstaller | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | ActionLogger
> =>
	Effect.gen(function* () {
		const installer = yield* ToolInstaller;
		const fs = yield* FileSystem.FileSystem;
		const path = yield* Path.Path;

		const download = (cause: { readonly message: string }) =>
			Effect.fail(
				new KcovInstallError({
					reason: "download",
					message: `kcov ${plan.version} source could not be fetched: ${cause.message}`,
					cause,
				}),
			);

		const archive = yield* installer.download(plan.url).pipe(Effect.catch(download));
		const extracted = yield* installer.extractTar(archive).pipe(Effect.catch(download));
		const sourceDir = path.join(extracted, plan.archiveSubPath);

		// cmake refuses an in-source build, so the object tree is a sibling of the
		// unpacked source rather than a directory inside it.
		const buildDir = path.join(extracted, "build");
		yield* fs
			.makeDirectory(buildDir, { recursive: true })
			.pipe(
				Effect.catch((cause) =>
					Effect.fail(
						new KcovInstallError({ reason: "build", message: `Could not create ${buildDir}: ${cause.message}`, cause }),
					),
				),
			);

		const deps = [...plan.buildDeps];
		if (host.platform === "linux") {
			yield* step(ChildProcess.make("sudo", ["apt-get", "update"]), "apt-get update");
			yield* step(
				ChildProcess.make("sudo", ["apt-get", "install", "-y", "--no-install-recommends", ...deps]),
				"apt-get install",
			);
		} else {
			yield* step(ChildProcess.make("brew", ["install", ...deps]), "brew install");
		}

		yield* step(
			ChildProcess.make("cmake", [`-DCMAKE_INSTALL_PREFIX=${prefix}`, sourceDir], { cwd: buildDir }),
			"cmake",
		);
		yield* step(ChildProcess.make("make", ["-j"], { cwd: buildDir }), "make");
		yield* step(ChildProcess.make("make", ["install"], { cwd: buildDir }), "make install");
		yield* Effect.logDebug(`kcov ${plan.version} built into ${prefix}`);
	});

/**
 * Hands `post` what it needs to write the tree back to the cache.
 *
 * @remarks
 * Best-effort by design: a run whose kcov works but whose successor rebuilds it
 * is a slower run, not a broken one, and failing the install over a state write
 * would make it one. The failure is logged rather than swallowed so a degraded
 * `GITHUB_STATE` is visible in the workflow log instead of showing up a week
 * later as an unexplained cold cache.
 */
const stash = (
	prefix: string,
	primaryKey: string,
	restoredKey: Option.Option<string>,
): Effect.Effect<void, never, ActionState | ActionLogger> =>
	Effect.gen(function* () {
		const state = yield* ActionState;
		yield* state
			.save(STATE_KEYS.kcovCache, new KcovCacheState({ paths: [prefix], primaryKey, restoredKey }), KcovCacheState)
			.pipe(
				Effect.catch((cause) =>
					Effect.logWarning(`kcov cache state could not be saved — the next run will rebuild: ${cause.message}`),
				),
			);
	});

/**
 * Provisions kcov, when this run decided to.
 *
 * @remarks
 * The shape is restore → probe → build, and the **probe on a cache hit is the
 * load-bearing part**. `install-biome` deliberately has no verify probe
 * (oracle 22) because Biome is a single static executable. kcov is not: it links
 * `libdw`, `libbfd`, `libelf` and `libcurl` against the runner's system
 * libraries, so a cache entry can be simultaneously valid by key and unloadable
 * in practice when an image moves within one `ImageOS` generation. The key
 * narrows that window and the probe closes it — and the fall-through to a
 * rebuild is what makes it a mitigation rather than merely a detection. A probe
 * that reported failure without rebuilding would be strictly worse than no
 * probe at all.
 *
 * An unsupported platform fails before the cache is ever consulted: there is no
 * key that could be right, and a restore attempt would only spend a round trip
 * to say so.
 *
 * The state save is best-effort. It exists so `post` can write the built tree
 * back to the cache; a run whose kcov works but whose next run rebuilds it is a
 * slower run, not a broken one, and failing the install over it would be.
 */
export const installKcov = (
	install: boolean,
	options: {
		readonly host?: Host;
		readonly imageOs?: string;
		readonly imageVersion?: Option.Option<string>;
		readonly bust?: Option.Option<string>;
		readonly toolRoot?: string;
	} = {},
): Effect.Effect<
	Option.Option<InstalledKcov>,
	KcovInstallError,
	| ToolInstaller
	| ActionCache
	| ActionState
	| ActionOutputs
	| FileSystem.FileSystem
	| Path.Path
	| ChildProcessSpawner.ChildProcessSpawner
	| ActionLogger
> =>
	Effect.gen(function* () {
		if (!install) return Option.none();

		const host = options.host ?? currentHost();
		// Empty is absent, matching `ImageVersion` below — the comment there used to
		// claim the two were "treated identically" while this line filtered only
		// `null`/`undefined`. A runner exporting `ImageOS=""` would have keyed on
		// `kcov-43--x64-…`, a namespace the `<platform>-unknown` fallback that same
		// runner uses everywhere else never matches, so its cache would stay cold
		// forever without ever looking wrong.
		const imageOs = nonEmpty(options.imageOs ?? process.env.ImageOS) ?? `${host.platform}-unknown`;
		// Read beside `ImageOS` and treated identically: an unset or empty variable
		// (every self-hosted runner) is `none`, which collapses the primary key onto
		// the prefix rather than minting one nothing will match.
		const imageVersion =
			options.imageVersion ?? Option.filter(Option.fromNullishOr(process.env.ImageVersion), (v) => v !== "");
		const toolRoot = options.toolRoot ?? process.env.RUNNER_TOOL_CACHE ?? "/opt/hostedtoolcache";
		const bust = options.bust ?? Option.none<string>();

		const planned = kcov.plan(KCOV_VERSION, host.platform, host.arch);
		if (Result.isFailure(planned)) {
			return yield* new KcovInstallError({ reason: "detect", message: planned.failure });
		}
		const plan = planned.success;

		const path = yield* Path.Path;
		const fs = yield* FileSystem.FileSystem;
		const prefix = path.join(toolRoot, "kcov", plan.version, host.arch);
		const binDir = path.join(prefix, "bin");
		const binary = path.join(binDir, plan.binary);
		const key = kcovCacheKey(plan.version, imageOs, host.arch, bust, imageVersion);

		const cache = yield* ActionCache;
		// A cache that cannot be reached is a miss: the build below is the whole
		// fallback, and failing here would turn a degraded cache into a failed job.
		// The typed key carries its own ladder; `ActionCache` reads the rungs off it,
		// so the primary and its fallbacks cannot drift apart.
		const restored = yield* cache
			.restore([prefix], key)
			.pipe(
				Effect.catch((cause) =>
					Effect.logWarning(`kcov cache could not be read: ${cause.message}`).pipe(Effect.as(Option.none<string>())),
				),
			);

		if (Option.isSome(restored)) {
			if (yield* probe(binary)) {
				if (restored.value === key.key) {
					// An exact hit is already in the cache under the key a save would
					// use, so there is nothing for `post` to do and no state to write.
					yield* Effect.logInfo(`kcov ${plan.version} (cached)`);
				} else {
					// The fallback rung matched — the weekly `ImageVersion` bump. The
					// tree is good and warm, but it lives under the *old* primary, so
					// state is stashed and `post` re-saves it under the new one. Skipping
					// this save is the mistake that leaves the ladder permanently one
					// image behind.
					yield* stash(prefix, key.key, restored);
					yield* Effect.logInfo(`kcov ${plan.version} (restored from ${restored.value}, re-saving as ${key.key})`);
				}
				yield* publish(binDir, binary, plan.version);
				return Option.some({ version: plan.version, binDir, cacheHit: true });
			}
			yield* Effect.logWarning(`Restored kcov ${plan.version} could not be executed — rebuilding from source`);
			// Delete the rejected tree before rebuilding over it. `make install`
			// only replaces the files it produces, so anything the restored entry
			// carried that this build does not would survive — and `stash` hands
			// `post` the whole prefix, which would then seal the probe's rejects
			// into the *new* entry. That is the opposite of what this path is for.
			// A failure to remove is not worth failing over: the build still runs,
			// and the worst case is the staleness this delete exists to avoid.
			yield* fs.remove(prefix, { recursive: true }).pipe(Effect.catch(() => Effect.void));
		}

		yield* build(plan, prefix, host);
		if (!(yield* probe(binary))) {
			return yield* new KcovInstallError({
				reason: "verify",
				message: `kcov ${plan.version} was built but could not be executed`,
			});
		}

		// `restoredKey` is `none` on this path whatever the restore did: the tree on
		// disk was just built and nothing about the entry that was restored
		// describes it, so `post` must always attempt the save.
		//
		// That save heals a **rung** restore whose probe failed — the rebuild lands
		// under a primary nothing holds yet, and the next run exact-hits it. It does
		// NOT heal an **exact** restore whose probe failed: the key is the one just
		// restored from, the entry is immutable, and the save is a no-op, so the
		// next run repeats restore → probe → rebuild until an `ImageVersion` bump
		// mints a new primary. Bounded to one image-version window rather than the
		// ~2 years a single key would cost; see `descriptors/kcov.ts` for why
		// closing it outright is not worth a segment every run pays for.
		yield* stash(prefix, key.key, Option.none());

		yield* publish(binDir, binary, plan.version);
		yield* Effect.logInfo(`kcov ${plan.version} (built)`);
		return Option.some({ version: plan.version, binDir, cacheHit: false });
	});
