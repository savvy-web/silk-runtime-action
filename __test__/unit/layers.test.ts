import { assert, describe, it } from "@effect/vitest";
import {
	ActionCache,
	ActionEnvironment,
	ActionOutputs,
	OidcTokenError,
	OidcTokenIssuer,
	PackageManagerInstaller,
	ToolInstaller,
} from "@effected/github-actions";
import { MemoryFileSystem } from "@effected/memfs";
import type { FileSystem } from "effect";
import { Effect, Layer, Path } from "effect";
import type { HttpClient } from "effect/http";
import { FetchHttpClient } from "effect/http";
import { ChildProcessSpawner as ChildProcessSpawnerNS } from "effect/process";

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
	| ActionOutputs
	| FileSystem.FileSystem
	| Path.Path
	| HttpClient.HttpClient
	| ChildProcessSpawnerNS.ChildProcessSpawner
> = Layer.mergeAll(
	ActionEnvironment.layerTest(),
	// The OIDC issuer masks through it at issuance; nothing here issues.
	ActionOutputs.layerTest(),
	// An empty in-memory volume: the layers only need the service present, and a
	// real volume fails honestly if one of them ever starts reading.
	MemoryFileSystem.layer,
	Path.layer,
	// No request is ever issued — the layers only need the service present.
	FetchHttpClient.layer,
	Layer.succeed(
		ChildProcessSpawnerNS.ChildProcessSpawner,
		ChildProcessSpawnerNS.make(() => Effect.die(new Error("ChildProcessSpawner.spawn not stubbed"))),
	),
);

describe("MainLive", () => {
	it.effect("builds the four services the default runtime omits", () =>
		Effect.gen(function* () {
			const services = yield* Effect.provide(
				Effect.all([ActionCache, PackageManagerInstaller, ToolInstaller, OidcTokenIssuer]),
				Layer.provide(MainLive, actionServicesTest),
			);
			assert.lengthOf(services, 4);
		}),
	);

	it.effect("builds the OIDC issuer on a runner that grants no id-token, failing only at use", () =>
		Effect.gen(function* () {
			// The layer is composed for every run, and most runs have no
			// `id-token: write`. Construction must ask the runner for nothing; the
			// missing grant is a typed `unavailable` when a token is asked for,
			// which is what the turbo step turns into its fallback.
			const error = yield* Effect.flatMap(OidcTokenIssuer, (issuer) =>
				issuer.token("https://cache.savvyweb.systems"),
			).pipe(Effect.flip, Effect.provide(Layer.provide(MainLive, actionServicesTest)));
			assert.instanceOf(error, OidcTokenError);
			assert.strictEqual(error.reason, "unavailable");
		}),
	);
});

describe("PostLive", () => {
	it.effect("builds only the runner cache", () =>
		Effect.gen(function* () {
			const cache = yield* Effect.provide(ActionCache, Layer.provide(PostLive, actionServicesTest));
			assert.isDefined(cache);
		}),
	);
});
