---
type: Module
title: silk-runtime-action
description: The compiled Node action itself — entries, layers, step order, error taxonomy.
status: draft
kind: action
resource: ../../src
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: cecd892a1a345d90ee77d0bcac051b0db08bcd7f4794194bd456e01609dad2e7
sources:
  - id: main
    resource: ../../src/main.ts
  - id: post
    resource: ../../src/post.ts
  - id: program
    resource: ../../src/program.ts
  - id: layers-app
    resource: ../../src/layers/app.ts
  - id: vitest-setup
    resource: ../../vitest.setup.ts
  - id: state
    resource: ../../src/state.ts
  - id: schema-inputs
    resource: ../../src/schema/inputs.ts
  - id: schema-outputs
    resource: ../../src/schema/outputs.ts
  - id: install-runtimes
    resource: ../../src/steps/install-runtimes.ts
---

# silk-runtime-action

The action itself: three entry bundles, a sequential `main` pipeline over Effect v4
services, and a `post` phase that tears down what `main` left behind.

## Entry points

| Entry | Source | Output | Purpose |
| --- | --- | --- | --- |
| `main` | `src/main.ts` | `dist/main.js` | `Action.run(program, { layer: MainLive })`[^main] |
| `post` | `src/post.ts` | `dist/post.js` | Reap the turbo server, then save the dependency cache, the package-manager store cache, and the kcov cache; never fails the workflow[^post] |
| `turbo-server` | `src/turbo-server.ts` | `dist/turbo-server.js` | Detached embedded turbo remote-cache server, spawned by `main` and imported by nothing — see [turbo-cache-server](./turbo-cache-server.md) |

`turbo-server.js` is not a lifecycle hook — `action.yml` names only `main` and `post`.

**Both entries guard `Action.run` behind `process.env.GITHUB_ACTIONS`** — one idiom on
every entry, not one for `main` and another for `post` — so importing either module never
executes the action.[^main][^post] `post.ts` additionally exports `post` (the value the
entry runs) and `makePost(ops)`, the same effect over an injectable
`DetachedProcessOps` seam.[^post]

The guard is only honest while the *test* process does not itself look like a runner.
`vitest.setup.ts`'s `setup()` deletes `process.env.GITHUB_ACTIONS` and strips every
`INPUT_*` and `STATE_*` variable, run as `globalSetup` in the main vitest process before the
fork pool is created, so the stripped environment is what every worker
inherits.[^vitest-setup] `__test__/unit/environment.test.ts` asserts this from inside a
worker, because a setup file that quietly stopped being wired up is otherwise invisible.

## Source module map

| Module | Path | Responsibility |
| --- | --- | --- |
| Entry | `src/main.ts` | `Action.run(program, { layer: MainLive })` |
| Program | `src/program.ts` | Step composition, the two PATH joins, the outputs fold |
| Post | `src/post.ts` | `makePost` / `post`: reap the server, save three independent caches, double catch |
| Turbo server | `src/turbo-server.ts` | Detached server entry — HTTP plumbing only |
| Layers | `src/layers/app.ts` | `MainLive` and `PostLive` |
| State | `src/state.ts` | `STATE_KEYS`, `CacheState`, `StoreCacheState`, `TurboServerState`, `KcovCacheState`, `isExactHit`[^state] |
| Schemas | `src/schema/{domain,inputs,outputs}.ts` | `devEngines` domain, 19 inputs, 22 outputs[^schema-inputs][^schema-outputs] |
| Steps | `src/steps/*.ts` | One contract module per pipeline step, plus `cache-config.ts` (pure) |
| Turbo cache | `src/turbo-cache/{activation,meta,handler,server-config}.ts` | Everything the embedded cache decides — see [turbo-cache-server](./turbo-cache-server.md) |
| Formatters | `src/summary/format.ts` | Pure, verbatim log lines and the job-summary panel |
| Descriptors | `src/descriptors/{descriptor,node,bun,deno,biome,bats,kcov}.ts` | Pure per-tool download plans |
| Build config | `action.config.ts` | Three entries (incl. `workers`), minify, `ignore` list |

There is no `services/` directory and no `errors/errors.ts`: services come from the kit,
and each step owns its own error type.

## Architecture diagram

```text
action.yml (node24 runtime)
    |
    +-- main: dist/main.js
    |       |
    |       v
    |   src/main.ts -> Action.run(program, { layer: MainLive })
    |       |
    |       +-- src/program.ts   (Effect.gen, one ActionLogger.group per step)
    |       |     |
    |       |     +-- schema/inputs.ts ---------> ActionInput / Config
    |       |     +-- steps/load-config.ts -----> schema/domain.ts
    |       |     +-- steps/detect-biome.ts ----> Jsonc
    |       |     +-- steps/detect-turbo.ts
    |       |     +-- steps/detect-bats.ts -----> FileSystem (bounded walk + manifest probe)
    |       |     +-- steps/restore-cache.ts ---> steps/cache-config.ts, CacheKey, ActionCache
    |       |     +-- steps/install-runtimes.ts -> descriptors/{node,bun,deno}.ts, ToolInstaller
    |       |     +-- steps/setup-package-manager.ts -> PackageManagerPin, PackageManagerInstaller
    |       |     +-- steps/install-dependencies.ts -> ChildProcessSpawner (PATH prepends)
    |       |     +-- steps/install-biome.ts ---> descriptors/biome.ts, ToolInstaller.provisionFile
    |       |     +-- steps/install-bats.ts ----> descriptors/bats.ts, ToolInstaller, FileSystem
    |       |     +-- steps/install-kcov.ts ----> descriptors/kcov.ts, ActionCache, Run (build)
    |       |     +-- steps/turbo-cache.ts -----> turbo-cache/*, DetachedProcess (spawn)
    |       |     +-- schema/outputs.ts --------> ActionOutputs.set x22
    |       |     +-- steps/summary.ts ---------> summary/format.ts, ActionOutputs.summary
    |       |
    |       +-- src/layers/app.ts   (MainLive)
    |
    +-- turbo-server: dist/turbo-server.js (detached child, spawned by main)
    |
    +-- post: dist/post.js
            |
            v
        src/post.ts
            +-- DetachedProcess.reap(pid from TurboServerState)      [first, unconditional]
            +-- saveDependencyCache(CacheState)  unless exact hit    [workspace cache]
            +-- saveStoreCache(StoreCacheState)  unless exact hit    [package-manager store]
            +-- saveKcovCache(KcovCacheState)    unless exact hit    [kcov, independent]
            +-- Effect.catch + Effect.catchDefect (post never fails the workflow)
```

## Layer composition

`Action.run` composes `ActionRuntime.layer`, which already provides `ActionEnvironment`,
`ActionLogger`, `ActionOutputs`, `ActionState`, `HttpClient` and `NodeServices`
(`ChildProcessSpawner`, `Crypto`, `FileSystem`, `Path`, `Stdio`, `Terminal`). Nothing in
`layers/app.ts` rebuilds any of those; it adds only what the kit deliberately keeps out of
the default runtime, because those modules pull in a blob-storage client.[^layers-app]

```ts
// src/layers/app.ts:43-53
export const MainLive = Layer.mergeAll(
  ActionCache.layer,
  PackageManagerInstaller.layer,
  WorkspaceDiscovery.layer().pipe(Layer.provide(WorkspaceRoot.layer)),
).pipe(Layer.provideMerge(ToolInstaller.layer));

export const PostLive = ActionCache.layer;
```

`ToolInstaller` is `provideMerge`d rather than merged: one instance satisfies
`PackageManagerInstaller`'s requirement *and* stays visible to `installRuntimes`, which
uses it directly. `WorkspaceDiscovery` builds over `WorkspaceRoot`, `provide`d rather than
merged because nothing else in the action resolves a workspace root — it is what tells
`restoreCache` which directories the workspace actually has.[^layers-app] See
[seams-as-defaulted-parameters](../decisions/seams-as-defaulted-parameters.md) and
[descriptors-are-pure-data](../decisions/descriptors-are-pure-data.md) for why no local
service wraps any of this.

## Pipeline steps (`src/program.ts`)

Sequential, inside one `Effect.gen`, each wrapped in `ActionLogger.group`:

| Group title | Step | Line | Fatal? |
| --- | --- | --- | --- |
| — | Read `ActionEnvironment.github` (fail fast), then `loadInputs` | 181-182 | Yes |
| `Load configuration` | `loadConfig` | 196 | Yes |
| `Detect Biome` | `detectBiome(inputs.biomeVersion)` | 200 | No (always resolves) |
| `Detect Turbo` | `detectTurbo` | 201 | No (always resolves) |
| `Detect BATS` | `detectBats({ bats, kcov })` | 202 | No (always resolves) |
| `Detected configuration` | `formatDetectLine(...)` — the one-line headline | 208 | No |
| `Restore dependency cache` | `restoreCache({ inputs, config, biomeVersion, turbo })` | 220 | No (absorbs) |
| `Install runtimes` | `installRuntimes(config)` | 222 | Yes |
| `Install <pm>` | `setupPackageManager(config.packageManager)` | 226 | Yes |
| `Install dependencies` | `installDependencies(activated, installDeps, prepends, { ignoreScripts })` | 240 | Yes |
| `Install Biome` | `installBiome(biomeVersion)`, caught at the call site | 252 | No |
| `Install BATS` | `installBats(decision.installBats)`, caught at the call site | 266 | No |
| `Install kcov` | `installKcov(decision.installKcov && bats landed, { bust })`, caught at the call site | 276 | No |
| `Start turbo remote cache` | `startTurboCache({ inputs, turbo })` | 287 | No (self-catching) |
| — | `emitOutputs(outputs)` | 322 | Yes |
| `Runtime Setup Complete` | `writeSummary(facts)` | 326 | No (self-catching) |

Three orderings are load-bearing — see
[pipeline-step-ordering](../decisions/pipeline-step-ordering.md) for the full account:
detection precedes the restore (both the resolved Biome version and turbo's presence feed
the cache key and archived path set, `src/program.ts:197-199`); kcov is gated on bats
having actually *landed*
(`installKcov(batsDecision.installKcov && Option.isSome(bats))`, `src/program.ts:278`), not
merely on the decision that asked for it; and the turbo cache starts last, so the window
in which a detached child holds the runner's short-lived `ACTIONS_RUNTIME_TOKEN` is as
short as possible (`src/program.ts:284-287`).

Before step 1 the program sets four variables **on this process only**
(`NPM_CONFIG_UPDATE_NOTIFIER`, `NPM_CONFIG_FUND`, `HUSKY`,
`COREPACK_ENABLE_DOWNLOAD_PROMPT`) to quiet tool chatter its own installs provoke; they are
never `exportVariable`d, so none of it leaks into the consumer's later steps
(`src/program.ts:184-194`).

## The two PATH joins

`program.ts` holds two small pure functions that exist because they are the only place two
step results are in scope at once — see
[path-publication-rules](../conventions/path-publication-rules.md) for the full PATH story:

- `onInstallPath(pm, runtimes)` (`src/program.ts:70-77`) — when the package manager *is*
  one of the installed runtimes (bun, deno), the PM step reports no `binDir` because the
  runtime install owns that binary; this fills it in from the matching
  `InstalledRuntime.path`.
- `installPathPrepends(pm, runtimes)` (`src/program.ts:110-118`) — the ordered,
  de-duplicated directory list the dependency install's child process searches: the
  manager's bin directory first, then every installed runtime.

Both exist because `ActionOutputs.addPath` appends to `GITHUB_PATH` and takes effect only
in *later workflow steps* — it never mutates this process's `PATH`.

## Error model

There is no central `ActionError` union and no `errors/` module. Each step exports its own
`Data.TaggedError` subclass with a `reason` literal union, a stored `message` field and an
optional `cause`:

| Error | Step | Reasons |
| --- | --- | --- |
| `ConfigError` | `src/schema/domain.ts:101` | `missing-package-json`, `malformed-json`, `invalid-dev-engines` |
| `BiomeDetectError` | `src/steps/detect-biome.ts:8` | `read`, `parse` (declared, never raised) |
| `TurboDetectError` | `src/steps/detect-turbo.ts:6` | `read` (declared, never raised) |
| `BatsDetectError` | `src/steps/detect-bats.ts:26` | `read` (declared, never raised) |
| `CacheError` | `src/steps/restore-cache.ts:59` (also used by `post`) | `key`, `restore`, `state`, `save` |
| `RuntimeInstallError` | `src/steps/install-runtimes.ts:21` | `download`, `extract`, `cache`, `unsupported-platform`, `verify` |
| `PackageManagerError` | `src/steps/setup-package-manager.ts:13` | `install`, `activate`, `verify` |
| `InstallError` | `src/steps/install-dependencies.ts:25` | `spawn`, `exit-code` |
| `BiomeInstallError` | `src/steps/install-biome.ts:21` | `detect`, `download`, `cache` |
| `BatsInstallError` | `src/steps/install-bats.ts:26` | `download`, `extract`, `install`, `publish` |
| `KcovInstallError` | `src/steps/install-kcov.ts:29` | `detect`, `download`, `build`, `verify`, `publish` |
| `TurboCacheError` | `src/steps/turbo-cache.ts:36` | `spawn`, `readiness` |
| `SummaryError` | `src/steps/summary.ts:31` | `write` |

See [per-step-error-taxonomy](../decisions/per-step-error-taxonomy.md) for why each step
owns its own taxonomy rather than a shared union, why `message` is a stored field rather
than a getter, and why several reasons above are declared without a producer today.

`main` deliberately has no `catchDefect` — a defect is a bug in this action, and failing
the job is the correct response.[^post] `post` and `startTurboCache` both keep one as
defence in depth.

## Service dependencies by module

| Module | `R` |
| --- | --- |
| `schema/inputs.ts` | `ActionInput`'s provider (via `Config`) |
| `schema/outputs.ts` | `ActionOutputs` |
| `steps/load-config.ts` | `FileSystem`, `Path` |
| `steps/detect-biome.ts` | `FileSystem` |
| `steps/detect-turbo.ts` | `FileSystem` |
| `steps/cache-config.ts` | — (pure; no services, no IO) |
| `steps/restore-cache.ts` | `ActionCache`, `ActionState`, `ActionEnvironment`, `FileSystem`, `Path` |
| `steps/install-runtimes.ts` | `ToolInstaller`, `ActionOutputs`, `ActionLogger`, `Path`, `ChildProcessSpawner` |
| `steps/setup-package-manager.ts` | `PackageManagerInstaller`, `ActionOutputs`, `ActionLogger` |
| `steps/install-dependencies.ts` | `ChildProcessSpawner`, `FileSystem`, `ActionLogger` |
| `steps/install-biome.ts` | `ToolInstaller`, `ActionOutputs`, `FileSystem`, `ActionLogger` |
| `steps/turbo-cache.ts` | `ActionState`, `ActionOutputs`, `HttpClient` |
| `steps/summary.ts` | `ActionOutputs`, `ActionLogger` |
| `summary/format.ts` | — (pure) |
| `turbo-cache/activation.ts`, `meta.ts` | — (pure) |
| `turbo-cache/handler.ts` | `BlobStore` |
| `post.ts` | `ActionCache`, `ActionState`, `FileSystem` |

`ActionRuntime.layer` provides `ActionEnvironment`, `ActionLogger`, `ActionOutputs`,
`ActionState`, `HttpClient` and `NodeServices`. `MainLive` adds `ActionCache`,
`PackageManagerInstaller`, `ToolInstaller` and `WorkspaceDiscovery`; `PostLive` adds
`ActionCache` alone.

A frozen contract is sometimes wider than the implementation needs — `loadConfig` declares
`Path` and never resolves one; `installBiome` declares `FileSystem` and `ActionLogger` that
`ToolInstaller.provisionFile` made unnecessary. Those stay: narrowing `R` is a contract
change, and the cost of an unused requirement is a line in a test's layer. See
[step-contract](../conventions/step-contract.md) for the full four-part rule every
`steps/` module follows.

## Failure posture per step

| Step | Posture |
| --- | --- |
| `loadConfig` | Fatal |
| `detectBiome`, `detectTurbo` | Every failure resolves to "absent" / `false` |
| `restoreCache` | Every failure absorbed; answers with a miss-shaped `CacheState` |
| `installRuntimes` | Fatal, sequential, first failure stops the rest |
| `setupPackageManager` | Fatal |
| `installDependencies` | Fatal, no timeout, no retry |
| `installBiome` | Fails typed; `program.ts` catches at the call site and folds `Option.none()` |
| `startTurboCache` | Self-catching: `Effect.catch` + `Effect.catchDefect` → `DISABLED` |
| `writeSummary` | Self-catching: the write degrades to a warning |
| `post` | Three independent inner catches (workspace, store, kcov), plus reap's own catch, plus an outer `catch` + `catchDefect` |

See [optional-work-never-fails-the-job](../decisions/optional-work-never-fails-the-job.md)
for the rationale, sharpened for BATS and kcov because both are auto-detected — a
repository that never opted in by name can still end up installing them from one stray
`.bats` fixture, so it must not be able to lose a build to an unusual runner image's kcov
compile or a helper-library tarball 404.

## Log structure

`ActionLogger.group(title, effect)` wraps each step. Inside the two noisiest steps the
transcript is additionally held by `logger.withBuffer(name, effect, { onSuccess:
"discard" })`, so a green run is one line per runtime and one line per manager, while a
failure spills the whole transcript. Warnings are never buffered, so an integrity notice
reaches the log even on a green run. `Effect.logDebug` output appears only under
`ACTIONS_STEP_DEBUG=true`; the cache key, the restore ladder, the resolved path set and the
lockfile list are all logged at debug level. See
[log-levels-and-buffering](../conventions/log-levels-and-buffering.md).

## Input access pattern

All 19 inputs are decoded once, at the top of the pipeline, through `Config.all` composing
`ActionInput.*` combinators (`src/schema/inputs.ts`).[^schema-inputs] Three conventions are
load-bearing:

- **`ActionInput` owns the naming.** The runner uppercases an input name and *preserves
  hyphens* (`INPUT_BIOME-VERSION`); only spaces become underscores. A hand-written
  `INPUT_BIOME_VERSION` reads as absent and the action silently falls back to a default.
  Because the kit's provider is dual-accept, code and tests key by input name and spell no
  variable at all.
- **Empty is absent.** `ActionInput` treats an unsupplied input and an empty string as the
  same case.
- **Secrets are `Redacted`.** `turbo-token`, `turbo-s3-secret-access-key` and
  `turbo-s3-session-token` are read with `ActionInput.redacted` and only declassified
  through `Secret.*`.

Two normalizations happen in the `Config.map` rather than at a use site: `turbo-cache`
collapses to `"auto" | "off"`, and `cache-bust` filters out the `"false"` and empty
sentinels so downstream code sees a plain `Option`.

## Effect v4 API notes

- `catchAll` → `Effect.catch`; `catchAllDefect` → `Effect.catchDefect`; `catchTag` is
  unchanged.
- `Schema.Literals([...])` for literal unions; `Schema.NonEmptyArray`,
  `Schema.optionalKey`, `Schema.OptionFromNullOr`.
- `Result` (not `Either`) is what descriptors and `readServerConfig` return.
- `ChildProcessSpawner` and `ChildProcess` live in `effect/unstable/process`.
- Platform abstractions (`FileSystem`, `Path`, `Stream`, `HttpClient`) import from core
  `effect`; only `NodeFileSystem` / `NodeHttpClient` come from `@effect/platform-node`.
- Services are class-based `Context.Service` with exported `*Shape` companion types — but
  this action defines none of its own; the one local service the legacy implementation had
  (`RuntimeInstaller`) was dissolved into a descriptor table plus a plain step function. See
  [descriptors-are-pure-data](../decisions/descriptors-are-pure-data.md).

## Related concepts

- [embedded-turbo-server](../decisions/embedded-turbo-server.md)
- [seams-as-defaulted-parameters](../decisions/seams-as-defaulted-parameters.md)
- [per-step-error-taxonomy](../decisions/per-step-error-taxonomy.md)
- [pipeline-step-ordering](../decisions/pipeline-step-ordering.md)
- [inputs-decoded-once-outputs-folded-once](../decisions/inputs-decoded-once-outputs-folded-once.md)
- [step-contract](../conventions/step-contract.md)
- [plain-json-cross-phase-state](../conventions/plain-json-cross-phase-state.md)
- [path-publication-rules](../conventions/path-publication-rules.md)
- [log-levels-and-buffering](../conventions/log-levels-and-buffering.md)
- [cross-phase-state](../models/cross-phase-state.md)

[^main]: ../../src/main.ts
[^post]: ../../src/post.ts
[^vitest-setup]: ../../vitest.setup.ts
[^state]: ../../src/state.ts
[^schema-inputs]: ../../src/schema/inputs.ts
[^schema-outputs]: ../../src/schema/outputs.ts
[^layers-app]: ../../src/layers/app.ts
