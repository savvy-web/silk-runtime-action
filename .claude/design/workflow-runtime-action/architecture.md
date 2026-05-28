---
status: current
module: silk-runtime-action
category: architecture
created: 2026-03-21
updated: 2026-05-28
last-synced: 2026-05-28
completeness: 92
related:
  - ./effect-service-model.md
  - ./caching-strategy.md
  - ./runtime-installation.md
  - ./build-and-distribution.md
dependencies: []
---

# Workflow runtime action - architecture

Top-level architecture of the Effect-based GitHub Action that sets up JavaScript runtimes, package managers and dependency caching from a single `package.json` `devEngines` configuration.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Rationale](#rationale)
4. [System architecture](#system-architecture)
5. [Data flow](#data-flow)
6. [Integration points](#integration-points)
7. [Related documentation](#related-documentation)

---

## Overview

The action is a compiled Node.js GitHub Action (`node24` runtime) that reads runtime and package manager configuration exclusively from the `devEngines` field in `package.json`. It supports Node.js, Bun and Deno with automatic dependency caching, optional Biome CLI installation and Turborepo detection.

Built on the Effect framework using `@savvy-web/github-action-effects` (^2.0.0) for all GitHub Actions runtime interactions. The library implements the GitHub Actions runtime protocol natively (V2 Twirp caching, Azure Blob Storage, native process execution) so the action has zero `@actions/*` direct or transitive dependencies.

**Design principles:**

- `package.json` `devEngines` is the only source of truth for runtime and PM versions. Absolute versions only.
- Side effects flow through Effect services for typed error handling, dependency injection and testability.
- Optional steps (cache restore, Biome install, post-action save) degrade to warnings rather than failing the workflow.
- `main.ts` is a 3-line entry. The program lives in `program.ts`; layer composition lives in `layers/app.ts`. Splitting these lets tests import `program` without triggering the `Action.run` side effect.

**When to load this doc:**

- Understanding entry topology and layer composition.
- Following data flow from `package.json` to cache key to outputs.
- Adding a new runtime or modifying the pipeline shape.

---

## Current state

### Entry points

| Entry | Source | Output | Purpose |
| --- | --- | --- | --- |
| `main` | `src/main.ts` | `dist/main.js` | Thin wrapper: `Action.run(program, { layer: MainLive })` |
| `post` | `src/post.ts` | `dist/post.js` | Cache save after job; never fails workflow |

`main.ts` is 3 lines (excluding imports). `program.ts` owns the Effect pipeline. There is no `pre` hook.

### Source module map

| Module | Path | Responsibility |
| --- | --- | --- |
| Entry | `src/main.ts` | `Action.run(program, { layer: MainLive })` |
| Program | `src/program.ts` | Nine-step Effect pipeline + helpers (`installBiome`, `installDependencies`, `setupPackageManager`, `setOutputs`) |
| Post | `src/post.ts` | Read `CacheState`, save cache when no exact hit; catches all errors and defects |
| Layers | `src/layers/app.ts` | `MainLive` layer composition |
| State | `src/state.ts` | `CacheState` (`Schema.Class`) and `STATE_KEYS` |
| Config | `src/services/config-loader.ts` | `loadPackageJson`, `parseDevEngines`, `detectBiome`, `detectTurbo` |
| Cache | `src/services/cache.ts` | Key generation, restore/save, lockfile detection via `Glob`, cache path resolution |
| Runtime installer | `src/services/runtime-installer.ts` | `RuntimeInstaller` (`Context.Tag` class), `makeRuntimeInstaller`, per-runtime layers |
| Schemas | `src/schemas/domain.ts` | `AbsoluteVersion`, `DevEngines`, typed name literals |
| Errors | `src/errors/errors.ts` | `Schema.TaggedError` hierarchy + `ActionError` union |
| Descriptors | `src/descriptors/{node,bun,deno,biome}.ts` | Per-runtime download descriptors; Biome `binaryMap` |
| Build config | `action.config.ts` | `@savvy-web/github-action-builder` entry points, minify and ignore list |

### Architecture diagram

```text
action.yml (node24 runtime)
    |
    +-- main: dist/main.js
    |       |
    |       v
    |   src/main.ts (3 lines)
    |       |
    |       v
    |   Action.run(program, { layer: MainLive })
    |       |
    |       +-- src/program.ts       (Effect.gen pipeline)
    |       |     |
    |       |     +-- services/config-loader.ts -> schemas/domain.ts
    |       |     +-- services/cache.ts ----------> Glob (lockfiles + hashFiles)
    |       |     +-- services/runtime-installer.ts -> descriptors/{node,bun,deno}.ts
    |       |     +-- program.installBiome --------> descriptors/biome.ts
    |       |     +-- program.{setupPackageManager,installDependencies,setOutputs}
    |       |
    |       +-- src/layers/app.ts    (MainLive composition)
    |
    +-- post: dist/post.js
            |
            v
        src/post.ts
            |
            +-- services/cache.ts (saveCache)
            +-- catchAll + catchAllDefect (post never fails workflow)
```

### Layer composition

`Action.run` provides core services automatically: `ActionOutputsLive`, `ActionLoggerLive`, `ConfigProvider` (backed by `INPUT_*` env vars).

**MainLive** in `src/layers/app.ts`:

```ts
Layer.mergeAll(
  ActionCacheLive.pipe(Layer.provide(NodeHttpClient.layer)),
  ToolInstallerLive,
  CommandRunnerLive,
  ActionStateLive.pipe(Layer.provide(NodeFileSystem.layer)),
  ActionEnvironmentLive,
  GlobLive,
  NodeFileSystem.layer,
);
```

`ActionCacheLive` requires `NodeHttpClient` for the V2 Twirp protocol. `ActionStateLive` requires `NodeFileSystem` for state file persistence. `GlobLive` is provided by the library and backs both `findLockFiles` (`Glob.glob`) and the lockfile hash (`Glob.hashFiles`).

**PostLive** in `src/post.ts`:

```ts
Layer.mergeAll(
  ActionCacheLive.pipe(Layer.provide(NodeHttpClient.layer)),
  ActionStateLive.pipe(Layer.provide(NodeFileSystem.layer)),
);
```

---

## Rationale

### Effect framework for action logic

Typed error channels (`Schema.TaggedError`), service composition (`Layer.mergeAll`), and built-in config/logging map naturally to GitHub Actions concerns. `@savvy-web/github-action-effects` provides the service wrappers; the action consumes them.

### Zero `@actions/*` dependencies

`github-action-effects` ^2.0.0 implements the runtime protocol natively (V2 Twirp cache, Azure Blob Storage, native process execution via `@effect/platform`). Eliminates version conflicts, shrinks the bundle and removes the need for pnpm overrides or patches.

### devEngines-only configuration

A single declarative source of truth in `package.json` (per Corepack and pnpm). Removing the previous explicit version inputs eliminates drift between `package.json` and workflow files.

### Inputs via Effect Config API

`Config.string`, `Config.boolean` and library `ActionInput.*` combinators read inputs lazily at point of use against the `ConfigProvider` set up by `Action.run`. No upfront `ActionInputs` parsing step that could fail before the pipeline starts; each input's usage is self-documenting at its call site.

### Split entry/program/layer

`main.ts` is 3 lines. The pipeline (`program`) and the layer composition (`MainLive`) live in their own modules. This lets `program.test.ts` import the program without triggering the module-level `Action.run` side effect in `main.ts`, matching the canonical pnpm-config-dependency-action pattern.

### Descriptor pattern for runtimes

Per-runtime data (URLs, archive types, verify commands) lives in `src/descriptors/{node,bun,deno}.ts`. Shared install logic lives in `makeRuntimeInstaller`. New runtimes are pure data additions. See `runtime-installation.md`.

### Non-fatal demotion

Cache restore (`Effect.catchTag("CacheError", ...)`), Biome install (`Effect.catchAll`) and the entire post action (`Effect.catchAll` + `Effect.catchAllDefect`) demote failures to warnings. Optional operations never fail the job.

### Cross-phase state via ActionState

GitHub Actions runs main and post in separate processes. `ActionState.save(STATE_KEYS.cacheState, value, CacheState)` in main; `ActionState.getOptional(STATE_KEYS.cacheState, CacheState)` in post. `CacheState` is a `Schema.Class` so it round-trips cleanly through the runner state file. See `src/state.ts`.

---

## System architecture

### Pipeline steps (`src/program.ts`)

The main pipeline runs nine sequential steps inside a single `Effect.gen`. Each is wrapped in `Step.groupStep(title, effect)` (quiet-on-success, verbose-on-failure):

1. **Detect configuration** -- load `package.json`, decode `devEngines`, detect Biome and Turbo.
2. **Compute cache config** -- determine active package managers, merge cache paths, find lockfiles via `Glob.glob`.
3. **Restore cache** -- generate cache key, restore via V2 Twirp protocol; non-fatal.
4. **Install runtimes** -- `Effect.forEach` over runtimes with `Effect.provide(installerLayerFor(rt.name))`.
5. **Setup package manager** -- corepack (pnpm/yarn), `npm install -g` (npm), no-op (bun/deno).
6. **Install dependencies** -- lockfile-aware install command; skipped for Deno; opt-out via `install-deps=false`.
7. **Install Biome** -- direct binary download; non-fatal.
8. **Set outputs** -- versions, cache status, lockfiles, cache paths.
9. **Summary** -- final status group.

### Error hierarchy

See `src/errors/errors.ts`. All errors are `Schema.TaggedError` subclasses with computed `.message` getters. The `ActionError` union covers the fatal errors propagating through the pipeline. `CacheError` is non-fatal during restore (caught and demoted) and fatal-but-swallowed in post (caught by the post-action `catchAll`).

---

## Data flow

### Configuration flow

```text
package.json
    |
    v
loadPackageJson (FileSystem.readFileString -> JSON.parse -> Schema.decodeUnknown)
    |
    v
DevEngines { packageManager, runtime: RuntimeEntry | RuntimeEntry[] }
    |
    v
parseDevEngines (normalize runtime to always-array)
    |
    v
detectBiome (input override -> biome.jsonc -> biome.json -> $schema regex)
    |
    v
detectTurbo (FileSystem.access("turbo.json"))
    |
    v
{ runtimes, packageManager, biome: Option<string>, turbo: boolean }
```

### Cache key flow

See `caching-strategy.md` for the full formula. Summary: `{platform}-{versionHash}-{branchHash}-{lockfileHash}`, all 8-char hex truncations. Lockfile hash now comes from `Glob.hashFiles` (library-provided hash-of-hashes), not concat-and-SHA256.

### Cross-phase state

```text
Main                                  Post
  restoreCache()                        post (in post.ts)
    |                                     |
    +-- ActionState.save(                 +-- ActionState.getOptional(
    |     STATE_KEYS.cacheState,          |     STATE_KEYS.cacheState,
    |     new CacheState({                |     CacheState
    |       key, paths,                   |   ) -> Option<CacheState>
    |       restored: hit === "exact",    |
    |     }),                             +-- if None -> return
    |     CacheState,                     +-- if restored=true -> return
    |   )                                 +-- else: Step.groupStep("Cache save", saveCache())
```

`CacheState` (in `src/state.ts`) carries `{ key, paths, restored }`. `restored=true` means main got an exact hit and post should skip the save.

---

## Integration points

### GitHub Actions runtime

- **Inputs** -- `Config.string`/`Config.boolean`/`ActionInput.multiline`/`ActionInput.boolean` against the `ConfigProvider` set up by `Action.run`.
- **Outputs** -- `ActionOutputs.set(name, value)`.
- **Environment** -- `ActionEnvironment.getOptional` for `GITHUB_REF`, `GITHUB_HEAD_REF`, `RUNNER_TOOL_CACHE`.
- **Cache** -- `ActionCache.restore`/`.save` (V2 Twirp + Azure Blob).
- **State** -- `ActionState.save`/`getOptional` (file-backed between phases).
- **Logging** -- `Step.groupStep` for collapsible sections; `Step.success` for canonical success lines; `Effect.log*` for the rest.

### `@savvy-web/github-action-effects` services

| Service | Purpose | Used by |
| --- | --- | --- |
| `ActionOutputs` | Set outputs, add to PATH, export vars | program.ts, runtime-installer.ts |
| `ActionCache` | V2 Twirp restore/save | services/cache.ts |
| `ActionState` | Cross-phase persistence | services/cache.ts, post.ts |
| `ActionEnvironment` | GitHub context vars | services/cache.ts |
| `ToolInstaller` | Download, extract, cache tools | services/runtime-installer.ts, program.installBiome |
| `CommandRunner` | Process execution | services/cache.ts, program.ts, services/runtime-installer.ts |
| `Glob` | Glob expansion + hash-of-hashes | services/cache.ts (`findLockFiles`, `hashFiles`) |

### `@effect/platform` services

- `FileSystem.FileSystem` -- file read/access in `config-loader.ts` and `program.installDependencies`.

---

## Related documentation

**Internal:**

- [Effect service model](./effect-service-model.md) -- service tags, error types, Step.\* namespace, test layers.
- [Caching strategy](./caching-strategy.md) -- cache key formula, lockfile detection, Glob integration.
- [Runtime installation](./runtime-installation.md) -- `RuntimeInstaller` tag class, descriptors, PM setup.
- [Build and distribution](./build-and-distribution.md) -- builder version, ignore list, dist management.
- [Testing strategy](./testing-strategy.md) -- library Test layers, hand-rolled mock cases, fixture tests.

**Context files:**

- [Root CLAUDE.md](../../../CLAUDE.md)
- [src/CLAUDE.md](../../../src/CLAUDE.md)
