import { describe, expect, it } from "@effect/vitest";
import {
	ActionLogger,
	ActionOutputs,
	RunnerFileUnavailableError,
	ToolInstaller,
	ToolInstallerError,
} from "@effected/github-actions";
import { Effect, Layer, Logger, Option, Path, Stream } from "effect";
import type { ChildProcess } from "effect/unstable/process";
import { ChildProcessSpawner } from "effect/unstable/process";

import { RuntimeConfig } from "../../../src/schema/domain.js";
import type { Host } from "../../../src/steps/install-runtimes.js";
import { RuntimeInstallError, currentHost, installRuntimes } from "../../../src/steps/install-runtimes.js";

/** The host every case runs against unless it is testing a different one. */
const LINUX_X64: Host = { platform: "linux", arch: "x64" };

/** A config carrying exactly the runtimes a case needs, in declaration order. */
const configOf = (
	first: { name: "node" | "bun" | "deno"; version: string },
	...rest: ReadonlyArray<{ name: "node" | "bun" | "deno"; version: string }>
) => RuntimeConfig.make({ packageManager: { name: "pnpm", version: "10.20.0" }, runtimes: [first, ...rest] });

/**
 * A `ChildProcessSpawner` double.
 *
 * @remarks
 * Written out member by member rather than through `ChildProcessSpawner.make`,
 * which derives every member from `spawn` and so would need a whole
 * `ChildProcessHandle` to stub the one member the verify probe uses. Every
 * other member dies, per the house rule.
 */
const spawnerTest = (
	onExitCode: (command: ChildProcess.Command) => Effect.Effect<number>,
): Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =>
	Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
		spawn: () => Effect.die(new Error("ChildProcessSpawner.spawn not stubbed")),
		exitCode: (command) => Effect.map(onExitCode(command), ChildProcessSpawner.ExitCode),
		streamString: () => Stream.die(new Error("ChildProcessSpawner.streamString not stubbed")),
		streamLines: () => Stream.die(new Error("ChildProcessSpawner.streamLines not stubbed")),
		lines: () => Effect.die(new Error("ChildProcessSpawner.lines not stubbed")),
		string: () => Effect.die(new Error("ChildProcessSpawner.string not stubbed")),
	});

/** Records what a case's doubles were asked to do, so order and elision are assertable. */
interface Recorder {
	readonly calls: Array<string>;
	readonly urls: Array<string>;
	readonly paths: Array<string>;
	readonly probes: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
	readonly logs: Array<string>;
}

const recorder = (): Recorder => ({ calls: [], urls: [], paths: [], probes: [], logs: [] });

/** A `find` that reports every tool as already cached, at the canonical layout. */
const hit =
	(log: Recorder): ToolInstaller["Service"]["find"] =>
	(tool, version) =>
		Effect.sync(() => {
			log.calls.push(`find:${tool}@${version}`);
			return Option.some(`/opt/toolcache/${tool}/${version}`);
		});

/**
 * Every service `installRuntimes` requires, doubled around a happy-path
 * install.
 *
 * @remarks
 * `installer` overrides individual `ToolInstaller` members; `bareInstaller`
 * drops the happy-path doubles entirely, so every member the case does not
 * stub dies — which is how "this step was skipped" becomes an assertion rather
 * than an absence.
 */
const layerFor = (
	log: Recorder,
	options: {
		readonly installer?: Partial<ToolInstaller["Service"]>;
		readonly bareInstaller?: boolean;
		readonly exitCode?: number;
		readonly addPath?: ActionOutputs["Service"]["addPath"];
	} = {},
) =>
	Layer.mergeAll(
		ToolInstaller.layerTest({
			...(options.bareInstaller === true
				? {}
				: {
						find: (tool, version) =>
							Effect.sync(() => {
								log.calls.push(`find:${tool}@${version}`);
								return Option.none();
							}),
						download: (url) =>
							Effect.sync(() => {
								log.calls.push("download");
								log.urls.push(url);
								return "/tmp/archive";
							}),
						extractTar: (archive, extract) =>
							Effect.sync(() => {
								log.calls.push(`extractTar:${archive}:${(extract?.flags ?? []).join(" ")}`);
								return "/tmp/extracted";
							}),
						extractZip: (archive) =>
							Effect.sync(() => {
								log.calls.push(`extractZip:${archive}`);
								return "/tmp/extracted";
							}),
						cacheDir: (source, tool, version) =>
							Effect.sync(() => {
								log.calls.push(`cacheDir:${source}:${tool}@${version}`);
								return `/opt/toolcache/${tool}/${version}`;
							}),
					}),
			...options.installer,
		}),
		ActionOutputs.layerTest({
			addPath:
				options.addPath ??
				((path) =>
					Effect.sync(() => {
						log.calls.push(`addPath:${path}`);
						log.paths.push(path);
					})),
		}),
		ActionLogger.layerTest({}),
		Logger.layer([
			Logger.make<unknown, void>(({ message }) => {
				log.logs.push(Array.isArray(message) ? message.map(String).join(" ") : String(message));
			}),
		]),
		Path.layer,
		spawnerTest((command) =>
			Effect.sync(() => {
				// A piped command would be a bug: the probe is one binary, one flag.
				if (command._tag !== "StandardCommand") throw new Error("expected a standard command");
				log.calls.push(`probe:${command.command}`);
				log.probes.push({ command: command.command, args: command.args });
				return options.exitCode ?? 0;
			}),
		),
	);

describe("installRuntimes", () => {
	it.effect("installs a runtime the cache does not have, in one download/extract/cache pass", () =>
		Effect.gen(function* () {
			const log = recorder();
			const installed = yield* installRuntimes(configOf({ name: "node", version: "24.11.0" }), LINUX_X64).pipe(
				Effect.provide(layerFor(log)),
			);

			expect(installed).toEqual([{ name: "node", version: "24.11.0", path: "/opt/toolcache/node/24.11.0/bin" }]);
			expect(log.urls).toEqual(["https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.gz"]);
			expect(log.calls).toEqual([
				"find:node@24.11.0",
				"download",
				"extractTar:/tmp/archive:xz --strip=1 -f",
				"cacheDir:/tmp/extracted:node@24.11.0",
				"addPath:/opt/toolcache/node/24.11.0/bin",
				"probe:/opt/toolcache/node/24.11.0/bin/node",
			]);
		}),
	);

	it.effect("short-circuits on a tool-cache hit, still publishing PATH and verifying", () =>
		Effect.gen(function* () {
			const log = recorder();
			const installed = yield* installRuntimes(configOf({ name: "node", version: "24.11.0" }), LINUX_X64).pipe(
				Effect.provide(
					// Only `find` is stubbed: a download, extraction or cache write
					// reaching this double dies rather than quietly succeeding.
					layerFor(log, { bareInstaller: true, installer: { find: hit(log) } }),
				),
			);

			expect(installed[0]?.path).toBe("/opt/toolcache/node/24.11.0/bin");
			expect(log.calls).toEqual([
				"find:node@24.11.0",
				"addPath:/opt/toolcache/node/24.11.0/bin",
				"probe:/opt/toolcache/node/24.11.0/bin/node",
			]);
		}),
	);

	it.effect("extracts a zip-archived runtime with extractZip", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* installRuntimes(configOf({ name: "deno", version: "2.5.6" }), LINUX_X64).pipe(
				Effect.provide(layerFor(log)),
			);
			expect(log.calls).toContain("extractZip:/tmp/archive");
			expect(log.calls.some((call) => call.startsWith("extractTar"))).toBe(false);
		}),
	);

	it.effect("publishes the cached path unchanged when the plan has no binSubPath", () =>
		Effect.gen(function* () {
			const log = recorder();
			const installed = yield* installRuntimes(configOf({ name: "deno", version: "2.5.6" }), LINUX_X64).pipe(
				Effect.provide(layerFor(log)),
			);
			expect(installed[0]?.path).toBe("/opt/toolcache/deno/2.5.6");
			expect(log.paths).toEqual(["/opt/toolcache/deno/2.5.6"]);
		}),
	);

	it.effect("caches the inside of node's Windows wrapper directory, not the wrapper", () =>
		Effect.gen(function* () {
			const log = recorder();
			const installed = yield* installRuntimes(configOf({ name: "node", version: "24.11.0" }), {
				platform: "win32",
				arch: "x64",
			}).pipe(Effect.provide(layerFor(log)));
			const path = yield* Path.Path;

			// The wrapper is stripped before the cache write, so the cached root is
			// the canonical layout every other writer of the shared tool cache uses.
			expect(log.calls).toContain(`cacheDir:${path.join("/tmp/extracted", "node-v24.11.0-win-x64")}:node@24.11.0`);
			expect(installed[0]?.path).toBe("/opt/toolcache/node/24.11.0");
			expect(log.paths).toEqual(["/opt/toolcache/node/24.11.0"]);
			expect(log.probes[0]?.command).toBe(path.join("/opt/toolcache/node/24.11.0", "node.exe"));
		}).pipe(Effect.provide(Path.layer)),
	);

	it.effect("caches the inside of bun's archive folder, not the folder", () =>
		Effect.gen(function* () {
			const log = recorder();
			const installed = yield* installRuntimes(configOf({ name: "bun", version: "1.3.3" }), LINUX_X64).pipe(
				Effect.provide(layerFor(log)),
			);
			expect(log.calls).toContain("cacheDir:/tmp/extracted/bun-linux-x64:bun@1.3.3");
			expect(installed[0]?.path).toBe("/opt/toolcache/bun/1.3.3");
			expect(log.probes[0]?.command).toBe("/opt/toolcache/bun/1.3.3/bun");
		}),
	);

	it.effect("resolves a Windows node cache hit to the same path a miss produces", () =>
		Effect.gen(function* () {
			const log = recorder();
			const installed = yield* installRuntimes(configOf({ name: "node", version: "24.11.0" }), {
				platform: "win32",
				arch: "x64",
			}).pipe(Effect.provide(layerFor(log, { bareInstaller: true, installer: { find: hit(log) } })));
			const path = yield* Path.Path;

			expect(installed[0]?.path).toBe("/opt/toolcache/node/24.11.0");
			expect(log.probes[0]?.command).toBe(path.join("/opt/toolcache/node/24.11.0", "node.exe"));
		}).pipe(Effect.provide(Path.layer)),
	);

	it.effect("resolves a bun cache hit to the same path a miss produces", () =>
		Effect.gen(function* () {
			const log = recorder();
			const installed = yield* installRuntimes(configOf({ name: "bun", version: "1.3.3" }), LINUX_X64).pipe(
				Effect.provide(layerFor(log, { bareInstaller: true, installer: { find: hit(log) } })),
			);
			expect(installed[0]?.path).toBe("/opt/toolcache/bun/1.3.3");
			expect(log.probes[0]?.command).toBe("/opt/toolcache/bun/1.3.3/bun");
		}),
	);

	it.effect("verifies by running the installed binary, not whatever is on PATH", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* installRuntimes(configOf({ name: "deno", version: "2.5.6" }), LINUX_X64).pipe(
				Effect.provide(layerFor(log)),
			);
			expect(log.probes).toEqual([{ command: "/opt/toolcache/deno/2.5.6/deno", args: ["--version"] }]);
		}),
	);

	it.effect("installs every runtime sequentially, in devEngines order", () =>
		Effect.gen(function* () {
			const log = recorder();
			const installed = yield* installRuntimes(
				configOf({ name: "node", version: "24.11.0" }, { name: "bun", version: "1.3.3" }),
				LINUX_X64,
			).pipe(Effect.provide(layerFor(log)));

			expect(installed.map((runtime) => runtime.name)).toEqual(["node", "bun"]);
			// node's whole sequence completes before bun's begins.
			expect(log.calls.indexOf("find:bun@1.3.3")).toBeGreaterThan(
				log.calls.indexOf("cacheDir:/tmp/extracted:node@24.11.0"),
			);
		}),
	);

	it.effect("logs one step line per runtime, as `{name} {version}`", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* installRuntimes(
				configOf({ name: "node", version: "24.11.0" }, { name: "bun", version: "1.3.3" }),
				LINUX_X64,
			).pipe(Effect.provide(layerFor(log)));
			expect(log.logs).toContain("node 24.11.0");
			expect(log.logs).toContain("bun 1.3.3");
		}),
	);

	it.effect("defaults the host to the process it is running on", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* installRuntimes(configOf({ name: "node", version: "24.11.0" })).pipe(Effect.provide(layerFor(log)));
			const host = currentHost();
			expect(log.urls[0]).toContain(`-${host.platform === "win32" ? "win" : host.platform}-`);
		}),
	);

	it.effect("reports a download failure as one RuntimeInstallError naming the runtime", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				installRuntimes(configOf({ name: "node", version: "24.11.0" }), LINUX_X64).pipe(
					Effect.provide(
						layerFor(log, {
							installer: {
								download: (url) =>
									Effect.fail(new ToolInstallerError({ reason: "downloadFailed", subject: url, status: 404 })),
							},
						}),
					),
				),
			);

			expect(error._tag).toBe("RuntimeInstallError");
			expect(error.reason).toBe("download");
			// The kit error's prose, not its discriminant: a failed job says what
			// went wrong and where.
			expect(error.message).toBe(
				"Failed to install node@24.11.0: Could not download https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.gz (HTTP 404)",
			);
			expect(error.cause).toBeDefined();
		}),
	);

	it.effect("classifies an extraction failure as extract", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				installRuntimes(configOf({ name: "deno", version: "2.5.6" }), LINUX_X64).pipe(
					Effect.provide(
						layerFor(log, {
							installer: {
								extractZip: (archive) =>
									Effect.fail(new ToolInstallerError({ reason: "extractFailed", subject: archive })),
							},
						}),
					),
				),
			);
			expect(error.reason).toBe("extract");
		}),
	);

	it.effect("classifies a tool-cache failure as cache", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				installRuntimes(configOf({ name: "deno", version: "2.5.6" }), LINUX_X64).pipe(
					Effect.provide(
						layerFor(log, {
							installer: {
								cacheDir: (_directory, tool) =>
									Effect.fail(new ToolInstallerError({ reason: "cacheFailed", subject: tool })),
							},
						}),
					),
				),
			);
			expect(error.reason).toBe("cache");
		}),
	);

	it.effect("refuses a platform the runtime publishes no build for", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				installRuntimes(configOf({ name: "deno", version: "2.5.6" }), { platform: "win32", arch: "arm64" }).pipe(
					Effect.provide(layerFor(log)),
				),
			);
			expect(error.reason).toBe("unsupported-platform");
			expect(error.message).toBe("Failed to install deno@2.5.6: Unsupported platform for Deno: win32-arm64");
			// Nothing was downloaded: the refusal happens before any I/O.
			expect(log.calls).toEqual([]);
		}),
	);

	it.effect("classifies a non-zero verify probe as verify", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				installRuntimes(configOf({ name: "deno", version: "2.5.6" }), LINUX_X64).pipe(
					Effect.provide(layerFor(log, { exitCode: 127 })),
				),
			);
			expect(error.reason).toBe("verify");
			expect(error.message).toBe("Failed to install deno@2.5.6: /opt/toolcache/deno/2.5.6/deno --version exited 127");
		}),
	);

	it.effect("classifies a PATH publication failure as verify", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				installRuntimes(configOf({ name: "deno", version: "2.5.6" }), LINUX_X64).pipe(
					Effect.provide(
						layerFor(log, {
							addPath: () => Effect.fail(new RunnerFileUnavailableError({ file: "GITHUB_PATH" })),
						}),
					),
				),
			);
			expect(error.reason).toBe("verify");
			expect(error.message).toBe(
				'Failed to install deno@2.5.6: Runner file "GITHUB_PATH" is not available; is this running on a GitHub runner?',
			);
		}),
	);

	it.effect("stops at the first failing runtime rather than installing the rest", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* Effect.flip(
				installRuntimes(
					configOf({ name: "node", version: "24.11.0" }, { name: "bun", version: "1.3.3" }),
					LINUX_X64,
				).pipe(
					Effect.provide(
						layerFor(log, {
							installer: {
								download: (url) => Effect.fail(new ToolInstallerError({ reason: "downloadFailed", subject: url })),
							},
						}),
					),
				),
			);
			expect(log.calls).not.toContain("find:bun@1.3.3");
		}),
	);

	it("RuntimeInstallError carries its tag and reason", () => {
		const error = new RuntimeInstallError({ reason: "download", message: "download failed" });
		expect(error._tag).toBe("RuntimeInstallError");
		expect(error.reason).toBe("download");
		expect(error.message).toBe("download failed");
	});
});

describe("currentHost", () => {
	it("reads the runner's platform and architecture from the process", () => {
		expect(currentHost()).toEqual({ platform: process.platform, arch: process.arch });
	});
});
