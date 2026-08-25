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
import { WorkspaceDiscovery, WorkspaceRoot } from "@effected/workspaces";
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
 *
 * `WorkspaceDiscovery` is what tells `restoreCache` which directories the
 * workspace actually has, so the archive names each member's `node_modules`
 * rather than globbing for every `node_modules` under the checkout. It builds
 * over `WorkspaceRoot`, which is `provide`d rather than merged: nothing else in
 * the action resolves a workspace root, so there is no second consumer to keep
 * it visible for. Both are memoized per layer, so the discovery walk happens
 * once however many times the step asks.
 */
export const MainLive = Layer.mergeAll(
	ActionCache.layer,
	PackageManagerInstaller.layer,
	WorkspaceDiscovery.layer().pipe(Layer.provide(WorkspaceRoot.layer)),
).pipe(Layer.provideMerge(ToolInstaller.layer));

/**
 * The `post` phase's extra services: only the runner cache, which is what a
 * dependency-cache save needs. No tool installs happen after `main`.
 */
export const PostLive = ActionCache.layer;
