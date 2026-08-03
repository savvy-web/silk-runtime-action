/**
 * Layer composition for the action's phases.
 *
 * @remarks
 * `ActionRuntime.layer` — which `Action.run` composes — already provides
 * `ActionEnvironment`, `ActionLogger`, `ActionOutputs`, `ActionState`,
 * `NodeServices` (`ChildProcessSpawner`, `Crypto`, `FileSystem`, `Path`,
 * `Stdio`, `Terminal`) and `HttpClient`. Nothing here rebuilds any of those.
 *
 * What it does add is the two services the kit deliberately keeps out of the
 * default runtime, because they are the only modules that pull in a
 * blob-storage client. Both declare requirements that `ActionServices` already
 * satisfies, and `ActionRunOptions.layer` is `Layer<R, never, ActionServices>`
 * — which is what lets these be *required* rather than rebuilt.
 *
 * @module layers/app
 */

import { ActionCache, PackageManagerInstaller, ToolInstaller } from "@effected/github-actions";
import { Layer } from "effect";

/**
 * The `main` phase's extra services: the runner cache (dependency restore), the
 * tool cache (runtime and Biome installs) and package-manager provisioning.
 *
 * @remarks
 * `PackageManagerInstaller` builds on the tool cache, so `ToolInstaller` is
 * `provideMerge`d rather than merged: one instance satisfies the installer's
 * requirement *and* stays available to `installRuntimes`, which uses it
 * directly. Everything the two layers still require — `ActionEnvironment`,
 * `FileSystem`, `Path`, `ChildProcessSpawner`, `HttpClient` — `ActionServices`
 * already provides.
 */
export const MainLive = Layer.mergeAll(ActionCache.layer, PackageManagerInstaller.layer).pipe(
	Layer.provideMerge(ToolInstaller.layer),
);

/**
 * The `post` phase's extra services: only the runner cache, which is what a
 * dependency-cache save needs. No tool installs happen after `main`.
 */
export const PostLive = ActionCache.layer;
