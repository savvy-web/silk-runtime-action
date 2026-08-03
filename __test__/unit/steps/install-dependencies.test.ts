import { delimiter } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ActionLogger } from "@effected/github-actions";
import { Effect, FileSystem, Layer, Logger, Option, PlatformError, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { PackageManagerName } from "../../../src/schema/domain.js";
import { InstallError, installDependencies } from "../../../src/steps/install-dependencies.js";
import type { ActivatedPackageManager } from "../../../src/steps/setup-package-manager.js";

/**
 * The spelling this process gives `PATH` — `Path` on Windows, `PATH` elsewhere.
 *
 * @remarks
 * The step reuses the existing key rather than adding one, so an assertion that
 * hard-coded `PATH` would be wrong on a Windows host. Derived the same way the
 * step derives it, which is the point: what is pinned is that the prepends
 * reach the child, not which case they arrive in.
 */
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";

/** A 2b result, with nothing this action put on disk unless a `binDir` is named. */
const activated = (name: PackageManagerName, binDir?: string): ActivatedPackageManager => ({
	name,
	version: "0.0.0",
	binDir: binDir === undefined ? Option.none() : Option.some(binDir),
});

/** One recorded `spawn`, down to the fields the command's correctness lives in. */
interface Invocation {
	readonly command: string;
	readonly args: ReadonlyArray<string>;
	readonly env: Record<string, string | undefined> | undefined;
	readonly extendEnv: boolean | undefined;
	readonly stdout: unknown;
	readonly shell: boolean | string | undefined;
}

/** What the doubled child process does once it has been spawned. */
interface Outcome {
	readonly exitCode?: number;
	readonly stderr?: string;
	readonly spawnFailure?: PlatformError.PlatformError;
}

interface Recorder {
	readonly spawns: Array<Invocation>;
	readonly probed: Array<string>;
	readonly logs: Array<string>;
}

const recorder = (): Recorder => ({ spawns: [], probed: [], logs: [] });

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A child process handle whose only interesting members are `stderr` and `exitCode`. */
const handleOf = (outcome: Outcome): ChildProcessSpawner.ChildProcessHandle =>
	ChildProcessSpawner.makeHandle({
		pid: ChildProcessSpawner.ProcessId(4242),
		exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(outcome.exitCode ?? 0)),
		isRunning: Effect.succeed(false),
		kill: () => Effect.void,
		stdin: Sink.drain,
		// Empty because the step inherits the child's stdout rather than reading
		// it: an install's own transcript goes straight to the workflow log.
		stdout: Stream.empty,
		stderr: outcome.stderr === undefined ? Stream.empty : Stream.make(encode(outcome.stderr)),
		all: Stream.empty,
		getInputFd: () => Sink.drain,
		getOutputFd: () => Stream.empty,
		unref: Effect.succeed(Effect.void),
	});

/**
 * A `ChildProcessSpawner` recording every command it is asked to spawn.
 *
 * @remarks
 * The legacy suite's eight install tests were vacuous: its runner double
 * answered any unmatched command with a zero exit, so wrong arguments still
 * passed (oracle 26-27). Here the command, its arguments and its environment
 * are recorded and asserted, so wrong arguments are red.
 */
const spawnerRecording = (log: Recorder, outcome: Outcome = {}): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
		spawn: (command) => {
			if (!ChildProcess.isStandardCommand(command)) {
				return Effect.die(new Error("expected a standard command, not a pipeline"));
			}
			log.spawns.push({
				command: command.command,
				args: command.args,
				env: command.options.env,
				extendEnv: command.options.extendEnv,
				stdout: command.options.stdout,
				shell: command.options.shell,
			});
			return outcome.spawnFailure === undefined ? Effect.succeed(handleOf(outcome)) : Effect.fail(outcome.spawnFailure);
		},
		// The step spawns for itself so it can read stderr while the install runs;
		// a derived member reaching here means it stopped doing that.
		exitCode: () => Effect.die(new Error("ChildProcessSpawner.exitCode not stubbed")),
		streamString: () => Stream.die(new Error("ChildProcessSpawner.streamString not stubbed")),
		streamLines: () => Stream.die(new Error("ChildProcessSpawner.streamLines not stubbed")),
		lines: () => Effect.die(new Error("ChildProcessSpawner.lines not stubbed")),
		string: () => Effect.die(new Error("ChildProcessSpawner.string not stubbed")),
	});

/** A `FileSystem` in which exactly `present` exists, recording every probe. */
const fsWith = (log: Recorder, present: ReadonlyArray<string>): Layer.Layer<FileSystem.FileSystem> =>
	FileSystem.layerNoop({
		exists: (path) => {
			log.probed.push(path);
			return Effect.succeed(present.includes(path));
		},
	});

/** A `FileSystem` whose every probe fails, as an unreadable working tree would. */
const fsFailing = (log: Recorder): Layer.Layer<FileSystem.FileSystem> =>
	FileSystem.layerNoop({
		exists: (path) => {
			log.probed.push(path);
			return Effect.fail(
				PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "exists" }),
			);
		},
	});

const layerFor = (
	log: Recorder,
	options: { readonly present?: ReadonlyArray<string>; readonly outcome?: Outcome; readonly unreadable?: boolean } = {},
) =>
	Layer.mergeAll(
		spawnerRecording(log, options.outcome ?? {}),
		options.unreadable === true ? fsFailing(log) : fsWith(log, options.present ?? []),
		ActionLogger.layerTest({}),
		Logger.layer([
			Logger.make<unknown, void>(({ message }) => {
				log.logs.push(Array.isArray(message) ? message.map(String).join(" ") : String(message));
			}),
		]),
	);

/** Runs the step against a workspace containing exactly `present`. */
const run = (
	log: Recorder,
	pm: ActivatedPackageManager,
	options: {
		readonly present?: ReadonlyArray<string>;
		readonly outcome?: Outcome;
		readonly unreadable?: boolean;
		readonly enabled?: boolean;
		readonly prepends?: ReadonlyArray<string>;
		readonly platform?: string;
	} = {},
) =>
	installDependencies(pm, options.enabled ?? true, options.prepends ?? [], options.platform ?? "linux").pipe(
		Effect.provide(layerFor(log, options)),
	);

describe("installDependencies", () => {
	it.effect("runs `npm ci` when a package-lock.json is present", () =>
		Effect.gen(function* () {
			const log = recorder();
			const result = yield* run(log, activated("npm"), { present: ["package-lock.json"] });

			expect(log.spawns).toHaveLength(1);
			expect(log.spawns[0]?.command).toBe("npm");
			expect(log.spawns[0]?.args).toEqual(["ci"]);
			expect(result).toEqual({ ran: true });
		}),
	);

	it.effect("runs `npm install` when no package-lock.json is present", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("npm"));

			expect(log.spawns[0]?.args).toEqual(["install"]);
		}),
	);

	it.effect("runs `pnpm install --frozen-lockfile` when a pnpm-lock.yaml is present", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("pnpm"), { present: ["pnpm-lock.yaml"] });

			expect(log.spawns[0]?.command).toBe("pnpm");
			expect(log.spawns[0]?.args).toEqual(["install", "--frozen-lockfile"]);
		}),
	);

	it.effect("runs a plain `pnpm install` when no pnpm-lock.yaml is present", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("pnpm"));

			expect(log.spawns[0]?.args).toEqual(["install"]);
		}),
	);

	it.effect("runs `yarn install --immutable` when a yarn.lock is present", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("yarn"), { present: ["yarn.lock"] });

			expect(log.spawns[0]?.command).toBe("yarn");
			expect(log.spawns[0]?.args).toEqual(["install", "--immutable"]);
		}),
	);

	it.effect("runs `yarn install --no-immutable` when no yarn.lock is present", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("yarn"));

			// The one manager that *adds* a flag in the absent case, and the one
			// install this action performs that may rewrite a lockfile in CI
			// (oracle 8). Ported deliberately.
			expect(log.spawns[0]?.args).toEqual(["install", "--no-immutable"]);
		}),
	);

	it.effect("runs `bun install --frozen-lockfile` for the text bun.lock", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("bun"), { present: ["bun.lock"] });

			expect(log.spawns[0]?.command).toBe("bun");
			expect(log.spawns[0]?.args).toEqual(["install", "--frozen-lockfile"]);
			// The first probe answered, so the legacy format is never looked for:
			// the two probes short-circuit rather than both running unconditionally.
			expect(log.probed).toEqual(["bun.lock"]);
		}),
	);

	it.effect("runs `bun install --frozen-lockfile` for the binary bun.lockb", () =>
		Effect.gen(function* () {
			const log = recorder();
			// The probe legacy performed and never tested (oracle 9, 25).
			yield* run(log, activated("bun"), { present: ["bun.lockb"] });

			expect(log.spawns[0]?.args).toEqual(["install", "--frozen-lockfile"]);
			expect(log.probed).toEqual(["bun.lock", "bun.lockb"]);
		}),
	);

	it.effect("runs a plain `bun install` when neither bun lockfile is present", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("bun"));

			expect(log.spawns[0]?.args).toEqual(["install"]);
		}),
	);

	it.effect("probes lockfiles by bare, working-directory-relative name", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("pnpm"), { present: ["pnpm-lock.yaml"] });

			// Relative, exactly as legacy probed (oracle 2): the action runs in the
			// checkout, and an absolute path would have to invent a root.
			expect(log.probed).toEqual(["pnpm-lock.yaml"]);
		}),
	);

	it.effect("treats an unreadable working tree as a workspace with no lockfile", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("npm"), { unreadable: true });

			// Any probe failure is `false` (oracle 2). Installing without `ci` is the
			// recoverable answer; failing the step over a stat is not.
			expect(log.spawns[0]?.args).toEqual(["install"]);
		}),
	);

	it.effect("skips the install entirely for deno", () =>
		Effect.gen(function* () {
			const log = recorder();
			const result = yield* run(log, activated("deno"), { present: ["deno.lock"] });

			expect(log.logs).toContain("Deno caches dependencies automatically, skipping install step");
			expect(log.probed).toEqual([]);
			expect(log.spawns).toEqual([]);
			// Truthful, unlike legacy's summary row, which mirrored the raw input and
			// reported deno's skipped install as done (oracle 17, 33).
			expect(result).toEqual({ ran: false });
		}),
	);

	it.effect("neither probes nor spawns when dependency installation is disabled", () =>
		Effect.gen(function* () {
			const log = recorder();
			const result = yield* run(log, activated("pnpm"), { present: ["pnpm-lock.yaml"], enabled: false });

			expect(log.probed).toEqual([]);
			expect(log.spawns).toEqual([]);
			expect(result).toEqual({ ran: false });
			expect(log.logs).not.toContain("Dependencies installed successfully");
		}),
	);

	it.effect("logs the success line after a clean install", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("pnpm"), { present: ["pnpm-lock.yaml"] });

			expect(log.logs).toContain("Dependencies installed successfully");
		}),
	);

	it.effect("prepends the manager's bin directory to the child's PATH", () =>
		Effect.gen(function* () {
			const log = recorder();
			const previous = process.env.PATH;
			process.env.PATH = "/usr/bin";
			try {
				yield* run(log, activated("pnpm", "/opt/toolcache/pnpm/10.20.0/.bin"), {
					present: ["pnpm-lock.yaml"],
					prepends: ["/opt/toolcache/pnpm/10.20.0/.bin"],
				});
			} finally {
				process.env.PATH = previous;
			}

			// `addPath` writes GITHUB_PATH for *later* steps and never touches this
			// process, so the child has to be told where the manager landed. Bare
			// name plus PATH rather than an absolute path so that lifecycle scripts
			// the manager itself spawns resolve it too.
			expect(log.spawns[0]?.command).toBe("pnpm");
			expect(log.spawns[0]?.env).toEqual({ PATH: `/opt/toolcache/pnpm/10.20.0/.bin${delimiter}/usr/bin` });
			// Without this the child would run with *only* PATH set.
			expect(log.spawns[0]?.extendEnv).toBe(true);
		}),
	);

	it.effect("prepends every installed directory, in the order it was given them", () =>
		Effect.gen(function* () {
			const log = recorder();
			const previous = process.env.PATH;
			process.env.PATH = "/usr/bin";
			try {
				yield* run(log, activated("pnpm", "/opt/toolcache/pnpm/10.20.0/.bin"), {
					present: ["pnpm-lock.yaml"],
					prepends: [
						"/opt/toolcache/pnpm/10.20.0/.bin",
						"/opt/toolcache/node/24.11.0/bin",
						"/opt/toolcache/bun/1.3.3",
						"/opt/toolcache/deno/2.5.6",
					],
				});
			} finally {
				process.env.PATH = previous;
			}

			// The runtimes are here because the install is not a leaf: a lifecycle
			// script running `deno install` resolves `deno` off the PATH it inherits
			// from this child. With only the manager prepended it found nothing —
			// `deno: not found`, on every runner OS.
			//
			// One value, one delimiter, manager first: its shims win a name collision
			// with a same-named runtime.
			expect(log.spawns[0]?.env).toEqual({
				PATH: [
					"/opt/toolcache/pnpm/10.20.0/.bin",
					"/opt/toolcache/node/24.11.0/bin",
					"/opt/toolcache/bun/1.3.3",
					"/opt/toolcache/deno/2.5.6",
					"/usr/bin",
				].join(delimiter),
			});
			expect(log.spawns[0]?.extendEnv).toBe(true);
		}),
	);

	it.effect("prepends onto the PATH variable the process actually has, whatever its case", () =>
		Effect.gen(function* () {
			const log = recorder();
			const previous = process.env.PATH;
			// What a Windows runner's environment looks like. Node does resolve a
			// `PATH` emitted beside an inherited `Path` — `normalizeSpawnArguments`
			// de-duplicates case-insensitively on win32 and keeps the
			// lexicographically-first key — but that is an undocumented internal.
			// Reusing the existing spelling means not relying on it.
			process.env.Path = "C:\\bin";
			delete process.env.PATH;
			try {
				yield* run(log, activated("npm", "/tool/.bin"), { prepends: ["/tool/.bin"] });
			} finally {
				delete process.env.Path;
				if (previous !== undefined) process.env.PATH = previous;
			}

			expect(log.spawns[0]?.env).toEqual({ Path: `/tool/.bin${delimiter}C:\\bin` });
		}),
	);

	it.effect("leaves the environment alone when there is nothing to prepend", () =>
		Effect.gen(function* () {
			const log = recorder();
			// An ambient manager and no runtime this run installed: the empty list is
			// what that looks like here, and the child inherits the environment
			// untouched rather than getting a PATH that only restates it.
			yield* run(log, activated("npm"), { prepends: [] });

			expect(log.spawns[0]?.env).toBeUndefined();
			expect(log.spawns[0]?.extendEnv).toBeUndefined();
		}),
	);

	it.effect("lets the install write its own transcript straight to the workflow log", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("pnpm"));

			// Legacy streamed install output live. Inheriting stdout is what keeps
			// that true, and it is also what keeps a chatty install from filling a
			// pipe nobody drains.
			expect(log.spawns[0]?.stdout).toBe("inherit");
		}),
	);

	it.effect("launches the manager through a shell on Windows", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("pnpm", "C:\\tool\\.bin"), {
				present: ["pnpm-lock.yaml"],
				prepends: ["C:\\tool\\.bin"],
				platform: "win32",
			});

			// Every node-based manager on a Windows PATH is a `.cmd` batch shim.
			// CreateProcess cannot execute one, and since CVE-2024-27980 Node will
			// not even hand it over without a shell — a direct spawn died at launch
			// with `NotFound: ChildProcess.spawn`, before the install ran.
			expect(log.spawns[0]?.shell).toBe(true);
			// The bare name and the argv are untouched by the shell.
			expect(log.spawns[0]?.command).toBe("pnpm");
			expect(log.spawns[0]?.args).toEqual(["install", "--frozen-lockfile"]);
			// And so is the PATH the child gets: `cmd.exe` resolves the bare name
			// off the *child's* environment, so the prepends are what make the
			// manager findable at all under a shell. Keyed by whatever spelling
			// this process has, so the assertion holds on a Windows host too.
			expect(log.spawns[0]?.env).toEqual({ [pathKey]: `C:\\tool\\.bin${delimiter}${process.env[pathKey] ?? ""}` });
			expect(log.spawns[0]?.extendEnv).toBe(true);
		}),
	);

	it.effect("launches bun through a shell on Windows too", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("bun", "C:\\tool\\bun"), {
				present: ["bun.lock"],
				prepends: ["C:\\tool\\bun"],
				platform: "win32",
			});

			// bun is the one manager that did *not* need this — `bun.exe` is a real
			// binary, and bun-as-manager was the single Windows job passing before
			// the fix. Shelling it anyway is deliberate: `cmd.exe` resolves a bare
			// `bun` through PATHEXT, where `.EXE` precedes `.CMD`, so it finds the
			// same executable in the same prepended directory. One launch path for
			// all four managers, at no cost to the one that was already fine.
			expect(log.spawns[0]?.shell).toBe(true);
			expect(log.spawns[0]?.command).toBe("bun");
			expect(log.spawns[0]?.args).toEqual(["install", "--frozen-lockfile"]);
		}),
	);

	it.effect("spawns the manager directly everywhere else", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("pnpm"), { present: ["pnpm-lock.yaml"], platform: "darwin" });

			// POSIX behavior is unchanged by the Windows fix: no shell between this
			// step and the manager, so nothing re-interprets the command line and
			// the exit code arrives from the manager itself.
			expect(log.spawns[0]?.shell).toBeUndefined();
		}),
	);

	it.effect("reports a command that could not be spawned at all", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				run(log, activated("pnpm"), {
					outcome: {
						spawnFailure: PlatformError.systemError({
							_tag: "NotFound",
							module: "ChildProcess",
							method: "spawn",
							description: "pnpm",
						}),
					},
				}),
			);

			expect(error._tag).toBe("InstallError");
			expect(error.reason).toBe("spawn");
			expect(error.message).toContain("Failed to install dependencies with pnpm: ");
			expect(error.cause).toBeDefined();
		}),
	);

	it.effect("reports a non-zero exit with the command, the code and the stderr tail", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				run(log, activated("pnpm"), {
					present: ["pnpm-lock.yaml"],
					outcome: { exitCode: 1, stderr: "ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with frozen-lockfile\n" },
				}),
			);

			expect(error.reason).toBe("exit-code");
			expect(error.message).toContain("pnpm install --frozen-lockfile");
			expect(error.message).toContain("exited with code 1");
			expect(error.message).toContain("ERR_PNPM_OUTDATED_LOCKFILE");
			expect(error.cause).toBeDefined();
		}),
	);

	it.effect("names the failure once, not twice", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(run(log, activated("yarn"), { outcome: { exitCode: 2 } }));

			// Legacy nested its own prose inside itself: the class rendered "Failed to
			// install dependencies with yarn: Failed to install dependencies: …"
			// (oracle 21). One prefix, ruled.
			expect(error.message.split("Failed to install dependencies")).toHaveLength(2);
			expect(error.message.startsWith("Failed to install dependencies with yarn: ")).toBe(true);
		}),
	);

	it.effect("carries only the tail of a long stderr into the message", () =>
		Effect.gen(function* () {
			const log = recorder();
			const stderr = Array.from({ length: 40 }, (_unused, index) => `line ${index}`).join("\n");
			const error = yield* Effect.flip(run(log, activated("npm"), { outcome: { exitCode: 1, stderr } }));

			// Exactly the last ten, pinned at the boundary: `line 30` is the oldest
			// line kept and `line 29` the newest dropped. The whole point of a tail
			// is that a failure message stays readable when the install spilled
			// hundreds of lines, all of which the log already has.
			expect(error.message).toContain("line 39");
			expect(error.message).toContain("line 30");
			expect(error.message).not.toContain("line 29");
		}),
	);

	it.effect("replays what the install wrote to stderr", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* run(log, activated("npm"), { outcome: { stderr: "npm warn deprecated left-pad@1.3.0\n" } });

			// A warning on a green install is still worth seeing; the step reads
			// stderr for the failure tail, so echoing it is what keeps it visible.
			expect(log.logs).toContain("npm warn deprecated left-pad@1.3.0");
		}),
	);

	it("InstallError carries its tag and reason", () => {
		const error = new InstallError({ reason: "spawn", message: "boom" });
		expect(error._tag).toBe("InstallError");
		expect(error.reason).toBe("spawn");
	});
});
