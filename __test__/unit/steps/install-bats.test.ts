import { describe, expect, it } from "@effect/vitest";
import { ScriptedSpawner } from "@effected/commands";
import { ActionLogger, ActionOutputs, ToolInstaller, ToolInstallerError } from "@effected/github-actions";
import { Effect, FileSystem, Layer, Logger, Option, Path, References } from "effect";

import { installBats } from "../../../src/steps/install-bats.js";

const HOME = "/home/runner";
const TOOL = "/opt/hostedtoolcache/bats/1.14.0/x64";

interface Recorded {
	readonly downloaded: Array<string>;
	readonly paths: Array<string>;
	readonly env: Array<readonly [string, string]>;
	readonly written: Array<string>;
	readonly logs: Array<string>;
}

const recorder = (): Recorded => ({ downloaded: [], paths: [], env: [], written: [], logs: [] });

/** A jq probe that always reports present, unless a suite overrides the spawner layer. */
const jqPresent = ScriptedSpawner.make(() => ({ stdout: "jq-1.7\n", exit: 0 }));

const makeLayer = (r: Recorded, overrides: Partial<Parameters<typeof ToolInstaller.layerTest>[0]> = {}) =>
	Layer.mergeAll(
		ToolInstaller.layerTest({
			download: (url: string) => {
				r.downloaded.push(url);
				return Effect.succeed(`/tmp/dl/${r.downloaded.length}.tar.gz`);
			},
			extractTar: () => Effect.succeed("/tmp/x"),
			cacheDir: () => Effect.succeed(TOOL),
			...overrides,
		}),
		ActionOutputs.layerTest({
			addPath: (p) => Effect.sync(() => void r.paths.push(p)),
			exportVariable: (n, v) => Effect.sync(() => void r.env.push([n, v])),
		}),
		FileSystem.layerNoop({
			makeDirectory: () => Effect.void,
			copy: () => Effect.void,
			access: () => Effect.void,
			writeFileString: (p: string) => Effect.sync(() => void r.written.push(p)),
			chmod: () => Effect.void,
		}),
		Path.layer,
		ActionLogger.layerTest({}),
		Logger.layer([Logger.make(({ message }) => void r.logs.push(String(message)))]),
		Layer.succeed(References.MinimumLogLevel)("Debug"),
		jqPresent.layer,
	);

describe("installBats", () => {
	it.effect("installs nothing when the decision was not to install", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installBats(false, HOME).pipe(Effect.provide(makeLayer(r)));
			expect(Option.isNone(result)).toBe(true);
			expect(r.downloaded).toEqual([]);
			expect(r.paths).toEqual([]);
		}),
	);

	it.effect("downloads bats-core and all four libraries", () =>
		Effect.gen(function* () {
			const r = recorder();
			yield* installBats(true, HOME).pipe(Effect.provide(makeLayer(r)));
			expect(r.downloaded).toHaveLength(5);
			expect(r.downloaded[0]).toContain("bats-core/archive/refs/tags/v1.14.0");
			expect(r.downloaded.some((u) => u.includes("jasonkarns/bats-mock"))).toBe(true);
			// access() succeeds under this layer's default, so every library's
			// load.bash is reported present and no loader should be synthesized.
			expect(r.written).toEqual([]);
		}),
	);

	it.effect("publishes the tool-cache bin directory to PATH", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installBats(true, HOME).pipe(Effect.provide(makeLayer(r)));
			expect(r.paths).toEqual([`${TOOL}/bin`]);
			expect(Option.isSome(result) && result.value.binDir).toBe(`${TOOL}/bin`);
		}),
	);

	it.effect("exports BATS_LIB_PATH at the shared library root, not per library", () =>
		Effect.gen(function* () {
			const r = recorder();
			yield* installBats(true, HOME).pipe(Effect.provide(makeLayer(r)));
			expect(r.env).toContainEqual(["BATS_LIB_PATH", `${HOME}/.local/share`]);
			expect(r.env).toContainEqual(["BATS_PATH", `${TOOL}/bin/bats`]);
		}),
	);

	it.effect("synthesizes a load.bash for bats-mock when the tarball ships none", () =>
		Effect.gen(function* () {
			const r = recorder();
			yield* installBats(true, HOME).pipe(
				Effect.provide(
					Layer.mergeAll(
						makeLayer(r),
						// bats-mock's load.bash is absent: `access` fails for it alone.
						FileSystem.layerNoop({
							makeDirectory: () => Effect.void,
							copy: () => Effect.void,
							access: (p: string) =>
								p.endsWith("bats-mock/load.bash") ? Effect.fail(new Error("absent") as never) : Effect.void,
							writeFileString: (p: string) => Effect.sync(() => void r.written.push(p)),
							chmod: () => Effect.void,
						}),
					),
				),
			);
			expect(r.written).toContain(`${HOME}/.local/share/bats-mock/load.bash`);
		}),
	);

	it.effect("fails typed when a download fails", () =>
		Effect.gen(function* () {
			const r = recorder();
			const error = yield* installBats(true, HOME).pipe(
				Effect.provide(
					makeLayer(r, {
						download: () => Effect.fail(new ToolInstallerError({ reason: "downloadFailed", subject: "bats-core" })),
					}),
				),
				Effect.flip,
			);
			expect(error._tag).toBe("BatsInstallError");
			expect(error.reason).toBe("download");
		}),
	);

	it.effect("warns but does not fail when jq is absent", () =>
		Effect.gen(function* () {
			const r = recorder();
			const jqAbsent = ScriptedSpawner.make((command) => ScriptedSpawner.notFound(command));
			const result = yield* installBats(true, HOME).pipe(Effect.provide(Layer.mergeAll(makeLayer(r), jqAbsent.layer)));
			expect(Option.isSome(result)).toBe(true);
			expect(r.logs.some((line) => line.includes("jq was not found"))).toBe(true);
		}),
	);
});
