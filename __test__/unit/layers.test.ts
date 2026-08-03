import { describe, expect, it } from "@effect/vitest";
import { ActionCache, ActionEnvironment, PackageManagerInstaller, ToolInstaller } from "@effected/github-actions";
import { Effect, FileSystem, Layer, Path } from "effect";
import type { HttpClient } from "effect/unstable/http";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcessSpawner as ChildProcessSpawnerNS } from "effect/unstable/process";

import { MainLive, PostLive } from "../../src/layers/app.js";

/**
 * Everything `MainLive` and `PostLive` require, doubled.
 *
 * @remarks
 * This is the `ActionServices` subset `ActionRuntime.layer` supplies under
 * `Action.run` — `ActionCache.layer` and `ToolInstaller.layer` both declare
 * these, which is why `layers/app.ts` can *require* them rather than rebuild
 * them. Constructing the layers against it is the assertion: an added
 * requirement the runtime does not supply fails to compile here, and a
 * construction-time failure fails the run.
 */
const actionServicesTest: Layer.Layer<
	| ActionEnvironment
	| FileSystem.FileSystem
	| Path.Path
	| HttpClient.HttpClient
	| ChildProcessSpawnerNS.ChildProcessSpawner
> = Layer.mergeAll(
	ActionEnvironment.layerTest(),
	FileSystem.layerNoop({}),
	Path.layer,
	// No request is ever issued — the layers only need the service present.
	FetchHttpClient.layer,
	Layer.succeed(
		ChildProcessSpawnerNS.ChildProcessSpawner,
		ChildProcessSpawnerNS.make(() => Effect.die(new Error("ChildProcessSpawner.spawn not stubbed"))),
	),
);

describe("MainLive", () => {
	it.effect("builds the three services the default runtime omits", () =>
		Effect.gen(function* () {
			const services = yield* Effect.provide(
				Effect.all([ActionCache, PackageManagerInstaller, ToolInstaller]),
				Layer.provide(MainLive, actionServicesTest),
			);
			expect(services).toHaveLength(3);
		}),
	);
});

describe("PostLive", () => {
	it.effect("builds only the runner cache", () =>
		Effect.gen(function* () {
			const cache = yield* Effect.provide(ActionCache, Layer.provide(PostLive, actionServicesTest));
			expect(cache).toBeDefined();
		}),
	);
});
