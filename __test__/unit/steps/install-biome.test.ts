import { assert, describe, it } from "@effect/vitest";
import type { ProvisionFileOptions } from "@effected/github-actions";
import {
	ActionLogger,
	ActionOutputs,
	RunnerFileWriteError,
	ToolInstaller,
	ToolInstallerError,
} from "@effected/github-actions";
import { MemoryFileSystem } from "@effected/memfs";
import { Effect, Layer, Logger, Option, References } from "effect";

import { installBiome } from "../../../src/steps/install-biome.js";

/** The tool cache the double provisions into. */
const CACHED = "/opt/hostedtoolcache/biome/2.4.9/x64";

/** Everything a case cares about from one run's interactions with the runner. */
interface Recorded {
	readonly provisioned: Array<ProvisionFileOptions>;
	readonly paths: Array<string>;
	readonly logs: Array<string>;
}

/**
 * The services the step needs, with `provisionFile` answering `answer`.
 *
 * @remarks
 * `provisionFile` is the only `ToolInstaller` member stubbed: `find`,
 * `download`, `cacheFile` and the chmod are the provisioner's job now, so a
 * step reaching for one of them dies rather than passing.
 */
const makeLayer = (
	recorded: Recorded,
	answer: (
		options: ProvisionFileOptions,
	) => Effect.Effect<{ directory: string; binDir: string }, ToolInstallerError> = () =>
		Effect.succeed({ directory: CACHED, binDir: CACHED }),
) =>
	Layer.mergeAll(
		ToolInstaller.layerTest({
			provisionFile: (options) => {
				recorded.provisioned.push(options);
				return answer(options);
			},
		}),
		ActionOutputs.layerTest({ addPath: (path) => Effect.sync(() => void recorded.paths.push(path)) }),
		MemoryFileSystem.layer,
		ActionLogger.layerTest({}),
		Logger.layer([Logger.make(({ message }) => void recorded.logs.push(String(message)))]),
		Layer.succeed(References.MinimumLogLevel)("Debug"),
	);

/** A fresh recorder. */
const recorder = (): Recorded => ({ provisioned: [], paths: [], logs: [] });

/** A linux x64 runner, so a case that does not care about the host says nothing. */
const LINUX = { platform: "linux", arch: "x64" };

describe("installBiome", () => {
	it.effect("installs nothing when no version was resolved", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const installed = yield* installBiome(Option.none(), LINUX).pipe(Effect.provide(makeLayer(recorded)));

			assert.deepStrictEqual(installed, Option.none());
			assert.deepStrictEqual(recorded.provisioned, []);
			assert.deepStrictEqual(recorded.paths, []);
		}),
	);

	it.effect("provisions the resolved version and publishes its directory to PATH", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const installed = yield* installBiome(Option.some("2.4.9"), LINUX).pipe(Effect.provide(makeLayer(recorded)));

			assert.deepStrictEqual(recorded.provisioned, [
				{
					tool: "biome",
					version: "2.4.9",
					url: "https://github.com/biomejs/biome/releases/download/%40biomejs%2Fbiome%402.4.9/biome-linux-x64",
					binary: "biome",
				},
			]);
			// The cached directory holds exactly the executable, so it is what goes
			// on the PATH — the provisioner's `binDir`, not a path derived here.
			assert.deepStrictEqual(recorded.paths, [CACHED]);
			assert.deepStrictEqual(installed, Option.some({ version: "2.4.9", path: CACHED }));
		}),
	);

	it.effect("asks for the host's own asset, under the name the host invokes", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			yield* installBiome(Option.some("2.4.9"), { platform: "win32", arch: "x64" }).pipe(
				Effect.provide(makeLayer(recorded)),
			);

			assert.strictEqual(
				recorded.provisioned[0]?.url,
				"https://github.com/biomejs/biome/releases/download/%40biomejs%2Fbiome%402.4.9/biome-win32-x64.exe",
			);
			assert.strictEqual(recorded.provisioned[0]?.binary, "biome.exe");
		}),
	);

	it.effect("fails as a detect problem on a host biome does not publish for", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const error = yield* installBiome(Option.some("2.4.9"), { platform: "freebsd", arch: "x64" }).pipe(
				Effect.provide(makeLayer(recorded)),
				Effect.flip,
			);

			assert.strictEqual(error._tag, "BiomeInstallError");
			assert.strictEqual(error.reason, "detect");
			// v1's prose, verbatim.
			assert.strictEqual(error.message, "Unsupported platform for Biome: freebsd-x64");
			assert.deepStrictEqual(recorded.provisioned, []);
		}),
	);

	it.effect("maps the provisioner's reasons onto its own", () =>
		Effect.gen(function* () {
			const cases: ReadonlyArray<readonly [ToolInstallerError["reason"], string]> = [
				["downloadFailed", "download"],
				["cacheFailed", "cache"],
				// Unreachable for a single binary — there is no archive to extract —
				// but the union is the provisioner's, so every literal in it is spelled
				// out. The mapping switch has no fallback, so a fourth reason upstream
				// is a typecheck failure rather than a silent `cache`; this list is
				// the runtime half of that, and covers the union exhaustively.
				["extractFailed", "cache"],
			];
			for (const [reason, expected] of cases) {
				const error = yield* installBiome(Option.some("2.4.9"), LINUX).pipe(
					Effect.provide(
						makeLayer(recorder(), () => Effect.fail(new ToolInstallerError({ reason, subject: "biome" }))),
					),
					Effect.flip,
				);
				assert.strictEqual(error.reason, expected);
				// The provisioner's own prose is carried through rather than wrapped:
				// the call site adds the one prefix a reader needs (oracle 28).
				assert.include(error.message, "biome");
				assert.isDefined(error.cause);
			}
		}),
	);

	it.effect("fails when what it provisioned cannot be published to PATH", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			const error = yield* installBiome(Option.some("2.4.9"), LINUX).pipe(
				Effect.provide(
					Layer.mergeAll(
						ToolInstaller.layerTest({
							provisionFile: (options) => {
								recorded.provisioned.push(options);
								return Effect.succeed({ directory: CACHED, binDir: CACHED });
							},
						}),
						ActionOutputs.layerTest({
							addPath: () => Effect.fail(new RunnerFileWriteError({ file: "GITHUB_PATH" })),
						}),
						MemoryFileSystem.layer,
						ActionLogger.layerTest({}),
					),
				),
				Effect.flip,
			);

			// A tool in the cache that this run could not make reachable is, to a
			// caller, the same as one that never landed — v1 swept the same failure
			// into its single catch (oracle 32).
			assert.strictEqual(error.reason, "cache");
			assert.include(error.message, "could not be published to PATH");
		}),
	);

	it.effect("says what it installed", () =>
		Effect.gen(function* () {
			const recorded = recorder();
			yield* installBiome(Option.some("2.4.9"), LINUX).pipe(Effect.provide(makeLayer(recorded)));
			assert.include(recorded.logs, "Biome 2.4.9");
		}),
	);
});
