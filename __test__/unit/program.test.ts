import { delimiter, join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import type { CacheKey } from "@effected/github-actions";
import {
	ActionCache,
	ActionEnvironment,
	ActionInput,
	ActionLogger,
	ActionOutputs,
	ActionState,
	AmbientPackageManager,
	CachedPackageManager,
	PackageManagerInstaller,
	ToolInstaller,
	ToolInstallerError,
} from "@effected/github-actions";
import type { MemoryFileSystemFaults } from "@effected/memfs";
import { MemoryFileSystem } from "@effected/memfs";
import { WorkspaceDiscovery } from "@effected/workspaces";
import type { FileSystem } from "effect";
import { Cause, Effect, Exit, Layer, Logger, Option, Path, Sink, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner as ChildProcessSpawnerNS } from "effect/unstable/process";

import { BATS_CORE_VERSION } from "../../src/descriptors/bats.js";
import { KCOV_VERSION } from "../../src/descriptors/kcov.js";
import { program, turboCacheOutputs } from "../../src/program.js";
import { OUTPUT_NAMES } from "../../src/schema/outputs.js";
import type { StartedTurboCache } from "../../src/steps/turbo-cache.js";

/**
 * A silent child process that exits cleanly.
 *
 * @remarks
 * Every stream is empty: `installRuntimes` only reads an exit code, and
 * `installDependencies` inherits the install's stdout and reads its stderr for
 * the failure tail — neither of which a green program run produces.
 */
const quietHandle = ChildProcessSpawnerNS.makeHandle({
	pid: ChildProcessSpawnerNS.ProcessId(1),
	exitCode: Effect.succeed(ChildProcessSpawnerNS.ExitCode(0)),
	isRunning: Effect.succeed(false),
	kill: () => Effect.void,
	stdin: Sink.drain,
	stdout: Stream.empty,
	stderr: Stream.empty,
	all: Stream.empty,
	getInputFd: () => Sink.drain,
	getOutputFd: () => Stream.empty,
	unref: Effect.succeed(Effect.void),
});

/** One command the program spawned, as far as this suite cares about it. */
interface Spawned {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly env: Record<string, string | undefined> | undefined;
}

/**
 * A `ChildProcessSpawner` test double, recording into `spawns`.
 *
 * @remarks
 * `exitCode` succeeds because `installRuntimes` verifies what it installed by
 * running it, and `spawn` succeeds because `installDependencies` runs the
 * install itself. The derived members die: no step should be collecting a
 * command's output wholesale.
 */
const childProcessSpawnerTest = (spawns: Array<Spawned> = []): Layer.Layer<ChildProcessSpawnerNS.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawnerNS.ChildProcessSpawner, {
		spawn: (command) => {
			if (ChildProcess.isStandardCommand(command)) {
				spawns.push({ command: command.command, args: command.args, env: command.options.env });
			}
			return Effect.succeed(quietHandle);
		},
		exitCode: () => Effect.succeed(ChildProcessSpawnerNS.ExitCode(0)),
		streamString: () => Stream.die(new Error("ChildProcessSpawner.streamString not stubbed")),
		streamLines: () => Stream.die(new Error("ChildProcessSpawner.streamLines not stubbed")),
		lines: () => Effect.die(new Error("ChildProcessSpawner.lines not stubbed")),
		string: () => Effect.die(new Error("ChildProcessSpawner.string not stubbed")),
	});

/**
 * A `ToolInstaller` double reporting every requested tool as already cached, so
 * the program's real runtime install runs its short-circuit path. A download,
 * extraction or cache write reaching this double dies.
 */
const toolInstallerTest = ToolInstaller.layerTest({
	find: (tool, version) => Effect.succeed(Option.some(`/opt/toolcache/${tool}/${version}`)),
	// Biome's install is one provisioner call, and the directory it answers with
	// is both what goes on the PATH and what the step reports.
	provisionFile: ({ tool, version }) =>
		Effect.succeed({ directory: `/opt/toolcache/${tool}/${version}`, binDir: `/opt/toolcache/${tool}/${version}` }),
});

/**
 * A `ToolInstaller` double that also serves the *provisioning* members — the
 * download / extract / cache-dir trio only the BATS and kcov installs use.
 *
 * @remarks
 * Separate from {@link toolInstallerTest} rather than folded into it so those
 * members keep dying for every case that is not about them: a step that starts
 * downloading shows up as a red test here, which is the same rule the spawner
 * and filesystem doubles follow.
 *
 * `failing` is matched as a substring of the requested url, so one double can
 * fail bats' tarball while serving kcov's — or the reverse, which is what
 * separates "bats failed" from "kcov failed" below.
 */
const provisioningToolInstallerTest = (
	options: { readonly failing?: string; readonly downloads?: Array<string> } = {},
): Layer.Layer<ToolInstaller> =>
	ToolInstaller.layerTest({
		find: (tool, version) => Effect.succeed(Option.some(`/opt/toolcache/${tool}/${version}`)),
		provisionFile: ({ tool, version }) =>
			Effect.succeed({ directory: `/opt/toolcache/${tool}/${version}`, binDir: `/opt/toolcache/${tool}/${version}` }),
		download: (url) => {
			options.downloads?.push(url);
			return options.failing !== undefined && url.includes(options.failing)
				? Effect.fail(new ToolInstallerError({ reason: "downloadFailed", subject: url, status: 404 }))
				: Effect.succeed(`/tmp/download/${options.downloads?.length ?? 0}.tar.gz`);
		},
		extractTar: () => Effect.succeed("/tmp/extracted"),
		cacheDir: (_directory, tool, version) => Effect.succeed(`/opt/toolcache/${tool}/${version}`),
	});

/** The writes the BATS and kcov installs make, which no other case reaches. */
const provisioningFileSystem: MemoryFileSystemFaults = {
	// The only member the volume cannot answer honestly: the bats and kcov
	// installs copy out of tarballs a stubbed `ToolInstaller.extractTar` claims
	// to have unpacked, and nothing put those trees on the volume. Everything
	// else those steps do — creating directories, writing the synthesized
	// loader, chmod — runs against the volume for real, so this is one fault
	// rather than four stubs.
	copy: () => Effect.void,
};

/**
 * A `PackageManagerInstaller` double reporting the manifest's manager as already
 * in the tool cache, so the program's real package-manager step runs its
 * `addPath` path without downloading anything.
 *
 * @remarks
 * The npm arm reproduces the installer's own branch rather than answering
 * `tool-cache` unconditionally — `PackageManagerInstaller.ts` probes `npm
 * --version` when `pin.name === "npm" && options?.allowAmbient !== false`, and
 * this double stands in for a runner whose ambient npm matches the pin exactly.
 * That is what makes the npm-precedence case below discriminating: drop
 * `allowAmbient: false` from the step and this double answers `ambient` with no
 * directory, the pinned npm falls out of the prepend list, and the assertion
 * fails. An unconditional tool-cache answer would pass either way.
 */
const packageManagerInstallerTest = PackageManagerInstaller.layerTest({
	install: (pin, options) =>
		pin.name === "npm" && options?.allowAmbient !== false
			? Effect.succeed(
					AmbientPackageManager.make({
						name: "npm",
						version: pin.version.toString(),
						bins: { npm: "npm", npx: "npx" },
					}),
				)
			: Effect.succeed(
					CachedPackageManager.make({
						name: pin.name,
						version: pin.version.toString(),
						directory: `/opt/toolcache/${pin.name}/${pin.version.toString()}`,
						binDir: `/opt/toolcache/${pin.name}/${pin.version.toString()}/.bin`,
						bins: { [pin.name]: `/opt/toolcache/${pin.name}/${pin.version.toString()}/bin/${pin.name}.cjs` },
					}),
				),
});

/** No inputs supplied, so every `action.yml` default applies. */
const actionInputTest = ActionInput.layer({});

/**
 * An `HttpClient` that dies if anything reaches it.
 *
 * @remarks
 * `HttpClient` entered the program's `R` with `DetachedProcess.httpProbe`
 * (effected#240): the turbo step's readiness probe is the only thing in the
 * pipeline that speaks HTTP. None of these cases start a cache server — no
 * fixture writes a `turbo.json` — so no request should ever be issued, and the
 * honest stub is one that says so rather than one that answers politely.
 *
 * The same reasoning as `childProcessSpawnerTest`'s derived members and the
 * `FileSystem` double: a call arriving here is a regression, not a missing stub.
 */
const httpClientTest = Layer.succeed(
	HttpClient.HttpClient,
	HttpClient.make(() => Effect.die(new Error("HttpClient was not stubbed: no program test should issue a request"))),
);

/**
 * The primary key a restore was asked for, whether it came as a typed
 * `CacheKey` or as a bare string.
 */
const primaryKey = (key: string | CacheKey): string => (typeof key === "string" ? key : key.key);

/**
 * The rungs a restore would fall back to: a typed key carries its own ladder,
 * a string key relies on the explicit argument.
 */
const ladder = (key: string | CacheKey, restoreKeys: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
	typeof key === "string" ? (restoreKeys ?? []) : key.restoreKeys;

/** The checkout, as `ActionEnvironment.layerTest` names it. */
const WORKSPACE = "/workspace";

/** The one lockfile the served workspace holds. */
const LOCKFILE = "pnpm-lock.yaml";

/** The manifest `loadConfig` reads, at the working directory rather than the checkout. */
const packageJson = JSON.stringify({
	devEngines: {
		packageManager: { name: "pnpm", version: "10.20.0" },
		runtime: { name: "node", version: "24.11.0" },
	},
});

/** A manifest declaring all three runtimes, in `devEngines` declaration order. */
const allRuntimesPackageJson = JSON.stringify({
	devEngines: {
		packageManager: { name: "pnpm", version: "10.20.0" },
		runtime: [
			{ name: "node", version: "24.11.0" },
			{ name: "bun", version: "1.3.3" },
			{ name: "deno", version: "2.5.6" },
		],
	},
});

/**
 * A manifest pinning npm as the manager over a pinned node — the pair the
 * ambient short-circuit used to decide between (issue #220).
 */
const npmPackageJson = JSON.stringify({
	devEngines: {
		packageManager: { name: "npm", version: "11.6.2" },
		runtime: { name: "node", version: "24.11.0" },
	},
});

/** A manifest naming bun as both the runtime and the package manager. */
const bunPackageJson = JSON.stringify({
	devEngines: {
		packageManager: { name: "bun", version: "1.3.3" },
		runtime: { name: "bun", version: "1.3.3" },
	},
});

/**
 * The same, with node declared *first* — so the manager's runtime is not the
 * one the declaration order would put at the head.
 */
const bunAndNodePackageJson = JSON.stringify({
	devEngines: {
		packageManager: { name: "bun", version: "1.3.3" },
		runtime: [
			{ name: "node", version: "24.11.0" },
			{ name: "bun", version: "1.3.3" },
		],
	},
});

/** A `biome.jsonc` pinning `version` through its `$schema` url. */
const biomeConfig = (version: string): string =>
	JSON.stringify({ $schema: `https://biomejs.dev/schemas/${version}/schema.json` });

/** What the working directory holds besides `package.json`. */
interface WorkingDirectory {
	/** The `biome.jsonc` body, when the repository has one. */
	readonly biome?: string;
	/** Whether a `turbo.json` is there. Its contents are never read. */
	readonly turbo?: boolean;
	/** Whether the working directory holds a `*.bats` file, which is what `detectBats` looks for. */
	readonly bats?: boolean;
}

/**
 * A volume holding `package.json`, whatever `directory` says the repository
 * holds, and the checkout's one lockfile.
 *
 * @remarks
 * The working directory is the volume root, which is where the detectors and
 * `loadConfig` probe; the checkout `ActionEnvironment.layerTest` names is a
 * directory inside it. Absence needs no stub — an unseeded path fails the way
 * the platform fails it, which is what makes "no lockfile in the working
 * directory" and "no `*.bats` file" the *tree's* answers rather than the
 * double's.
 *
 * `faults` is for the one thing a volume cannot answer honestly: see
 * {@link provisioningFileSystem}.
 */
const fileSystemTest = (
	manifest: string = packageJson,
	directory: WorkingDirectory = {},
	faults: MemoryFileSystemFaults = {},
): Layer.Layer<FileSystem.FileSystem> =>
	MemoryFileSystem.layerFaulty(faults).pipe(
		Layer.provide(
			MemoryFileSystem.layerWith({
				"/package.json": manifest,
				...(directory.biome === undefined ? {} : { "/biome.jsonc": directory.biome }),
				// Presence is the whole of the turbo signal; the contents are never read.
				...(directory.turbo === true ? { "/turbo.json": "{}" } : {}),
				...(directory.bats === true ? { "/setup.bats": "@test 'works' { true; }\n" } : {}),
				[`${WORKSPACE}/${LOCKFILE}`]: "lockfileVersion: '9.0'",
			}),
		),
	);

/**
 * Every service in the program's `R` union, doubled.
 *
 * @remarks
 * `ActionCache` and `ToolInstaller` stand in for what `MainLive` adds; the
 * rest stand in for what `ActionRuntime.layer` supplies under `Action.run`.
 * Unstubbed kit members die loudly, so a step that starts touching the runner
 * shows up here as a red test rather than a silently-succeeding no-op.
 *
 * `ActionEnvironment.layerTest` is one of the three recorded exceptions to
 * that rule — it seeds a complete `GITHUB_*` / `RUNNER_*` block — which is
 * what lets the program's fail-fast `env.github` read succeed here.
 */
const makeLayer = (
	outputs: Partial<ActionOutputs["Service"]>,
	environment: Layer.Layer<ActionEnvironment> = ActionEnvironment.layerTest(),
	options: {
		readonly manifest?: string;
		readonly spawns?: Array<Spawned>;
		readonly cache?: Layer.Layer<ActionCache>;
		/** What the working directory holds besides the manifest. */
		readonly directory?: WorkingDirectory;
		/** A `ToolInstaller` other than the all-cached default — a failing one, say. */
		readonly tools?: Layer.Layer<ToolInstaller>;
		/** Inputs the workflow supplied, as the runner would publish them. */
		readonly inputs?: Layer.Layer<never>;
		/** Faults over the volume, for a call it cannot answer — the BATS and kcov installs' copies. */
		readonly filesystem?: MemoryFileSystemFaults;
	} = {},
): Layer.Layer<
	| ActionCache
	| ActionEnvironment
	| ActionLogger
	| ActionOutputs
	| ActionState
	| PackageManagerInstaller
	| ToolInstaller
	| FileSystem.FileSystem
	| Path.Path
	| ChildProcessSpawnerNS.ChildProcessSpawner
	| HttpClient.HttpClient
	| WorkspaceDiscovery
> =>
	Layer.mergeAll(
		// The workspace archive names each member's node_modules, so the step asks
		// discovery for the membership. `layerTest` with no override answers with
		// an empty list, which the step reads as "root only" — the shape almost
		// every case here wants, and the one `restore-cache.test.ts` varies.
		WorkspaceDiscovery.layerTest(),
		// The cache restore is real, and by default nothing matches: a miss leaves
		// the installs that follow to do the work, which is what most cases here
		// are about. `restore-cache.test.ts` owns the key derivation itself.
		options.cache ?? ActionCache.layerTest({ restore: () => Effect.succeed(Option.none()) }),
		ActionLogger.layerSilent,
		// `summary` is stubbed for the same reason `addPath` is: every run reaches
		// it, and a case that is not about the panel should not have to say so.
		ActionOutputs.layerTest({ addPath: () => Effect.void, summary: () => Effect.void, ...outputs }),
		// The restore step persists what it restored for the post phase.
		ActionState.layerTest({ save: () => Effect.void }),
		options.tools ?? toolInstallerTest,
		packageManagerInstallerTest,
		fileSystemTest(options.manifest, options.directory, options.filesystem),
		Path.layer,
		environment,
		childProcessSpawnerTest(options.spawns),
		options.inputs ?? actionInputTest,
		httpClientTest,
	);

/** The four variables the program quiets its own install steps with (oracle 43). */
const QUIET_ENV = {
	NPM_CONFIG_UPDATE_NOTIFIER: "false",
	NPM_CONFIG_FUND: "false",
	HUSKY: "0",
	COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
} as const;

/**
 * Runs `effect` with `process.env` put back exactly as it was, on every exit
 * path.
 *
 * @remarks
 * The program mutates the real `process.env` — that is the point of oracle 43 —
 * so a test that reads it has to leave no trace for the next one. Keys are
 * restored in place rather than by reassigning `process.env`, which would swap
 * the object every other module already holds a reference to.
 */
const withEnvRestored = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
	Effect.suspend(() => {
		const snapshot = { ...process.env };
		return effect.pipe(
			Effect.ensuring(
				Effect.sync(() => {
					for (const key of Object.keys(process.env)) if (!(key in snapshot)) delete process.env[key];
					Object.assign(process.env, snapshot);
				}),
			),
		);
	});

/** Runs `program` under the doubles, returning every published output. */
const runProgram = Effect.fnUntraced(function* (manifest?: string) {
	const captured = new Map<string, string>();
	yield* program.pipe(
		Effect.provide(
			makeLayer(
				{ set: (name, value) => Effect.sync(() => void captured.set(name, value)) },
				undefined,
				manifest === undefined ? {} : { manifest },
			),
		),
	);
	return captured;
});

describe("program", () => {
	it.effect("publishes every action.yml output exactly once", () =>
		Effect.gen(function* () {
			const captured = yield* runProgram();
			assert.deepStrictEqual([...captured.keys()].sort(), [...OUTPUT_NAMES].sort());
		}),
	);

	it.effect("folds the package manager step's result into the outputs", () =>
		Effect.gen(function* () {
			const captured = yield* runProgram();
			// Both values come from the served manifest's `devEngines`, through
			// `loadConfig` and the (still echoing) package-manager stub.
			assert.strictEqual(captured.get("package-manager"), "pnpm");
			assert.strictEqual(captured.get("package-manager-version"), "10.20.0");
		}),
	);

	it.effect("folds every installed runtime into its version and enabled outputs", () =>
		Effect.gen(function* () {
			const captured = yield* runProgram(allRuntimesPackageJson);
			assert.strictEqual(captured.get("node-version"), "24.11.0");
			assert.strictEqual(captured.get("node-enabled"), "true");
			assert.strictEqual(captured.get("bun-version"), "1.3.3");
			assert.strictEqual(captured.get("bun-enabled"), "true");
			assert.strictEqual(captured.get("deno-version"), "2.5.6");
			assert.strictEqual(captured.get("deno-enabled"), "true");
		}),
	);

	it.effect("leaves a runtime the manifest never named at empty and disabled", () =>
		Effect.gen(function* () {
			// The default manifest declares node alone, so bun and deno report what a
			// runtime nobody installed reports — not the version of something that
			// was never fetched (oracle 46).
			const captured = yield* runProgram();
			assert.strictEqual(captured.get("node-version"), "24.11.0");
			assert.strictEqual(captured.get("node-enabled"), "true");
			assert.strictEqual(captured.get("bun-version"), "");
			assert.strictEqual(captured.get("bun-enabled"), "false");
			assert.strictEqual(captured.get("deno-version"), "");
			assert.strictEqual(captured.get("deno-enabled"), "false");
		}),
	);

	it.effect("quiets the tooling its own install steps invoke, on this process only", () =>
		withEnvRestored(
			Effect.gen(function* () {
				// Cleared first, so a value left behind by another test cannot make
				// this pass without the program having set anything.
				for (const name of Object.keys(QUIET_ENV)) delete process.env[name];

				yield* runProgram();

				assert.strictEqual(process.env.NPM_CONFIG_UPDATE_NOTIFIER, QUIET_ENV.NPM_CONFIG_UPDATE_NOTIFIER);
				assert.strictEqual(process.env.NPM_CONFIG_FUND, QUIET_ENV.NPM_CONFIG_FUND);
				assert.strictEqual(process.env.HUSKY, QUIET_ENV.HUSKY);
				assert.strictEqual(process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT, QUIET_ENV.COREPACK_ENABLE_DOWNLOAD_PROMPT);
				// "On this process only" is enforced by the doubles rather than
				// asserted here: `ActionOutputs.layerTest` stubs `set` and `addPath`
				// and nothing else, so an `exportVariable` call — which would leak
				// these into the consumer's later job steps — dies.
			}),
		),
	);

	it.effect("puts a runtime-installed package manager on the install's PATH", () =>
		Effect.gen(function* () {
			const spawns: Array<Spawned> = [];
			const previous = process.env.PATH;
			process.env.PATH = "/usr/bin";
			try {
				yield* program.pipe(
					Effect.provide(makeLayer({ set: () => Effect.void }, undefined, { manifest: bunPackageJson, spawns })),
				);
			} finally {
				process.env.PATH = previous;
			}

			// bun is its own package manager, so the package-manager step is a no-op
			// and reports no directory. The runtime install put bun in the tool
			// cache and published it to GITHUB_PATH — which does nothing for *this*
			// process — so without the program's join the install below would spawn
			// a bare `bun` against whatever the runner image happens to have.
			const install = spawns.find((spawned) => spawned.args[0] === "install");
			assert.strictEqual(install?.command, "bun");
			assert.deepStrictEqual(install?.env, { PATH: `/opt/toolcache/bun/1.3.3${delimiter}/usr/bin` });
		}),
	);

	it.effect("puts every installed runtime on the install's PATH, behind the manager", () =>
		Effect.gen(function* () {
			const spawns: Array<Spawned> = [];
			const previous = process.env.PATH;
			process.env.PATH = "/usr/bin";
			try {
				yield* program.pipe(
					Effect.provide(
						makeLayer({ set: () => Effect.void }, undefined, { manifest: allRuntimesPackageJson, spawns }),
					),
				);
			} finally {
				process.env.PATH = previous;
			}

			// The failure this rules out: pnpm's install spawns lifecycle scripts, and
			// a `postinstall` running `deno install` or `bun install` resolves that
			// binary off the PATH it inherited from the install child. Prepending only
			// the manager's directory left every runner reporting `deno: not found`.
			const install = spawns.find((spawned) => spawned.args[0] === "install");
			assert.strictEqual(install?.command, "pnpm");
			const entries = (install?.env?.PATH ?? "").split(delimiter);
			// The manager leads — its shims win any name collision. The runtimes
			// follow in `devEngines` declaration order, and each is matched by prefix
			// because the bin subdirectory below the cached root is the descriptor's
			// business and differs by platform.
			assert.strictEqual(entries[0], "/opt/toolcache/pnpm/10.20.0/.bin");
			assert.strictEqual(entries[1]?.startsWith("/opt/toolcache/node/24.11.0"), true);
			assert.strictEqual(entries[2]?.startsWith("/opt/toolcache/bun/1.3.3"), true);
			assert.strictEqual(entries[3]?.startsWith("/opt/toolcache/deno/2.5.6"), true);
			// The inherited PATH stays last, and nothing else was invented.
			assert.strictEqual(entries[4], "/usr/bin");
			assert.lengthOf(entries, 5);
		}),
	);

	it.effect("runs the pinned npm, not the one bundled with the pinned node", () =>
		Effect.gen(function* () {
			const spawns: Array<Spawned> = [];
			const previous = process.env.PATH;
			process.env.PATH = "/usr/bin";
			try {
				yield* program.pipe(
					Effect.provide(makeLayer({ set: () => Effect.void }, undefined, { manifest: npmPackageJson, spawns })),
				);
			} finally {
				process.env.PATH = previous;
			}

			// Issue #220, and the fixture its docblock said did not exist: nothing
			// asserted *which* npm executes. The double stands in for a runner whose
			// own npm matches the pin, which is precisely the case the ambient probe
			// used to short-circuit — answering with no directory, so node's bin
			// directory led and the install child ran the npm bundled with node
			// instead. `allowAmbient: false` puts the pinned npm at the head.
			const install = spawns.find((spawned) => spawned.args[0] === "install");
			assert.strictEqual(install?.command, "npm");
			const entries = (install?.env?.PATH ?? "").split(delimiter);
			assert.strictEqual(entries[0], "/opt/toolcache/npm/11.6.2/.bin");
			// node still follows, so a lifecycle script resolves the pinned node —
			// but it no longer decides which npm runs.
			assert.strictEqual(entries[1]?.startsWith("/opt/toolcache/node/24.11.0"), true);
			assert.strictEqual(entries[2], "/usr/bin");
			assert.lengthOf(entries, 3);
		}),
	);

	it.effect("hoists the manager's own runtime to the head, ahead of an earlier-declared one", () =>
		Effect.gen(function* () {
			const spawns: Array<Spawned> = [];
			const previous = process.env.PATH;
			process.env.PATH = "/usr/bin";
			try {
				yield* program.pipe(
					Effect.provide(makeLayer({ set: () => Effect.void }, undefined, { manifest: bunAndNodePackageJson, spawns })),
				);
			} finally {
				process.env.PATH = previous;
			}

			// node is declared first, so runtime order alone would put it at the head.
			// The manager slot wins instead: `onInstallPath` fills bun's empty `binDir`
			// from the runtime install, that entry leads, and the `Set` collapses the
			// duplicate bun path arriving behind node rather than reordering anything.
			// Without the hoist a `bun` on the runner image reachable via node's bin
			// directory would shadow the version this run installed.
			const install = spawns.find((spawned) => spawned.args[0] === "install");
			assert.strictEqual(install?.command, "bun");
			const entries = (install?.env?.PATH ?? "").split(delimiter);
			assert.strictEqual(entries[0], "/opt/toolcache/bun/1.3.3");
			assert.strictEqual(entries[1]?.startsWith("/opt/toolcache/node/24.11.0"), true);
			assert.strictEqual(entries[2], "/usr/bin");
			// Three, not four: bun appears once despite reaching the list twice.
			assert.lengthOf(entries, 3);
		}),
	);

	it.effect("fails at entry, before any step runs, outside a runner environment", () =>
		Effect.gen(function* () {
			const captured = new Map<string, string>();
			const exit = yield* program.pipe(
				Effect.provide(
					makeLayer(
						{ set: (name, value) => Effect.sync(() => void captured.set(name, value)) },
						// An empty required `GITHUB_*` variable is exactly what a
						// non-runner environment looks like to `ActionEnvironment`.
						ActionEnvironment.layerTest({ GITHUB_REPOSITORY: "" }),
					),
				),
				Effect.exit,
			);
			assert.strictEqual(exit._tag, "Failure");
			// Which failure, not just that one happened: `Failure` alone would also
			// be satisfied by a step further down dying on a test double it never
			// got a chance to reach, and the assertion below would still hold if
			// that step ran before publishing anything. The tag is what says the
			// environment guard is the thing that stopped the run.
			const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
			assert.strictEqual(Option.getOrUndefined(error)?._tag, "ActionEnvironmentError");
			// The whole point of the guard: nothing downstream got to run.
			assert.strictEqual(captured.size, 0);
		}),
	);

	it.effect("folds a detected and installed Biome into its version and enabled outputs", () =>
		Effect.gen(function* () {
			const captured = new Map<string, string>();
			const paths: Array<string> = [];
			yield* program.pipe(
				Effect.provide(
					makeLayer(
						{
							set: (name, value) => Effect.sync(() => void captured.set(name, value)),
							addPath: (path) => Effect.sync(() => void paths.push(path)),
						},
						undefined,
						{ directory: { biome: biomeConfig("2.4.9") } },
					),
				),
			);

			assert.strictEqual(captured.get("biome-enabled"), "true");
			assert.strictEqual(captured.get("biome-version"), "2.4.9");
			// Detection alone is not the claim: the outputs say Biome is installed,
			// so it has to be on the PATH.
			assert.include(paths, "/opt/toolcache/biome/2.4.9");
		}),
	);

	it.effect("installs the biome-version input over a config file", () =>
		Effect.gen(function* () {
			const captured = new Map<string, string>();
			yield* program.pipe(
				Effect.provide(
					makeLayer({ set: (name, value) => Effect.sync(() => void captured.set(name, value)) }, undefined, {
						// The repository pins 2.4.9 and the workflow asks for 2.3.14.
						directory: { biome: biomeConfig("2.4.9") },
						inputs: ActionInput.layer({ "biome-version": "2.3.14" }),
					}),
				),
			);

			assert.strictEqual(captured.get("biome-version"), "2.3.14");
			assert.strictEqual(captured.get("biome-enabled"), "true");
		}),
	);

	it.effect("reports Biome as disabled when its install fails, and keeps going", () =>
		Effect.gen(function* () {
			const captured = new Map<string, string>();
			const logs: Array<string> = [];
			yield* program.pipe(
				Effect.provide(
					Layer.mergeAll(
						makeLayer({ set: (name, value) => Effect.sync(() => void captured.set(name, value)) }, undefined, {
							directory: { biome: biomeConfig("2.4.9") },
							tools: ToolInstaller.layerTest({
								find: (tool, version) => Effect.succeed(Option.some(`/opt/toolcache/${tool}/${version}`)),
								provisionFile: ({ tool }) =>
									Effect.fail(new ToolInstallerError({ reason: "downloadFailed", subject: tool, status: 404 })),
							}),
						}),
						Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
					),
				),
			);

			// Non-fatal (oracle 29): the run completes and every other output is
			// published. And the outputs are truthful — v1 set them from *detection*
			// and reported an enabled Biome that was never installed (oracle 30).
			assert.strictEqual(captured.get("biome-enabled"), "false");
			assert.strictEqual(captured.get("biome-version"), "");
			assert.strictEqual(captured.get("node-enabled"), "true");
			// v1's prose for the warning, with the typed error's own message after it
			// rather than a stringified object.
			assert.include(logs.join("\n"), "Biome installation failed: ");
			assert.include(logs.join("\n"), "404");
			// And the closing group names the step that failed rather than
			// reporting a Biome that was detected as absent.
			assert.include(logs, "Biome: detected, install failed");
		}),
	);

	it.effect("folds a detected turbo.json into turbo-enabled", () =>
		Effect.gen(function* () {
			const captured = new Map<string, string>();
			yield* program.pipe(
				Effect.provide(
					makeLayer({ set: (name, value) => Effect.sync(() => void captured.set(name, value)) }, undefined, {
						directory: { turbo: true },
						// `turbo-cache: off` is what keeps this a *detection* test. The
						// turbo cache step is the one step that spawns a process which
						// outlives the run, and its seam is a parameter rather than a
						// service — so the embedded path is exercised in
						// `steps/turbo-cache.test.ts`, where the spawn is a double, and
						// never from here.
						inputs: ActionInput.layer({ "turbo-cache": "off" }),
					}),
				),
			);

			assert.strictEqual(captured.get("turbo-enabled"), "true");
			// Detection and the cache backend are two different answers (oracle 27):
			// a repository with a `turbo.json` and the cache switched off reports an
			// enabled turbo and no backend.
			assert.strictEqual(captured.get("turbo-cache-backend"), "none");
			assert.strictEqual(captured.get("turbo-cache-port"), "");
		}),
	);

	it.effect("folds what the turbo cache step started into the backend and port outputs", () => {
		// The fold itself, pinned without a detached child: the program run above
		// can only reach the `off` row, and the other three rows differ only in
		// what this function is handed.
		const rows: ReadonlyArray<readonly [StartedTurboCache, string, string]> = [
			[{ backend: "none", port: Option.none(), state: Option.none() }, "none", ""],
			[{ backend: "remote", port: Option.none(), state: Option.none() }, "remote", ""],
			[{ backend: "github", port: Option.some(41230), state: Option.none() }, "github", "41230"],
			[{ backend: "s3", port: Option.some(41230), state: Option.none() }, "s3", "41230"],
		];
		for (const [started, backend, port] of rows) {
			assert.deepStrictEqual(turboCacheOutputs(started), { turboCacheBackend: backend, turboCachePort: port });
		}
		return Effect.void;
	});

	it.effect("leaves every other output at its all-disabled default", () =>
		Effect.gen(function* () {
			const captured = yield* runProgram();
			assert.strictEqual(captured.get("biome-version"), "");
			assert.strictEqual(captured.get("biome-enabled"), "false");
			assert.strictEqual(captured.get("turbo-enabled"), "false");
			assert.strictEqual(captured.get("turbo-cache-backend"), "none");
			assert.strictEqual(captured.get("turbo-cache-port"), "");
			assert.strictEqual(captured.get("cache-hit"), "false");
		}),
	);

	it.effect("closes the detection stretch with a one-line summary of everything it found", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			yield* program.pipe(
				Effect.provide(
					Layer.mergeAll(
						makeLayer({ set: () => Effect.void }, undefined, {
							manifest: allRuntimesPackageJson,
							directory: { biome: biomeConfig("2.4.9"), turbo: true },
							inputs: ActionInput.layer({ "turbo-cache": "off" }),
						}),
						Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
					),
				),
			);

			// The line v1 emitted from its single detect group. The new pipeline
			// splits detection across three groups, so it is assembled and emitted
			// after the last of them (oracle 29) — space-separated and lowercase
			// `biome`, unlike the `@`-joined info lines above it (rulings 54, 55).
			assert.include(logs, "node 24.11.0 · bun 1.3.3 · deno 2.5.6 · pnpm 10.20.0 · biome 2.4.9 · turbo");
		}),
	);

	it.effect("tells the summary an install that never ran did not run", () =>
		Effect.gen(function* () {
			const panels: Array<string> = [];
			const logs: Array<string> = [];
			yield* program.pipe(
				Effect.provide(
					Layer.mergeAll(
						makeLayer(
							{ set: () => Effect.void, summary: (content) => Effect.sync(() => void panels.push(content)) },
							undefined,
							// deno caches modules on demand, so the install step is a
							// deliberate skip rather than a failure.
							{
								manifest: JSON.stringify({
									devEngines: {
										packageManager: { name: "deno", version: "2.5.6" },
										runtime: { name: "deno", version: "2.5.6" },
									},
								}),
							},
						),
						Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
					),
				),
			);

			// Quirk 52: v1 echoed the `install-deps` input, which defaults to true,
			// and so reported deno's skipped install as done in both places.
			assert.include(panels[0], "| Dependencies | skipped |");
			assert.include(logs, "Dependencies: skipped");
		}),
	);

	it.effect("folds a restore that landed into cache-hit, lockfiles and cache-paths", () =>
		Effect.gen(function* () {
			const captured = new Map<string, string>();
			yield* program.pipe(
				Effect.provide(
					makeLayer(
						{ set: (name, value) => Effect.sync(() => void captured.set(name, value)) },
						undefined,
						// The runner answers with the key it was asked for.
						{
							cache: ActionCache.layerTest({ restore: (_paths, key) => Effect.succeed(Option.some(primaryKey(key))) }),
						},
					),
				),
			);

			assert.strictEqual(captured.get("cache-hit"), "true");
			// The store is a second entry, keyed independently, and reports its own
			// verdict — a "false" here beside a "true" above is the shape of a job
			// that restored its linked trees and still downloads every package.
			assert.strictEqual(captured.get("store-cache-hit"), "true");
			// The resolved file, not the pattern that found it.
			assert.strictEqual(captured.get("lockfiles"), join(WORKSPACE, LOCKFILE));
			const paths = (captured.get("cache-paths") ?? "").split(",");
			assert.include(paths, "node_modules");
			assert.include(paths, join("/opt/hostedtoolcache", "node", "24.11.0"));
			// Both archives' paths, so a consumer reading the output back can see
			// whether their store was covered.
			assert.strictEqual(
				paths.some((path) => path.includes("pnpm/store")),
				true,
			);
		}),
	);

	it.effect("reports a fallback restore as a partial hit", () =>
		Effect.gen(function* () {
			const captured = new Map<string, string>();
			yield* program.pipe(
				Effect.provide(
					makeLayer({ set: (name, value) => Effect.sync(() => void captured.set(name, value)) }, undefined, {
						cache: ActionCache.layerTest({
							restore: (_paths, key, restoreKeys) =>
								Effect.succeed(Option.fromUndefinedOr(ladder(key, restoreKeys)[0])),
						}),
					}),
				),
			);

			// A rung of the ladder matched, so the archive is close but not this
			// run's — which is what post needs to know to save again.
			assert.strictEqual(captured.get("cache-hit"), "partial");
		}),
	);

	it.effect("leaves bats and kcov disabled when the repository has no shell tests", () =>
		Effect.gen(function* () {
			// Neither `detectBats` signal fires here: no `*.bats` file in the working
			// directory and no `vitest-bats` in the manifest. Nothing is installed,
			// and the outputs say so rather than reporting a lib path nobody wrote.
			const captured = yield* runProgram();
			assert.strictEqual(captured.get("bats-enabled"), "false");
			assert.strictEqual(captured.get("bats-version"), "");
			assert.strictEqual(captured.get("bats-lib-path"), "");
			assert.strictEqual(captured.get("kcov-enabled"), "false");
			assert.strictEqual(captured.get("kcov-version"), "");
			assert.strictEqual(captured.get("kcov-cache-hit"), "false");
		}),
	);

	it.effect("folds a detected BATS and the kcov beside it into their outputs", () =>
		Effect.gen(function* () {
			const captured = new Map<string, string>();
			const paths: Array<string> = [];
			const exported: Array<readonly [string, string]> = [];
			const panels: Array<string> = [];
			yield* program.pipe(
				Effect.provide(
					makeLayer(
						{
							set: (name, value) => Effect.sync(() => void captured.set(name, value)),
							addPath: (path) => Effect.sync(() => void paths.push(path)),
							exportVariable: (name, value) => Effect.sync(() => void exported.push([name, value])),
							summary: (content) => Effect.sync(() => void panels.push(content)),
						},
						undefined,
						{
							directory: { bats: true },
							tools: provisioningToolInstallerTest(),
							filesystem: provisioningFileSystem,
						},
					),
				),
			);

			assert.strictEqual(captured.get("bats-enabled"), "true");
			assert.strictEqual(captured.get("bats-version"), BATS_CORE_VERSION);
			// The library root the install exported, not a per-library directory.
			assert.strictEqual(captured.get("bats-lib-path"), exported.find(([name]) => name === "BATS_LIB_PATH")?.[1]);
			// Enabled is a claim about the runner: the toolchain has to be on the PATH.
			assert.include(paths, `/opt/toolcache/bats/${BATS_CORE_VERSION}/bin`);
			// kcov followed bats, and nothing restored it, so it reports a build.
			assert.strictEqual(captured.get("kcov-enabled"), "true");
			assert.strictEqual(captured.get("kcov-version"), KCOV_VERSION);
			assert.strictEqual(captured.get("kcov-cache-hit"), "false");
			// And the panel carries both rows, from the same install results.
			assert.include(panels[0], `| BATS | ${BATS_CORE_VERSION} · `);
			assert.include(panels[0], `| kcov | ${KCOV_VERSION} · ⬜ built |`);
		}),
	);

	it.effect("publishes the bats outputs from the install result, not from detection", () =>
		Effect.gen(function* () {
			const captured = new Map<string, string>();
			const logs: Array<string> = [];
			const downloads: Array<string> = [];
			yield* program.pipe(
				Effect.provide(
					Layer.mergeAll(
						makeLayer({ set: (name, value) => Effect.sync(() => void captured.set(name, value)) }, undefined, {
							directory: { bats: true },
							tools: provisioningToolInstallerTest({ failing: "bats-core", downloads }),
							filesystem: provisioningFileSystem,
						}),
						Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
					),
				),
			);

			// Detection said yes and the fetch said no, so the outputs say no
			// (oracle 30) — the defect v1 shipped for Biome, in the other direction.
			assert.strictEqual(captured.get("bats-enabled"), "false");
			assert.strictEqual(captured.get("bats-version"), "");
			assert.strictEqual(captured.get("bats-lib-path"), "");
			// And the run carried on: everything else is still published.
			assert.strictEqual(captured.get("package-manager"), "pnpm");
			assert.strictEqual(captured.get("node-enabled"), "true");
			assert.include(logs.join("\n"), "BATS installation failed: ");
			// kcov is gated on bats having *landed*: a coverage tool for a toolchain
			// that never installed has nothing to cover, so it was never fetched.
			assert.strictEqual(captured.get("kcov-enabled"), "false");
			assert.strictEqual(
				downloads.some((url) => url.includes("kcov")),
				false,
			);
		}),
	);

	it.effect("keeps a BATS whose kcov failed, and says so in the panel", () =>
		Effect.gen(function* () {
			const captured = new Map<string, string>();
			const logs: Array<string> = [];
			const panels: Array<string> = [];
			yield* program.pipe(
				Effect.provide(
					Layer.mergeAll(
						makeLayer(
							{
								set: (name, value) => Effect.sync(() => void captured.set(name, value)),
								addPath: () => Effect.void,
								exportVariable: () => Effect.void,
								summary: (content) => Effect.sync(() => void panels.push(content)),
							},
							undefined,
							{
								directory: { bats: true },
								tools: provisioningToolInstallerTest({ failing: "SimonKagstrom/kcov" }),
								filesystem: provisioningFileSystem,
							},
						),
						Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
					),
				),
			);

			// Neither install can fail the job, and one failing does not take the
			// other with it.
			assert.strictEqual(captured.get("bats-enabled"), "true");
			assert.strictEqual(captured.get("kcov-enabled"), "false");
			assert.strictEqual(captured.get("kcov-version"), "");
			assert.include(logs.join("\n"), "kcov installation failed: ");
			// The one row that reports a failure out loud: a kcov nobody asked for is
			// omitted, and this one was asked for. The outputs cannot tell those
			// apart, which is why the decision travels to the summary beside the
			// install result.
			assert.include(panels[0], "| kcov | ⚠️ unavailable |");
		}),
	);
});
