---
status: current
module: silk-runtime-action
category: architecture
created: 2026-03-21
updated: 2026-07-17
last-synced: 2026-07-17
completeness: 92
related:
  - ./architecture.md
  - ./effect-service-model.md
dependencies: []
---

# Runtime installation

The `RuntimeInstaller` service, per-runtime descriptors, package manager setup and Biome binary installation.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Rationale](#rationale)
4. [Implementation details](#implementation-details)
5. [Related documentation](#related-documentation)

---

## Overview

Runtime installation is the core operation of the action: downloading, extracting, caching and verifying Node.js, Bun and Deno. The design splits *what to install* (descriptors) from *how to install* (the `RuntimeInstaller` service), keeping per-runtime data minimal and the shared install flow centralized.

**Key features:**

- `RuntimeDescriptor` interface: pure data describing each runtime's download mechanics.
- `makeRuntimeInstaller(descriptor)` factory: turns a descriptor into a service shape.
- Pre-built layers per runtime (`NodeInstallerLive`, `BunInstallerLive`, `DenoInstallerLive`) selected by `installerLayerFor(name)`.
- `setupPackageManager` runs in `program.ts` after all runtimes are installed and on PATH.
- Biome is a single-binary download, not a runtime. `installBiome` in `program.ts` uses `ToolInstaller.cacheFile` rather than the archive flow.

**When to load this doc:**

- Adding a new runtime.
- Modifying download URL patterns or archive handling.
- Debugging runtime installation or package manager activation.

---

## Current state

### `RuntimeDescriptor` interface

See `src/services/runtime-installer.ts` for the exact shape. Descriptors are pure data with three responsibilities:

- `getDownloadUrl(version, platform, arch)` -- assemble the release URL.
- `getToolInstallOptions(version, platform, arch)` -- archive type, bin sub-path, tar flags.
- `verifyCommand` -- the command run after install to prove the binary works.

Descriptor implementations live in `src/descriptors/{node,bun,deno}.ts`. New runtimes are pure data additions.

### Biome descriptor

Biome is **not** a `RuntimeDescriptor`. `src/descriptors/biome.ts` exports a `binaryMap` (platform/arch -> binary file name). `installBiome` in `src/program.ts` consumes it directly and uses `ToolInstaller.download` + `ToolInstaller.cacheFile` to install a single executable. URL pattern: `https://github.com/biomejs/biome/releases/download/%40biomejs%2Fbiome%40{version}/{binaryName}`.

### `RuntimeInstaller` service

```ts
export interface RuntimeInstallerShape {
  readonly install: (
    version: string,
  ) => Effect.Effect<InstalledRuntime, RuntimeInstallError, ToolInstaller | CommandRunner | ActionOutputs>;
}

export class RuntimeInstaller extends Context.Service<RuntimeInstaller, RuntimeInstallerShape>()("RuntimeInstaller") {}
```

Note the Effect v4 `Context.Service` class form with an exported `RuntimeInstallerShape` companion interface (replaces v3's `Context.Tag`/`Context.GenericTag` + inline object shape). Callers `yield* RuntimeInstaller` and downstream typing resolves through the static service identity.

`InstalledRuntime`:

```ts
interface InstalledRuntime {
  readonly name: string;
  readonly version: string;
  readonly path: string;
}
```

### Per-runtime layers

```ts
export const NodeInstallerLive = Layer.succeed(RuntimeInstaller, makeRuntimeInstaller(nodeDescriptor));
export const BunInstallerLive  = Layer.succeed(RuntimeInstaller, makeRuntimeInstaller(bunDescriptor));
export const DenoInstallerLive = Layer.succeed(RuntimeInstaller, makeRuntimeInstaller(denoDescriptor));

export const installerLayerFor = (name: string): Layer.Layer<RuntimeInstaller, RuntimeInstallError> => { ... };
```

The pipeline iterates runtimes and provides the correct layer per iteration:

```ts
Effect.forEach(config.runtimes, (rt) =>
  RuntimeInstaller.pipe(
    Effect.flatMap((installer) => installer.install(rt.version)),
    Effect.provide(installerLayerFor(rt.name)),
    Effect.tap((result) => Step.success(`${rt.name} ${result.version}`)),
  ),
)
```

---

## Rationale

### Descriptors are pure data

Descriptors carry no `postInstall` hook or side-effectful methods. Package manager setup is a separate `setupPackageManager` step in `program.ts` because:

1. PM setup depends on Node.js already being on PATH.
2. `corepack prepare` for pnpm must run from a temp directory to avoid workspace `pnpm-workspace.yaml configDependencies` interference.
3. Node >= 25 requires installing corepack globally via npm first (no longer bundled).
4. Bun and Deno are their own package managers.

### Biome is not a `RuntimeDescriptor`

Biome distributes a single binary, not a compressed archive. `RuntimeInstaller` uses the archive flow (`extractTar`/`extractZip` + `cacheDir`); Biome uses `ToolInstaller.download` + `ToolInstaller.cacheFile`. The two are distinct enough that sharing the abstraction would mean adding flags to every descriptor.

### `Context.Service` class + per-iteration layer swap

The main pipeline installs multiple runtimes in sequence; each needs a different descriptor. The v4 `Context.Service` class form lets callers `yield* RuntimeInstaller` directly. The per-iteration `Effect.provide(installerLayerFor(rt.name))` swaps the implementation cleanly inside the `Effect.forEach`. The v3 `Context.Tag`/`GenericTag` form has been retired across the codebase. Note that `installerLayerFor`'s fallback for an unknown runtime is `Layer.effect(RuntimeInstaller, Effect.fail(new RuntimeInstallError(...)))` — v4 has no `Layer.fail`, so a failing layer is expressed as `Layer.effect(tag, Effect.fail(...))`.

---

## Implementation details

### `makeRuntimeInstaller` flow

For the full implementation see `src/services/runtime-installer.ts`. High level:

1. Yields `ToolInstaller`, `CommandRunner`, `ActionOutputs`.
2. Computes URL via `descriptor.getDownloadUrl(version, process.platform, process.arch)`.
3. Computes options via `descriptor.getToolInstallOptions(...)`.
4. Downloads with `toolInstaller.download(url)`.
5. Extracts: `extractZip` if `archiveType === "zip"`, else `extractTar(downloadedPath, undefined, options.tarFlags)`.
6. Caches with `toolInstaller.cacheDir(extractedDir, descriptor.name, version)`.
7. Adds `binSubPath`-adjusted path to PATH via `outputs.addPath`.
8. Verifies with `runner.exec(descriptor.verifyCommand[0], [...descriptor.verifyCommand.slice(1)])`.
9. All failures wrapped in `RuntimeInstallError` via `Effect.catch` (v4's rename of `catchAll`) + `extractErrorReason`.

### Package manager setup (`program.setupPackageManager`)

Runs after all runtimes are installed.

**npm:** Compare `npm --version` with the required version. If different: `sudo npm install -g npm@{version}` on Linux/macOS (followed by a `chown -R` of `~/.npm` to fix root-owned files from sudo); `npm install -g` on Windows.

**pnpm / yarn:** Run all corepack commands from `tmpdir()` to avoid `pnpm-workspace.yaml configDependencies` hangs. If Node major >= 25, install corepack globally first (`sudo npm install -g --force corepack@latest` on Linux/macOS). Then `corepack enable` (with stale-shim retry on EEXIST) and `corepack prepare {pm}@{version} --activate`.

**bun / deno:** No setup; they are their own package manager.

### `installBiome` (in `program.ts`)

See `src/program.ts`. Look up binary name from `binaryMap[platform][arch]`, download via `ToolInstaller.download`, cache as a single file via `ToolInstaller.cacheFile(downloadedPath, finalName, "biome", version)`, `chmod 0o755` on non-Windows, add cached dir to PATH, emit `Step.success(\`Biome ${version}\`)`. Entire effect is wrapped in`Effect.catch` at the call site so Biome failures never fail the workflow.

### Dependency installation (`program.installDependencies`)

Lockfile-aware install command per package manager (see `src/program.ts` for the full mapping). Lockfile existence is checked via `FileSystem.access()`. Deno is skipped (it caches automatically). On failure, the raw error is wrapped in `DependencyInstallError` with stderr appended to the reason when available.

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) -- overall system design and pipeline shape.
- [Effect service model](./effect-service-model.md) -- service tag patterns, error types, layer composition.

**Source files:**

- `src/services/runtime-installer.ts` -- service tag, factory, per-runtime layers.
- `src/descriptors/node.ts`, `src/descriptors/bun.ts`, `src/descriptors/deno.ts` -- runtime descriptors.
- `src/descriptors/biome.ts` -- Biome binary map.
- `src/program.ts` -- `setupPackageManager`, `installBiome`, `installDependencies`.
