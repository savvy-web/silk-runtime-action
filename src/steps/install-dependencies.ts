import { ActionLogger, ChildEnv } from "@effected/github-actions";
import type { PlatformError } from "effect";
import { Data, Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
 * yarn is the one manager that adds a flag in the *absent* case, and
 * `--no-immutable` explicitly permits a lockfile rewrite in CI. That is a v1
 * behavior carried over deliberately rather than an oversight (oracle 8). bun
 * probes two lockfiles because it has shipped two formats: the current text
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
	yarn: { lockfiles: ["yarn.lock"], locked: ["install", "--immutable"], unlocked: ["install", "--no-immutable"] },
	bun: { lockfiles: ["bun.lock", "bun.lockb"], locked: ["install", "--frozen-lockfile"], unlocked: ["install"] },
};

/**
 * The flag each manager spells "run the install, but none of the packages'
 * lifecycle scripts as it goes".
 *
 * @remarks
 * Three of the four agree on `--ignore-scripts` — npm, pnpm and bun all
 * document it, and npm takes it on `ci` as well as `install`. yarn is the
 * outlier and is the reason this is a function rather than a fifth column in
 * {@link PLANS}: Berry (v2+) dropped `--ignore-scripts` in favour of the install
 * *mode* `--mode=skip-build`, while Classic (v1) only ever knew
 * `--ignore-scripts`. Nothing about the name `yarn` says which is in play, so
 * the pinned `devEngines` version decides — the same split `cache-config`'s
 * store table has to make, for the same reason.
 *
 * An unparseable major reads as Berry. `devEngines` versions are absolute, so
 * that branch is unreachable in production; when it is reached the modern
 * spelling is the better guess than a flag Berry rejects outright.
 *
 * deno has no row because it has no install: `installDependencies` returns
 * before this is ever consulted.
 */
const ignoreScriptsArgs = (pm: ActivatedPackageManager): ReadonlyArray<string> => {
	if (pm.name !== "yarn") return ["--ignore-scripts"];
	const major = Number.parseInt(pm.version.split(".")[0] ?? "", 10);
	return major === 1 ? ["--ignore-scripts"] : ["--mode=skip-build"];
};

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
 */
const childEnv = (pathPrepends: ReadonlyArray<string>, platform: string): ChildProcess.CommandOptions => {
	const [first, ...rest] = pathPrepends;
	if (first === undefined) return {};
	return ChildEnv.prependPath([first, ...rest], { base: process.env, platform });
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
 * `ChildEnv.needsShell` decides the launch, and all four managers take its
 * `true` on win32 — bun included, which is this call site's own ruling rather
 * than the kit's. bun is the exception that shows the shape of the rule:
 * `bun.exe` is a real binary, not a `.cmd` shim, and bun-as-manager was the one
 * Windows job passing before the shell was introduced. Shelling it anyway costs
 * nothing — `cmd.exe` resolves a bare `bun` through `PATHEXT`, where `.EXE`
 * precedes `.CMD`, so it finds the same binary in the same prepended directory a
 * direct spawn found — and buys one launch path to reason about instead of two.
 * Legacy reached the same place by shelling every command on win32.
 *
 * Under `shell`, Node concatenates the command and its arguments into a single
 * `cmd.exe` command line rather than passing an argv, which is a quoting hazard
 * for anything containing a space or a shell metacharacter. It is not one here:
 * every argument comes from `PLANS` or {@link ignoreScriptsArgs}, both of which
 * yield static flag literals — no path, no version, nothing derived from an
 * input.
 */
const spawnInstall = (
	name: PackageManagerName,
	args: ReadonlyArray<string>,
	pathPrepends: ReadonlyArray<string>,
	platform: string,
) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const command = ChildProcess.make(name, [...args], {
			stdout: "inherit",
			stderr: "pipe",
			...childEnv(pathPrepends, platform),
			...(ChildEnv.needsShell(platform) ? { shell: true } : {}),
		});

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
 * `options.ignoreScripts` appends {@link ignoreScriptsArgs} to whichever plan
 * the lockfile probe selected, so the flag composes with the frozen/immutable
 * decision rather than replacing it. It is inert for deno and for a disabled
 * install, both of which return before the plan is read — which is what makes
 * the input's "no effect unless `install-deps` is true" documented rule a
 * property of the code rather than a note.
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
			...(options.ignoreScripts === true ? ignoreScriptsArgs(pm) : []),
		];

		// The buffer holds the echoed stderr rather than the install itself, whose
		// stdout is inherited and never passes through the logger. Held so an
		// interleaved dribble of warnings does not scramble the live transcript,
		// and flushed on every exit path so a failing install still shows all of
		// it — not just the tail the message carries.
		const { exitCode, tail } = yield* logger
			.withBuffer(pm.name, spawnInstall(pm.name, args, pathPrepends, options.platform ?? process.platform))
			.pipe(
				Effect.catch((cause: PlatformError.PlatformError) =>
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
