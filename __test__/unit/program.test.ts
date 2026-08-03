import { delimiter, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import type { CacheKey } from "@effected/github-actions";
import {
	ActionCache,
	ActionEnvironment,
	ActionInput,
	ActionLogger,
	ActionOutputs,
	ActionState,
	CachedPackageManager,
	PackageManagerInstaller,
	ToolInstaller,
	ToolInstallerError,
} from "@effected/github-actions";
import { Cause, Effect, Exit, FileSystem, Layer, Logger, Option, Path, PlatformError, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner as ChildProcessSpawnerNS } from "effect/unstable/process";

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
 * A `PackageManagerInstaller` double reporting the manifest's pnpm as already
 * in the tool cache, so the program's real package-manager step runs its
 * `addPath` path without downloading anything.
 */
const packageManagerInstallerTest = PackageManagerInstaller.layerTest({
	install: (pin) =>
		Effect.succeed(
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
}

/**
 * A `FileSystem` serving `package.json`, plus whatever `directory` says the
 * repository holds. Any other read dies loudly, for the same reason the spawner
 * double does: a read reaching here is a regression rather than a missing stub.
 */
const fileSystemTest = (
	manifest: string = packageJson,
	directory: WorkingDirectory = {},
): Layer.Layer<FileSystem.FileSystem> =>
	FileSystem.layerNoop({
		// The detectors probe working-directory-relative paths; anything absent
		// fails here exactly as it would on a real filesystem.
		access: (path) => {
			const present =
				(path === "biome.jsonc" && directory.biome !== undefined) ||
				(path === "turbo.json" && directory.turbo === true);
			return present
				? Effect.void
				: Effect.fail(
						PlatformError.systemError({
							_tag: "NotFound",
							module: "FileSystem",
							method: "access",
							pathOrDescriptor: path,
						}),
					);
		},
		readFileString: (path) => {
			if (path === "package.json") return Effect.succeed(manifest);
			if (path === "biome.jsonc" && directory.biome !== undefined) return Effect.succeed(directory.biome);
			return Effect.die(new Error(`unexpected FileSystem.readFileString(${path})`));
		},
		// A workspace with no lockfile *in the working directory*, so the install
		// step takes its plain-install branch. Stubbed rather than left to the noop
		// layer's rejection, which the step would read as "absent" anyway — this
		// says so on purpose.
		exists: () => Effect.succeed(false),
		// The checkout the cache restore walks, holding the one lockfile its
		// patterns match. `ActionEnvironment.layerTest` puts the workspace at
		// `/workspace`.
		readDirectory: (path) =>
			path === WORKSPACE
				? Effect.succeed([LOCKFILE])
				: Effect.die(new Error(`unexpected FileSystem.readDirectory(${path})`)),
		stat: () => Effect.succeed({ type: "File" } as FileSystem.File.Info),
		readFile: (path) =>
			path === join(WORKSPACE, LOCKFILE)
				? Effect.succeed(new TextEncoder().encode("lockfileVersion: '9.0'"))
				: Effect.die(new Error(`unexpected FileSystem.readFile(${path})`)),
	});

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
> =>
	Layer.mergeAll(
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
		fileSystemTest(options.manifest, options.directory),
		Path.layer,
		environment,
		childProcessSpawnerTest(options.spawns),
		options.inputs ?? actionInputTest,
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
			expect([...captured.keys()].sort()).toEqual([...OUTPUT_NAMES].sort());
		}),
	);

	it.effect("folds the package manager step's result into the outputs", () =>
		Effect.gen(function* () {
			const captured = yield* runProgram();
			// Both values come from the served manifest's `devEngines`, through
			// `loadConfig` and the (still echoing) package-manager stub.
			expect(captured.get("package-manager")).toBe("pnpm");
			expect(captured.get("package-manager-version")).toBe("10.20.0");
		}),
	);

	it.effect("folds every installed runtime into its version and enabled outputs", () =>
		Effect.gen(function* () {
			const captured = yield* runProgram(allRuntimesPackageJson);
			expect(captured.get("node-version")).toBe("24.11.0");
			expect(captured.get("node-enabled")).toBe("true");
			expect(captured.get("bun-version")).toBe("1.3.3");
			expect(captured.get("bun-enabled")).toBe("true");
			expect(captured.get("deno-version")).toBe("2.5.6");
			expect(captured.get("deno-enabled")).toBe("true");
		}),
	);

	it.effect("leaves a runtime the manifest never named at empty and disabled", () =>
		Effect.gen(function* () {
			// The default manifest declares node alone, so bun and deno report what a
			// runtime nobody installed reports — not the version of something that
			// was never fetched (oracle 46).
			const captured = yield* runProgram();
			expect(captured.get("node-version")).toBe("24.11.0");
			expect(captured.get("node-enabled")).toBe("true");
			expect(captured.get("bun-version")).toBe("");
			expect(captured.get("bun-enabled")).toBe("false");
			expect(captured.get("deno-version")).toBe("");
			expect(captured.get("deno-enabled")).toBe("false");
		}),
	);

	it.effect("quiets the tooling its own install steps invoke, on this process only", () =>
		withEnvRestored(
			Effect.gen(function* () {
				// Cleared first, so a value left behind by another test cannot make
				// this pass without the program having set anything.
				for (const name of Object.keys(QUIET_ENV)) delete process.env[name];

				yield* runProgram();

				expect(process.env.NPM_CONFIG_UPDATE_NOTIFIER).toBe(QUIET_ENV.NPM_CONFIG_UPDATE_NOTIFIER);
				expect(process.env.NPM_CONFIG_FUND).toBe(QUIET_ENV.NPM_CONFIG_FUND);
				expect(process.env.HUSKY).toBe(QUIET_ENV.HUSKY);
				expect(process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT).toBe(QUIET_ENV.COREPACK_ENABLE_DOWNLOAD_PROMPT);
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
			expect(install?.command).toBe("bun");
			expect(install?.env).toEqual({ PATH: `/opt/toolcache/bun/1.3.3${delimiter}/usr/bin` });
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
			expect(install?.command).toBe("pnpm");
			const entries = (install?.env?.PATH ?? "").split(delimiter);
			// The manager leads — its shims win any name collision. The runtimes
			// follow in `devEngines` declaration order, and each is matched by prefix
			// because the bin subdirectory below the cached root is the descriptor's
			// business and differs by platform.
			expect(entries[0]).toBe("/opt/toolcache/pnpm/10.20.0/.bin");
			expect(entries[1]?.startsWith("/opt/toolcache/node/24.11.0")).toBe(true);
			expect(entries[2]?.startsWith("/opt/toolcache/bun/1.3.3")).toBe(true);
			expect(entries[3]?.startsWith("/opt/toolcache/deno/2.5.6")).toBe(true);
			// The inherited PATH stays last, and nothing else was invented.
			expect(entries[4]).toBe("/usr/bin");
			expect(entries).toHaveLength(5);
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
			expect(install?.command).toBe("bun");
			const entries = (install?.env?.PATH ?? "").split(delimiter);
			expect(entries[0]).toBe("/opt/toolcache/bun/1.3.3");
			expect(entries[1]?.startsWith("/opt/toolcache/node/24.11.0")).toBe(true);
			expect(entries[2]).toBe("/usr/bin");
			// Three, not four: bun appears once despite reaching the list twice.
			expect(entries).toHaveLength(3);
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
			expect(exit._tag).toBe("Failure");
			// Which failure, not just that one happened: `Failure` alone would also
			// be satisfied by a step further down dying on a test double it never
			// got a chance to reach, and the assertion below would still hold if
			// that step ran before publishing anything. The tag is what says the
			// environment guard is the thing that stopped the run.
			const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
			expect(Option.getOrUndefined(error)?._tag).toBe("ActionEnvironmentError");
			// The whole point of the guard: nothing downstream got to run.
			expect(captured.size).toBe(0);
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

			expect(captured.get("biome-enabled")).toBe("true");
			expect(captured.get("biome-version")).toBe("2.4.9");
			// Detection alone is not the claim: the outputs say Biome is installed,
			// so it has to be on the PATH.
			expect(paths).toContain("/opt/toolcache/biome/2.4.9");
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

			expect(captured.get("biome-version")).toBe("2.3.14");
			expect(captured.get("biome-enabled")).toBe("true");
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
								provisionFile: () => Effect.fail(new ToolInstallerError({ reason: "downloadFailed", status: 404 })),
							}),
						}),
						Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
					),
				),
			);

			// Non-fatal (oracle 29): the run completes and every other output is
			// published. And the outputs are truthful — v1 set them from *detection*
			// and reported an enabled Biome that was never installed (oracle 30).
			expect(captured.get("biome-enabled")).toBe("false");
			expect(captured.get("biome-version")).toBe("");
			expect(captured.get("node-enabled")).toBe("true");
			// v1's prose for the warning, with the typed error's own message after it
			// rather than a stringified object.
			expect(logs.join("\n")).toContain("Biome installation failed: ");
			expect(logs.join("\n")).toContain("404");
			// And the closing group names the step that failed rather than
			// reporting a Biome that was detected as absent.
			expect(logs).toContain("Biome: detected, install failed");
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

			expect(captured.get("turbo-enabled")).toBe("true");
			// Detection and the cache backend are two different answers (oracle 27):
			// a repository with a `turbo.json` and the cache switched off reports an
			// enabled turbo and no backend.
			expect(captured.get("turbo-cache-backend")).toBe("none");
			expect(captured.get("turbo-cache-port")).toBe("");
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
			expect(turboCacheOutputs(started)).toEqual({ turboCacheBackend: backend, turboCachePort: port });
		}
		return Effect.void;
	});

	it.effect("leaves every other output at its all-disabled default", () =>
		Effect.gen(function* () {
			const captured = yield* runProgram();
			expect(captured.get("biome-version")).toBe("");
			expect(captured.get("biome-enabled")).toBe("false");
			expect(captured.get("turbo-enabled")).toBe("false");
			expect(captured.get("turbo-cache-backend")).toBe("none");
			expect(captured.get("turbo-cache-port")).toBe("");
			expect(captured.get("cache-hit")).toBe("false");
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
			expect(logs).toContain("node 24.11.0 · bun 1.3.3 · deno 2.5.6 · pnpm 10.20.0 · biome 2.4.9 · turbo");
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
			expect(panels[0]).toContain("| Dependencies | skipped |");
			expect(logs).toContain("Dependencies: skipped");
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

			expect(captured.get("cache-hit")).toBe("true");
			// The resolved file, not the pattern that found it.
			expect(captured.get("lockfiles")).toBe(join(WORKSPACE, LOCKFILE));
			const paths = (captured.get("cache-paths") ?? "").split(",");
			expect(paths).toContain("**/node_modules");
			expect(paths).toContain(join("/opt/hostedtoolcache", "node", "24.11.0"));
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
			expect(captured.get("cache-hit")).toBe("partial");
		}),
	);
});
