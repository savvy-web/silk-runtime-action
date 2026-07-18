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
  - ./runtime-installation.md
  - ./testing-strategy.md
  - ./turbo-remote-cache.md
dependencies: []
---

# Effect service model

How the action uses Effect for typed errors, dependency injection, composable service layers and the `Step.*` namespace for log buffering.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Rationale](#rationale)
4. [Implementation details](#implementation-details)
5. [Related documentation](#related-documentation)

---

## Overview

Every side effect (file I/O, process execution, caching, output setting, logging, globbing) flows through Effect services. The action never imports `@actions/*` packages and only reaches for `node:os`, `node:path` and `node:crypto` directly. This design enables full service substitution in tests and typed error propagation through the pipeline.

**Key features:**

- All GitHub Actions integration via `@savvy-web/github-action-effects` (v4 line; range in `package.json`) services.
- Inputs read lazily via Effect `Config` API and library `ActionInput.*` combinators.
- Errors modeled as `Schema.TaggedErrorClass` with computed `.message` getters and an `ActionError` union.
- `Step.*` namespace for log group buffering (quiet-on-success, verbose-on-failure).
- Layer composition split between entry (`main.ts`), program (`program.ts`) and layer file (`layers/app.ts`).
- Tests use library-provided test layers from `@savvy-web/github-action-effects/testing`.

**When to load this doc:**

- Adding a new service dependency to the pipeline.
- Modifying layer composition in `src/layers/app.ts` or `src/post.ts`.
- Writing tests that need to swap services or inject inputs.

---

## Current state

### Service dependencies by module

| Module | Services required |
| --- | --- |
| `services/config-loader.ts` | `FileSystem.FileSystem`, `Config` (`ConfigProvider`) |
| `services/cache.ts` | `ActionCache`, `ActionState`, `ActionEnvironment`, `CommandRunner`, `Glob` |
| `services/runtime-installer.ts` | `ToolInstaller`, `CommandRunner`, `ActionOutputs` |
| `program.ts` | All of the above + `FileSystem.FileSystem` for `installDependencies` |
| `program.installBiome` | `ToolInstaller`, `ActionOutputs`, `FileSystem.FileSystem` |
| `services/turbo-cache/apply.ts` | `ActionOutputs`, `ActionState` |
| `services/turbo-cache/handler.ts` | `BlobStore` |
| `post.ts` | `ActionCache`, `ActionState` |

`Action.run` provides `ActionOutputsLive`, `ActionLoggerLive` and the `ConfigProvider` automatically. Everything else is composed in `MainLive` (`src/layers/app.ts`) and `PostLive` (`src/post.ts`).

### Detached server runtime

`src/turbo-server.ts` runs as a standalone detached process, not under `Action.run`. It builds its own `BlobStore` layer (`GitHubBlobStoreLive` or `S3BlobStoreLive`, each provided `NodeHttpClient.layerUndici`) and drives the handler with a `ManagedRuntime` from a plain `node:http` server. Secrets reach it as plain env vars and are re-wrapped with `Redacted.make` before constructing the S3 layer. See [turbo remote cache](./turbo-remote-cache.md).

### Input access pattern

Inputs are read via Effect `Config` and library `ActionInput.*` combinators at point of use:

```ts
const installDeps = yield* ActionInput.boolean("install-deps").pipe(Config.withDefault(true));
const biomeVersion = yield* Config.string("biome-version").pipe(Config.withDefault(""));
const additionalLockfiles = yield* ActionInput.multiline("additional-lockfiles").pipe(Config.withDefault([]));
```

`ActionInput.multiline` splits on `\n` and trims. It does **not** parse comma-separated, bullet-list or JSON-array inputs -- the previous `parseMultiValueInput` helper has been deleted. Use newline-separated values.

`ActionInput.boolean` follows the YAML 1.2 Core Schema (`true`/`false`/`True`/`False`/`TRUE`/`FALSE`).

### Error types

All errors live in `src/errors/errors.ts` as `Schema.TaggedErrorClass` subclasses with `NonEmptyString` (`Schema.String.check(Schema.isMinLength(1))`) field constraints and computed `.message` getters. `ActionError` is the union covering the fatal-by-default cases. See the file for the exact field list -- documenting it here would just go stale.

| Tag | Fatal? | When thrown |
| --- | --- | --- |
| `ConfigError` | Yes | Invalid or missing `package.json` / `devEngines` |
| `RuntimeInstallError` | Yes | Runtime download or verify failure |
| `PackageManagerSetupError` | Yes | corepack / npm setup failure |
| `DependencyInstallError` | Yes | `npm ci` / `pnpm install` / etc. failure |
| `CacheError` | Conditional | Non-fatal on restore, swallowed in post |

### Step.\* namespace

Each phase of `program.ts` is wrapped in `Step.groupStep(title, effect)`:

- Buffers log output emitted inside the group.
- On success: collapses the group and emits a single summary line (`Step.success(...)` if called inside).
- On failure: expands the group and prints the buffered lines so the failure context is visible.

`Step.success("X")` is the canonical success-line API; it replaces the previous `formatSuccess` + `Effect.log` pattern. Job-summary markdown is built with `GithubMarkdown.*` (heading/table/details/list) in `src/services/summary.ts` and written via `outputs.summary` (non-fatal).

---

## Rationale

### Effect Config API instead of `ActionInputs`

The library exposes an `ActionInputs` service, but the action uses `Config` + `ActionInput.*` combinators instead. Inputs are read at point of use, defaults are co-located with the read, and tests inject values via `ConfigProvider.fromUnknown` (v4; supersedes v3's `ConfigProvider.fromMap`) without mocking a service.

### `Context.Service` class for `RuntimeInstaller`

`RuntimeInstaller` is a `Context.Service` class with an exported `RuntimeInstallerShape` companion interface (see `src/services/runtime-installer.ts`):

```ts
export interface RuntimeInstallerShape {
  readonly install: (
    version: string,
  ) => Effect.Effect<InstalledRuntime, RuntimeInstallError, ToolInstaller | CommandRunner | ActionOutputs>;
}

export class RuntimeInstaller extends Context.Service<RuntimeInstaller, RuntimeInstallerShape>()("RuntimeInstaller") {}
```

This is the Effect v4 service form. The v3 `Context.Tag`/`Context.GenericTag` + inline object shape has been replaced across the whole codebase: library services are likewise class-based `Context.Service` exporting `*Shape` interfaces (e.g. `ActionOutputsShape`). The service class gives a single import, automatic static tag identity through the type system and direct `yield* RuntimeInstaller` calls. The per-runtime swap pattern (`Effect.provide(installerLayerFor(rt.name))`) still works the same way.

### `Schema.TaggedErrorClass` instead of `Data.TaggedError`

`Schema.TaggedErrorClass` (the v4 name for v3's `Schema.TaggedError`) validates the error payload at construction, exposes the fields as schema-decoded values and round-trips cleanly through `ActionState` (file-backed persistence between main and post). Computed `.message` getters give every error a single, formatted message line for logs without the caller having to assemble one. The `ActionError` union enables exhaustive `Effect.catchTag` handling at the top of the pipeline if needed.

### Step.groupStep for log structure

GitHub Actions log groups improve readability but cause noise when every log line is interleaved. `Step.groupStep` solves this by buffering: the group reads quiet on success and verbose on failure. This matches what humans actually want -- the inside of a successful step is uninteresting; the inside of a failing step is everything.

---

## Implementation details

### Layer composition

What `Action.run` provides automatically:

- `ActionOutputsLive` -- outputs, `addPath`, `exportVariable`.
- `ActionLoggerLive` -- log groups underlying `Step.groupStep`.
- `ConfigProvider` -- backed by `INPUT_*` env vars.

What `MainLive` adds in `src/layers/app.ts`:

```ts
Layer.mergeAll(
  ActionCacheLive.pipe(Layer.provide(NodeHttpClient.layerUndici)),
  ToolInstallerLive,
  CommandRunnerLive,
  ActionStateLive.pipe(Layer.provide(NodeFileSystem.layer)),
  ActionEnvironmentLive,
  GlobLive,
  NodeFileSystem.layer,
);
```

`ActionCacheLive` needs `NodeHttpClient` for the V2 Twirp protocol; in v4 the Node HTTP layer is `NodeHttpClient.layerUndici` (from `@effect/platform-node`), replacing v3's `NodeHttpClient.layer`. `ActionStateLive` needs `NodeFileSystem` for state-file persistence (`NodeFileSystem.layer` is unchanged in v4). `NodeFileSystem.layer` is also exposed at the top level so program code (`loadPackageJson`, `detectBiome`, `installDependencies`) can use `FileSystem.FileSystem` — imported from core `effect` in v4, since `@effect/platform` was dissolved into the core package — directly.

What `PostLive` (in `src/post.ts`) adds:

```ts
Layer.mergeAll(
  ActionCacheLive.pipe(Layer.provide(NodeHttpClient.layerUndici)),
  ActionStateLive.pipe(Layer.provide(NodeFileSystem.layer)),
);
```

### Error handling patterns

Fatal errors propagate through the Effect error channel to `Action.run`, which calls `setFailed`. See `program.ts` for the call sites; the propagation is implicit through `yield*`.

Non-fatal demotion uses `Effect.catchTag` or `Effect.catch`. In v4 `catchAll` is renamed to `catch` (and `catchAllDefect` to `catchDefect`); `catchTag` is unchanged:

- Cache restore: `Effect.catchTag("CacheError", e => Effect.logWarning(...) + return "none")`.
- Biome install: `Effect.catch(e => Effect.logWarning(...))`.
- Post action: top-level `Effect.catch` (typed errors) + `Effect.catchDefect` (programming defects). Post never fails the workflow.

### `extractErrorReason` helper

`services/runtime-installer.ts` exports `extractErrorReason(error)` -- a defensive accessor that pulls a human-readable message from any error shape (`.reason`, `.message`, `._tag`, `String(error)`). Used in `Effect.mapError` paths where the error type is not statically known.

### Logging

- `Effect.log` -- info-level, visible in normal logs.
- `Effect.logWarning` / `Effect.logError` -- annotated in the GitHub Actions UI.
- `Effect.logDebug` -- visible only with `ACTIONS_STEP_DEBUG=true`.
- `Step.groupStep(title, effect)` -- buffered group; quiet on success, verbose on failure.
- `Step.success(line)` -- canonical success line emitted inside a group.

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) -- topology and layer composition overview.
- [Runtime installation](./runtime-installation.md) -- the one place a `Context.Service` class is defined locally.
- [Turbo remote cache](./turbo-remote-cache.md) -- `BlobStore` service, `ManagedRuntime` detached entry, `Redacted` secrets.
- [Testing strategy](./testing-strategy.md) -- library Test layers, `ConfigProvider.fromUnknown`, hand-rolled mock cases.

**Context files:**

- [src/CLAUDE.md](../../../src/CLAUDE.md)
