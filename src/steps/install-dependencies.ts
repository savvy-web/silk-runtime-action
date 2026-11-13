import { ActionLogger, ChildEnv } from "@effected/github-actions";
import type { PlatformError } from "effect";
import { Data, Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner, CommandLine } from "effect/process";

import type { PackageManagerName } from "../schema/domain.js";
import type { ActivatedPackageManager } from "./setup-package-manager.js";

/**
 * Raised when the package manager's install command cannot be spawned, or
 * exits non-zero.
 *
 * @remarks
 * `spawn` covers every platform failure around running the command, not only
 * the launch itself: reading its stderr and waiting on its exit code fail the
 * same way and mean the same thing to a caller — the install did not run to a
 * verdict. `exit-code` is reserved for a command that ran and reported failure.
 *
 * That split shifts on Windows, where the command is launched through a shell:
 * `cmd.exe` itself always launches, so a manager that is not on the child's
 * `PATH` at all comes back as an `exit-code` failure — `cmd.exe`'s own 9009,
 * "is not recognized as an internal or external command" — rather than the
 * `spawn` a POSIX runner would report for the same missing binary.
 */
export class InstallError extends Data.TaggedError("InstallError")<{
	readonly reason: "spawn" | "exit-code";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** How many trailing stderr lines a failure message carries. */
const STDERR_TAIL_LINES = 10;

/**
 * The lockfiles whose presence switches a manager into its reproducible mode,
 * and the arguments for each answer.
 *
 * @remarks
 * Probed as bare, working-directory-relative names, exactly as legacy did
 * (oracle 2): the action runs inside the checkout, and an absolute path would
 * have to invent a root the action is not given.
 *
 * bun probes two lockfiles because it has shipped two formats: the current text
 * `bun.lock` and the older binary `bun.lockb`.
 */
const PLANS: Record<
	Exclude<PackageManagerName, "deno">,
	{
		readonly lockfiles: ReadonlyArray<string>;
		readonly locked: ReadonlyArray<string>;
		readonly unlocked: ReadonlyArray<string>;
	}
> = {
	npm: { lockfiles: ["package-lock.json"], locked: ["ci"], unlocked: ["install"] },
	pnpm: { lockfiles: ["pnpm-lock.yaml"], locked: ["install", "--frozen-lockfile"], unlocked: ["install"] },
	bun: { lockfiles: ["bun.lock", "bun.lockb"], locked: ["install", "--frozen-lockfile"], unlocked: ["install"] },
};

/**
 * The flag every manager spells "run the install, but none of the packages'
 * lifecycle scripts as it goes".
 *
 * @remarks
 * npm, pnpm and bun all document `--ignore-scripts`, and npm takes it on `ci`
 * as well as `install`, so it is one constant rather than a column in
 * {@link PLANS}.
 *
 * deno has no row because it has no install: `installDependencies` returns
 * before this is ever consulted.
 */
const IGNORE_SCRIPTS_ARGS: ReadonlyArray<string> = ["--ignore-scripts"];

/**
 * Whether any of `lockfiles` exists, with every probe failure read as absent.
 *
 * @remarks
 * Legacy collapsed any `access` rejection to `false` and this keeps that: a
 * workspace whose lockfile cannot be stat'ed installs without the frozen flag
 * rather than failing the step over a stat.
 *
 * Probes run in order and stop at the first hit, so bun's second probe only
 * happens when the first misses.
 */
const anyLockfile = (fs: FileSystem.FileSystem, lockfiles: ReadonlyArray<string>) =>
	Effect.reduce(
		lockfiles,
		() => false,
		(found, lockfile) =>
			found ? Effect.succeed(true) : fs.exists(lockfile).pipe(Effect.catch(() => Effect.succeed(false))),
	);

/**
 * The child environment for everything this action installed.
 *
 * @remarks
 * `ActionOutputs.addPath` appends to `GITHUB_PATH`, which only takes effect in
 * *later* workflow steps; it never mutates this process's own `PATH`. So a
 * manager sitting in the tool cache is unreachable here unless the child is
 * told where it is — and so is every runtime this run installed.
 *
 * The runtimes matter because the install is not a leaf: a package manager
 * spawns lifecycle scripts, and a `postinstall` running `deno install` or `bun
 * install` resolves that binary off the `PATH` it inherited from the install
 * child. Prepending only the manager's own directory left those scripts looking
 * at the runner image's bare `PATH`, where a `devEngines` runtime this action
 * had just installed simply is not — `deno: not found`.
 *
 * The manager is still spawned by bare name, with its directory prepended,
 * rather than by absolute path, for the same reason: the children inherit
 * `PATH`, not the absolute path their parent was invoked with.
 *
 * `ChildEnv.prependPath` owns the two traps this used to spell out itself — the
 * Windows `Path` casing the merged block has to be written through, and the
 * `extendEnv: true` that keeps `env` a merge rather than a wholesale
 * replacement, which is why the whole pair is spread rather than just `.env`.
 * Order stays the caller's and stays significant: the manager's own shim
 * directory leads, so it wins any name collision with a runtime of the same
 * name.
 *
 * The empty case is this function's own, because the kit's signature refuses it
 * by construction — nothing to prepend means no `env` key at all, not an entry
 * holding only the inherited value.
 *
 * `extra` is merged in beside the `PATH` entry, under the same `extendEnv: true`
 * — which this function now writes itself rather than spreading the kit's pair,
 * because the pair is only there when there is something to prepend and the
 * merge has to hold either way. It exists for the turbo environment: a variable
 * exported with `ActionOutputs.exportVariable` reaches later workflow steps and
 * never this process, for the same reason `addPath` does not, so a lifecycle
 * script that runs `turbo` only sees the remote cache when the install child is
 * handed it here.
 */
const childEnv = (
	pathPrepends: ReadonlyArray<string>,
	platform: string,
	extra: Readonly<Record<string, string>>,
): ChildProcess.CommandOptions => {
	const [first, ...rest] = pathPrepends;
	const path = first === undefined ? {} : ChildEnv.prependPath([first, ...rest], { base: process.env, platform }).env;
	// `PATH` is spread last so no caller-supplied variable can displace it.
	const env = { ...extra, ...path };
	return Object.keys(env).length === 0 ? {} : { env, extendEnv: true };
};

/**
 * Runs one install command, echoing its stderr and keeping the tail.
 *
 * @remarks
 * `stdout` is inherited, so the install's own transcript streams straight to
 * the workflow log as it happens — legacy's `streaming: true`, and the reason a
 * chatty install cannot fill a pipe nobody drains. `stderr` is piped instead —
 * spelled out rather than left to the default, because the asymmetry with
 * `stdout` is the design — because a failure message is far more useful with the
 * last few lines of it than without, and every line read is echoed so nothing is
 * swallowed.
 *
 * `ChildEnv.needsShell` decides the launch, and all three managers take its
 * `true` on win32 — bun included, which is this call site's own ruling rather
 * than the kit's. bun is the exception that shows the shape of the rule:
 * `bun.exe` is a real binary, not a `.cmd` shim, and bun-as-manager was the one
 * Windows job passing before the shell was introduced. Shelling it anyway costs
 * nothing — `cmd.exe` resolves a bare `bun` through `PATHEXT`, where `.EXE`
 * precedes `.CMD`, so it finds the same binary in the same prepended directory a
 * direct spawn found — and buys one launch path to reason about instead of two.
 * Legacy reached the same place by shelling every command on win32.
 *
 * Under `shell` the whole command line is the command, with no separate
 * arguments: since Effect 4.1 the spawner refuses `shell` combined with an
 * argument list rather than letting Node concatenate them. The line is built by
 * `CommandLine.join` in its `windows` format, which quotes for the program's
 * own argv parser. It does not escape for `cmd.exe`, which still expands
 * `%NAME%` and reads `^ & | < >` first, and that is safe here only because
 * every argument comes from `PLANS` or {@link IGNORE_SCRIPTS_ARGS}, both of which
 * yield static flag literals — no path, no version, nothing derived from an
 * input. A `CommandLineError` (a NUL byte, which no literal holds) fails the
 * launch the same way a spawn failure does.
 */
const spawnInstall = (
	name: PackageManagerName,
	args: ReadonlyArray<string>,
	pathPrepends: ReadonlyArray<string>,
	platform: string,
	env: Readonly<Record<string, string>>,
) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const options: ChildProcess.CommandOptions = {
			stdout: "inherit",
			stderr: "pipe",
			...childEnv(pathPrepends, platform, env),
		};
		const command = ChildEnv.needsShell(platform)
			? ChildProcess.make(yield* Effect.fromResult(CommandLine.join([name, ...args], { format: "windows" })), [], {
					...options,
					shell: true,
				})
			: ChildProcess.make(name, [...args], options);

		const handle = yield* spawner.spawn(command);
		const tail: Array<string> = [];
		yield* Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stderr)), (line) =>
			Effect.suspend(() => {
				tail.push(line);
				if (tail.length > STDERR_TAIL_LINES) tail.shift();
				return Effect.logInfo(line);
			}),
		);

		const exitCode = yield* handle.exitCode;
		return { exitCode: Number(exitCode), tail };
	}).pipe(Effect.scoped);

/**
 * Renders `detail` for a non-zero exit: what ran, how it ended, and the tail.
 *
 * @remarks
 * The tail is appended only when there is one, so a silent failure does not end
 * in a dangling newline (oracle 19).
 */
const exitDetail = (
	name: PackageManagerName,
	args: ReadonlyArray<string>,
	exitCode: number,
	tail: ReadonlyArray<string>,
): string => {
	const lines = tail.filter((line) => line.trim() !== "");
	const stderr = lines.length === 0 ? "" : `\n${lines.join("\n")}`;
	return `${name} ${args.join(" ")} exited with code ${exitCode}${stderr}`;
};

/** The install policy {@link installDependencies} runs under. */
export interface InstallOptions {
	/** Skip the packages' lifecycle scripts — the `ignore-scripts` input. */
	readonly ignoreScripts?: boolean;
	/**
	 * Variables the install child — and every lifecycle script it spawns — is
	 * given on top of the inherited environment. Never displaces `PATH`.
	 */
	readonly env?: Readonly<Record<string, string>>;
	/** The host platform; defaults to `process.platform`. A test seam. */
	readonly platform?: string;
}

/**
 * Runs the package manager's install command, when `enabled` is `true`.
 *
 * @remarks
 * `deno` is a complete skip with the legacy log line (oracle 14): it caches
 * modules on demand, so there is nothing to install ahead of time. `enabled`
 * false is a skip too, and neither probes nor spawns anything.
 *
 * The reported `ran` is **truthful**, which is where this parts company with
 * v1: legacy's summary mirrored the raw input and so reported deno's skipped
 * install as done (oracle 17, 33). It is `true` only when an install command
 * actually ran and succeeded.
 *
 * There is no timeout and no retry — a hung or flaky install fails the job the
 * way it did in v1 (oracle 11) — and the error is fatal: `program.ts`
 * deliberately does not catch it (oracle 20).
 *
 * The failure message names the failure exactly once. Legacy nested its own
 * prose inside itself, rendering "Failed to install dependencies with pnpm:
 * Failed to install dependencies: …" (oracle 21).
 *
 * `pathPrepends` is every directory this run put a binary in that the install —
 * or anything the install spawns — has to be able to find by bare name, in the
 * order they should be searched. The step joins them ahead of the inherited
 * `PATH`; it does not build or reorder the list, because assembling it needs
 * both the package-manager and runtime results and this step holds neither.
 * `pm.binDir` is *not* read for this: the caller has already folded it in at the
 * head of the list.
 *
 * `options.ignoreScripts` appends {@link IGNORE_SCRIPTS_ARGS} to whichever plan
 * the lockfile probe selected, so the flag composes with the frozen/immutable
 * decision rather than replacing it. It is inert for deno and for a disabled
 * install, both of which return before the plan is read — which is what makes
 * the input's "no effect unless `install-deps` is true" documented rule a
 * property of the code rather than a note.
 *
 * `options.env` is merged over the inherited environment for the install child,
 * beside the `PATH` prepends and never over them. The caller decides what goes
 * in it; today that is the turbo remote-cache environment, on runs where the
 * cache was started ahead of the install.
 *
 * `options.platform` decides whether the manager is launched through a shell
 * (`ChildEnv.needsShell`) and which delimiter joins the `PATH` prepends. It is
 * an argument with a `process.platform` default rather
 * than a read, mirroring `installRuntimes`' `host`: it is the seam that makes
 * the Windows branch exercisable without monkey-patching the process, and no
 * caller passes it.
 */
export const installDependencies = (
	pm: ActivatedPackageManager,
	enabled: boolean,
	pathPrepends: ReadonlyArray<string>,
	options: InstallOptions = {},
): Effect.Effect<
	{ readonly ran: boolean },
	InstallError,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | ActionLogger
> =>
	Effect.gen(function* () {
		if (!enabled) return { ran: false };

		if (pm.name === "deno") {
			yield* Effect.logInfo("Deno caches dependencies automatically, skipping install step");
			return { ran: false };
		}

		const fs = yield* FileSystem.FileSystem;
		const logger = yield* ActionLogger;
		const plan = PLANS[pm.name];
		const locked = yield* anyLockfile(fs, plan.lockfiles);
		const args = [
			...(locked ? plan.locked : plan.unlocked),
			...(options.ignoreScripts === true ? IGNORE_SCRIPTS_ARGS : []),
		];

		// Names only, never values: this is the line that says whether lifecycle
		// scripts in this install could reach the turbo remote cache at all.
		const handed = Object.keys(options.env ?? {});
		if (handed.length > 0) yield* Effect.logInfo(`Passing ${handed.join(", ")} to the install's environment`);

		// The buffer holds the echoed stderr rather than the install itself, whose
		// stdout is inherited and never passes through the logger. Held so an
		// interleaved dribble of warnings does not scramble the live transcript,
		// and flushed on every exit path so a failing install still shows all of
		// it — not just the tail the message carries.
		const { exitCode, tail } = yield* logger
			.withBuffer(
				pm.name,
				spawnInstall(pm.name, args, pathPrepends, options.platform ?? process.platform, options.env ?? {}),
			)
			.pipe(
				Effect.catch((cause: PlatformError.PlatformError | CommandLine.CommandLineError) =>
					Effect.fail(
						new InstallError({
							reason: "spawn",
							message: `Failed to install dependencies with ${pm.name}: ${cause.message}`,
							cause,
						}),
					),
				),
			);

		if (exitCode !== 0) {
			return yield* new InstallError({
				reason: "exit-code",
				message: `Failed to install dependencies with ${pm.name}: ${exitDetail(pm.name, args, exitCode, tail)}`,
				cause: { exitCode, stderr: tail.join("\n") },
			});
		}

		yield* Effect.logInfo("Dependencies installed successfully");
		return { ran: true };
	});
