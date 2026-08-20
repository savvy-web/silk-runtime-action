---
status: current
module: silk-runtime-action
category: architecture
created: 2026-03-21
updated: 2026-08-20
last-synced: 2026-08-20
completeness: 95
related:
  - ./effect-service-model.md
  - ./caching-strategy.md
  - ./runtime-installation.md
  - ./build-and-distribution.md
  - ./turbo-remote-cache.md
  - ./testing-strategy.md
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

The action is a compiled Node.js GitHub Action (`node24` runtime) that reads runtime and package manager configuration exclusively from the `devEngines` field in `package.json`. It supports Node.js, Bun and Deno with automatic dependency caching, optional Biome CLI installation, an optional BATS shell-testing toolchain with kcov coverage, Turborepo detection and an embedded Turborepo remote cache (see [turbo remote cache](./turbo-remote-cache.md)).

Built on Effect v4 (`effect@4.0.0-rc.109` via `catalog:effect`) over the `@effected/*` suite — `@effected/github-actions` for every GitHub Actions runtime interaction, plus `@effected/npm`, `@effected/semver` and `@effected/jsonc`. The kit implements the runner protocol natively, so the action has zero `@actions/*` direct or transitive dependencies. In Effect v4 the former `@effect/platform` is dissolved into core `effect` (`FileSystem`, `Path`, `HttpClient` all import from `effect`); only Node platform layers ship separately in `@effect/platform-node`.

**Design principles:**

- `package.json` `devEngines` is the only source of truth for runtime and PM versions. Absolute versions only.
- Every side effect flows through a kit service, for typed errors, injection and testability.
- One module per pipeline step, each with a frozen four-part contract (result type, tagged error, explicit `R`, no inferred requirements). See [effect service model](./effect-service-model.md).
- Optional work — cache restore, Biome install, the BATS toolchain, kcov, turbo cache, the job summary, the whole post phase — degrades to a warning rather than failing the workflow.
- `main.ts` is a one-call entry. The pipeline lives in `program.ts` and layer composition in `layers/app.ts`, so tests can import `program` without triggering `Action.run`.

**When to load this doc:**

- Understanding entry topology and layer composition.
- Following data flow from `package.json` to cache key to outputs.
- Adding a runtime, a step, or an input/output pair.

---

## Current state

### Entry points

| Entry | Source | Output | Purpose |
| --- | --- | --- | --- |
| `main` | `src/main.ts` | `dist/main.js` | One call: `Action.run(program, { layer: MainLive })` |
| `post` | `src/post.ts` | `dist/post.js` | Reap the turbo server, then save the dependency cache, then save the kcov cache; never fails the workflow |
| `turbo-server` | `src/turbo-server.ts` | `dist/turbo-server.js` | Detached embedded turbo remote-cache server (a `workers` bundle) |

`turbo-server.js` is **not** a lifecycle hook — `action.yml` names only `main` and `post`. Main spawns it as a detached child. See [turbo remote cache](./turbo-remote-cache.md).

`post.ts` guards its own `Action.run` behind `process.env.GITHUB_ACTIONS`, so importing the module in a test does not start the post phase. It exports `post` (the value the entry runs) and `makePost(reap)`, which is the same effect over an injectable teardown seam.

### Source module map

| Module | Path | Responsibility |
| --- | --- | --- |
| Entry | `src/main.ts` | `Action.run(program, { layer: MainLive })` |
| Program | `src/program.ts` | Step composition, the two PATH joins, the outputs fold |
| Post | `src/post.ts` | `makePost` / `post`: reap the server, then save the two caches; three independent branches, double catch |
| Turbo server | `src/turbo-server.ts` | Detached server entry — HTTP plumbing only |
| Layers | `src/layers/app.ts` | `MainLive` and `PostLive` |
| State | `src/state.ts` | `STATE_KEYS`, `CacheState`, `TurboServerState`, `KcovCacheState`, `isExactHit` |
| Schemas | `src/schema/{domain,inputs,outputs}.ts` | `devEngines` domain, the 18 inputs, the 22 outputs |
| Steps | `src/steps/*.ts` | One contract module per pipeline step, plus `cache-config.ts` (pure) |
| Turbo cache | `src/turbo-cache/{activation,meta,handler,server-config}.ts` | Everything the embedded cache decides |
| Formatters | `src/summary/format.ts` | Pure, verbatim log lines and the job-summary panel |
| Descriptors | `src/descriptors/{descriptor,node,bun,deno,biome,bats,kcov}.ts` | Pure per-tool download plans (and, for kcov, its build recipe and cache key) |
| Build config | `action.config.ts` | Three entries (incl. `workers`), minify, `ignore` list |

There is no `services/` directory and no `errors/errors.ts`: services come from the kit, and each step owns its own error type.

### Architecture diagram

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
    |       |
    |       v
    |   turbo-cache/server-config.ts -> BlobStore (github | s3)
    |   turbo-cache/handler.ts        -> /v8/artifacts over BlobEnvelope
    |
    +-- post: dist/post.js
            |
            v
        src/post.ts
            +-- DetachedProcess.reap(pid from TurboServerState)   [first, unconditional]
            +-- ActionCache.save(paths, primaryKey) unless exact hit          [dependency cache]
            +-- ActionCache.save(prefix, primaryKey) from KcovCacheState      [kcov, independent]
            +-- Effect.catch + Effect.catchDefect (post never fails the workflow)
```

### Layer composition

`Action.run` composes `ActionRuntime.layer`, which already provides `ActionEnvironment`, `ActionLogger`, `ActionOutputs`, `ActionState`, `HttpClient` and `NodeServices` (`ChildProcessSpawner`, `Crypto`, `FileSystem`, `Path`, `Stdio`, `Terminal`). Nothing in `layers/app.ts` rebuilds any of those; it adds only what the kit deliberately keeps out of the default runtime, because those modules pull in a blob-storage client.

```ts
// src/layers/app.ts
export const MainLive = Layer.mergeAll(ActionCache.layer, PackageManagerInstaller.layer).pipe(
  Layer.provideMerge(ToolInstaller.layer),
);

export const PostLive = ActionCache.layer;
```

`ToolInstaller` is `provideMerge`d rather than merged: one instance satisfies `PackageManagerInstaller`'s requirement *and* stays visible to `installRuntimes` and `installBiome`, which use it directly. `ActionRunOptions.layer` is `Layer<R, never, ActionServices>`, which is what lets both layers *require* the runtime's services instead of constructing their own.

### Pipeline steps (`src/program.ts`)

Sequential, inside one `Effect.gen`, each wrapped in `ActionLogger.group`:

| # | Group title | Step | Fatal? |
| --- | --- | --- | --- |
| 0 | — | Read `ActionEnvironment.github` (fail fast), then `loadInputs` | Yes |
| 1 | `Load configuration` | `loadConfig` | Yes |
| 2 | `Detect Biome` | `detectBiome(inputs.biomeVersion)` | No (always resolves) |
| 3 | `Detect Turbo` | `detectTurbo` | No (always resolves) |
| 4 | `Detect BATS` | `detectBats({ bats, kcov })` | No (always resolves) |
| 5 | `Detected configuration` | `formatDetectLine(…)` — the one-line headline | No |
| 6 | `Restore dependency cache` | `restoreCache({ inputs, config, biomeVersion, turbo })` | No (absorbs) |
| 7 | `Install runtimes` | `installRuntimes(config)` | Yes |
| 8 | `Install <pm>` | `setupPackageManager(config.packageManager)` | Yes |
| 9 | `Install dependencies` | `installDependencies(activated, installDeps, prepends)` | Yes |
| 10 | `Install Biome` | `installBiome(biomeVersion)`, caught at the call site | No |
| 11 | `Install BATS` | `installBats(decision.installBats)`, caught at the call site | No |
| 12 | `Install kcov` | `installKcov(decision.installKcov && bats landed, { bust })`, caught at the call site | No |
| 13 | `Start turbo remote cache` | `startTurboCache({ inputs, turbo })` | No (self-catching) |
| 14 | — | `emitOutputs(outputs)` | Yes |
| 15 | `Runtime Setup Complete` | `writeSummary(facts)` — panel first, closing group after | No (self-catching) |

Three orderings are load-bearing and were ruled deliberately:

- **Detection precedes the restore**, because the resolved Biome version and turbo's presence both feed the cache key and the archived path set. This is the legacy ordering (`legacy-v1/program.ts:382-411`). `detectBats` joins that block rather than sitting beside its install even though it feeds *neither* the key nor the path set — the detect line is assembled from all four detections at once, and splitting the group off would move a fact out from under the headline that reports it.
- **kcov is gated on bats having actually landed**, not on the decision that asked for it: `installKcov(decision.installKcov && Option.isSome(bats))`. A coverage tool for a toolchain that failed to install has nothing to cover, and paying a multi-minute source build for it would be the worst possible response to an install that already went wrong.
- **The turbo cache starts last** — a deliberate deviation from v1, which started it before the restore. Nothing in the pipeline consumes the turbo environment, and a later start shortens the window in which a detached child holds the runner's short-lived `ACTIONS_RUNTIME_TOKEN`. Ruled neutral-to-better; do not "fix" it back.

Before step 1 the program sets four variables **on this process only** — `NPM_CONFIG_UPDATE_NOTIFIER`, `NPM_CONFIG_FUND`, `HUSKY`, `COREPACK_ENABLE_DOWNLOAD_PROMPT` — to quiet tool chatter its own installs provoke. They are never `exportVariable`d, so none of it leaks into the consumer's later steps.

### The two PATH joins

`program.ts` holds two small pure functions that exist because they are the only place two step results are in scope at once. Both are consequences of the single most important runner fact in this codebase: **`ActionOutputs.addPath` appends to `GITHUB_PATH` and takes effect only in *later workflow steps*. It never mutates this process's `PATH`.**

- `onInstallPath(pm, runtimes)` — when the package manager *is* one of the installed runtimes (bun, deno), the PM step reports no `binDir` because the runtime install owns that binary. This fills it in from the matching `InstalledRuntime.path`. A manager that already knows where it is keeps its answer.
- `installPathPrepends(pm, runtimes)` — the ordered, de-duplicated directory list the dependency install's child process searches: the manager's bin directory first, then every installed runtime. The runtimes are not optional garnish; a `postinstall` script running `deno install` inherits the install child's `PATH`, and omitting them produced `deno: not found` on every runner in a multi-runtime workspace.

See [runtime installation](./runtime-installation.md) for the full PATH story, including the closed npm-ambient shadowing case.

### Error model

There is **no central `ActionError` union and no `errors/` module**. Each step exports its own `Data.TaggedError` subclass with a `reason` literal union, a **stored** `message` field and an optional `cause`:

| Error | Step | Reasons |
| --- | --- | --- |
| `ConfigError` | `schema/domain.ts`, raised by `load-config` | `missing-package-json`, `malformed-json`, `invalid-dev-engines` |
| `BiomeDetectError` | `detect-biome` | `read`, `parse` (declared, never raised) |
| `TurboDetectError` | `detect-turbo` | `read` (declared, never raised) |
| `BatsDetectError` | `detect-bats` | `read` (declared, never raised) |
| `CacheError` | `restore-cache` (also used by `post`) | `key`, `restore`, `state`, `save` |
| `RuntimeInstallError` | `install-runtimes` | `download`, `extract`, `cache`, `unsupported-platform`, `verify` |
| `PackageManagerError` | `setup-package-manager` | `install`, `activate`, `verify` |
| `InstallError` | `install-dependencies` | `spawn`, `exit-code` |
| `BiomeInstallError` | `install-biome` | `detect`, `download`, `cache` |
| `BatsInstallError` | `install-bats` | `download`, `extract`, `install`, `publish` |
| `KcovInstallError` | `install-kcov` | `detect`, `download`, `build`, `verify`, `publish` |
| `TurboCacheError` | `turbo-cache` | `spawn`, `readiness` |
| `SummaryError` | `summary` | `write` |

Several of these are declared on a signature and never raised. That is deliberate: the error type is the shape a failure is *logged as*, and keeping it on the contract leaves room for a genuinely unexpected case without making today's tolerance a lie.

Two of the newer unions carry a distinction the older ones do not need. `BatsInstallError.install` is this step's own — copying an extracted library into `$HOME/.local/share`, or synthesizing bats-mock's `load.bash` — and has no counterpart in the provisioner's reasons. `KcovInstallError` splits `build` from `verify` because "did not compile" and "compiled and then would not run" are different problems with different remedies, and the warning a consumer reads should say which one happened.

`main` deliberately has **no** `catchDefect` — a defect is a bug in this action, and failing the job is the correct response. `post` and `startTurboCache` both keep one as defence in depth.

---

## Rationale

### Effect v4 over the `@effected/*` suite

Typed error channels, service composition and the kit's runner-protocol implementation map directly onto GitHub Actions concerns. The suite is first-party, so a missing API is fixed upstream and dogfooded rather than worked around here (see [build and distribution](./build-and-distribution.md)).

### Zero `@actions/*` dependencies

`@effected/github-actions` implements the cache protocol, blob storage, tool installation and process handling natively over core `effect` platform APIs. That eliminates version conflicts, shrinks the bundle and removes any need for pnpm overrides or patches.

### devEngines-only configuration

One declarative source of truth in `package.json` (per Corepack and pnpm). There are no runtime or package-manager version inputs, so `package.json` and workflow files cannot drift apart. A top-level corepack `packageManager` pin is ignored — `Schema.Struct` discards it along with every other unrelated manifest key.

### Inputs decoded once, outputs folded once

`loadInputs` (`schema/inputs.ts`) decodes all 18 inputs into a typed `Inputs` record at the top of the pipeline through `ActionInput.*` combinators, so `INPUT_` mangling and empty-string-is-absent semantics stay the kit's business. Outputs run the same way in reverse: the fold starts from `initialOutputs` (all-disabled defaults) and each step's result maps over it, so a feature that did not run reports its default rather than a value nobody computed. `INPUT_NAMES` and `OUTPUT_NAMES` are const tuples checked against `action.yml` by tests — both halves of the parity contract are guarded.

### Split entry / program / layer

`main.ts` is one call. Keeping the pipeline and the layer composition in their own modules lets `__test__/unit/program.test.ts` import `program` without triggering a module-level `Action.run`.

### Descriptor pattern for runtimes

Per-tool data (URLs, archive kind, subpaths, binary name) lives in `src/descriptors/`. Descriptors are **pure and total**: the host is an argument, never a `process.platform` read, so every platform is exercisable in a unit test. Shared install logic lives in `install-runtimes.ts`. See [runtime installation](./runtime-installation.md).

### Seams as defaulted parameters, not services

Two operations cannot run for real in a unit test: `DetachedProcess.spawn`/`awaitReady` in `startTurboCache`, and `DetachedProcess.reap` in `post`. Both are **statics on a class**, not services, so there is no layer to swap. Rather than wrap them in a repository-local service — which would put it into every consumer's layer composition and into `PostLive` — each is injected as a defaulted field (`StartTurboCacheArgs.detached`, `makePost(reap)`). `R` is unchanged, production uses the kit's own statics, and no caller passes one. The same pattern covers `installRuntimes`' `host`, `installBiome`'s `host` and `installDependencies`' `platform`.

The one recorded cost: `program.test.ts` cannot reach the embedded turbo path (that would be a real spawn), so its turbo case is pinned to `turbo-cache: off` and the outputs fold is pinned separately through the exported pure `turboCacheOutputs`.

### Non-fatal demotion

Cache restore absorbs every failure internally; the Biome, BATS and kcov installs are each caught at their call site in `program.ts`; `startTurboCache` and `writeSummary` catch their own; the whole post phase catches typed failures *and* defects. An optional operation never fails the job.

For BATS and kcov the reason is sharper than "optional". Both are **auto-detected**, so a repository that never asked for them by name can still end up installing them — one stray `.bats` fixture is enough. A repository that did not opt in explicitly must not be able to lose a build to a kcov compile failing on an unusual runner image, or to a helper library's tarball 404ing. The consuming workflow's own test step is what should go red if the tooling it genuinely needs is absent, and `vitest-bats` already reports missing dependencies clearly. The cost of a bad detection is therefore time, never a red build.

### Cross-phase state via `ActionState`

Main and post are separate processes. `main` writes `CacheState` and `TurboServerState`; `post` reads them back. The encoded form of every field **must be plain JSON** — see [caching strategy](./caching-strategy.md#cross-phase-state-protocol), which owns that rule and the bug that produced it.

---

## System architecture

### The step-contract rule

Four things per `steps/` module, each a contract change if touched:

1. A declared **result type** (an exported interface, not an inferred object).
2. A **`Data.TaggedError`** with a `reason` literal union and a stored `message`.
3. An **explicitly annotated `R`** — never inferred.
4. Params passed as a **named object** once a step takes more than a couple of values, so Phase B additions stay additive.

`program.ts`'s `R` is the union of every step's, and `MainLive` supplies only what `ActionServices` lacks. A frozen contract is occasionally wider than today's implementation needs — `loadConfig` declares `Path` it does not use, `installBiome` declares `FileSystem` and `ActionLogger` the provisioner made unnecessary — and those stay, because narrowing `R` is a contract change.

### Log structure

`ActionLogger.group(title, effect)` wraps each step. Inside the two noisiest steps the transcript is additionally held by `logger.withBuffer(name, effect, { onSuccess: "discard" })`, so a green run is one line per runtime and one line per manager, while a failure spills the whole transcript. Warnings are never buffered, so an integrity notice reaches the log even on a green run.

`Effect.logDebug` output appears only under `ACTIONS_STEP_DEBUG=true`; the cache key, the restore ladder, the resolved path set and the lockfile list are all logged at debug level.

---

## Data flow

### Configuration flow

```text
package.json
    |
    v  FileSystem.readFileString -> JSON.parse -> Schema.decodeUnknownEffect
{ devEngines: { packageManager, runtime: RuntimeSpec | NonEmptyArray<RuntimeSpec> } }
    |
    v  normalize: a single runtime becomes an array of one, nothing else changes
RuntimeConfig { packageManager: PackageManagerSpec, runtimes: NonEmptyArray<RuntimeSpec> }
    |
    +--> detectBiome  (input override -> biome.jsonc -> biome.json -> $schema regex) : Option<string>
    +--> detectTurbo  (fs.access("turbo.json"))                                      : { enabled }
    +--> detectBats   (vitest-bats in the manifest OR a *.bats file within 4 levels) : { installBats, installKcov }
```

### The two BATS detection signals are not interchangeable

`bats: auto` looks for **two** signals — `vitest-bats` in any dependency set of the root `package.json`, or a `*.bats` file — and both are load-bearing. They are not a primary and a fallback, and the code must not be "simplified" into one:

- `vitest-bats` **generates its `.bats` files at run time and commits none**, so for the action's own reference consumer the glob signal never fires. The manifest probe is the only one that can see it.
- A repository with committed `.bats` files and no `vitest-bats` dependency — plain bats-core usage, which is the common case — is the exact mirror. The manifest probe sees nothing there.

The glob walk is depth-bounded (four levels) and skips `node_modules`, `.git`, `dist`, `coverage`, `.turbo` and dotted directories, because it runs on every job in every consuming repository and the signal it looks for lives near the top of a repository that has it. A vendored `.bats` fixture inside a dependency is not this repository's intent to run bats. Each candidate is also `stat`ed rather than matched on name alone: `readDirectory` reports directories too, and a directory named `example.bats` would otherwise provision the whole toolchain for a repository containing no test file at all.

`kcov: auto` follows the bats decision, and an explicit `kcov: on` still yields nothing when bats is off. Coverage for a toolchain that runs no tests is never what the consumer meant. The input exists separately so a repository can take bats *without* paying kcov's source build — which is what this repository's own fixture row does.

Duplicates survive normalization, declaration order is preserved, names are case-sensitive and no field is defaulted. `runtime: []` is a decode failure, which keeps `runtimes` non-empty by construction.

### Cache key flow

`{platform}-{arch}-{versionHash}-{branchHash}-{lockfileHash}`, assembled by `keySegments` and handed to the kit's typed `CacheKey`. See [caching strategy](./caching-strategy.md) for the formula, the two-rung restore ladder and the `"empty"` sentinel.

### Cross-phase state

```text
main                                            post
  restoreCache()                                  makePost(reap)
    |                                               |
    +-- ActionState.save(                           +-- getOptional(turboServer, TurboServerState)
    |     STATE_KEYS.cache,                         |     Some -> reap(pid)   [FIRST, unconditional]
    |     CacheState { paths, primaryKey,           |     None -> debug line
    |                  restoredKey, lockfiles })    |
    |                                               +-- getOptional(cache, CacheState)
  startTurboCache()                                 |     None            -> return
    |                                               |     exact hit       -> skip save
    +-- ActionState.save(                           |     no paths        -> skip save
    |     STATE_KEYS.turboServer,                   |     otherwise       -> ActionCache.save(paths, primaryKey)
    |     TurboServerState { pid, port,             |
    |                        backend, logFile })    +-- getOptional(kcovCache, KcovCacheState)
    |                                               |     None            -> nothing was built; return
  installKcov()  [only when it built,               |     exact hit       -> skip save
    |             or restored off a rung]           |     otherwise       -> ActionCache.save(prefix, primaryKey)
    +-- ActionState.save(                           |
          STATE_KEYS.kcovCache,                     +-- catch + catchDefect
          KcovCacheState { paths, primaryKey,
                           restoredKey })
```

The reap runs first and unconditionally, ahead of every branch that can return early: a leaked cache server outlives the job, and whether this run's dependencies are worth archiving has nothing to do with it. Each branch also catches its own failures — three independent jobs, three independent failure modes, and none of them may cost another its work. An unreadable dependency-cache state says nothing about whether the kcov tree is worth archiving, and the reverse holds too.

`post` saves under the **primary** key, not whichever key matched: a partial restore left the archive short of what this run installed, so the key this run asked for is the one that has to end up populated.

### Outputs and the summary

`emitOutputs` publishes all 22 outputs in a fixed order, rendering booleans with `String(v)`. `writeSummary` then takes a `SummaryFacts` params object rather than the outputs alone, because three of the panel's facts are not outputs at all: the installed runtime list in declaration order, the cache key and resolved lockfile list, the typed turbo port, and `dependenciesInstalled` — the *truthful* `ran` flag, where v1 echoed the raw input and reported deno's skipped install as done.

---

## Integration points

### GitHub Actions runtime

- **Inputs** — `ActionInput.string` / `.redacted` / `.boolean` / `.lines`, composed with `Config.all` and `Config.withDefault` in `schema/inputs.ts`.
- **Outputs** — `ActionOutputs.set`, plus `addPath`, `exportVariable`, `setSecret`, `summary`.
- **Environment** — `ActionEnvironment.github` (fail-fast, workspace) and `.getOptional` for `GITHUB_HEAD_REF`, `GITHUB_REF`, `RUNNER_TOOL_CACHE`.
- **Cache** — `ActionCache.restore`/`.save` over a typed `CacheKey`.
- **State** — `ActionState.save`/`.getOptional`, file-backed between phases.
- **Logging** — `ActionLogger.group` and `.withBuffer`; `Effect.log*` for lines.

### `@effected/*` services and values in use

| Import | Purpose | Used by |
| --- | --- | --- |
| `Action` | `Action.run` entry harness | `main.ts`, `post.ts` |
| `ActionInput` | Input reads (dual-accept naming) | `schema/inputs.ts` |
| `ActionOutputs` | Outputs, `addPath`, `exportVariable`, `setSecret`, `summary` | outputs, installs, turbo, summary |
| `ActionLogger` | Log groups and buffered transcripts | `program.ts` and three steps |
| `ActionEnvironment` | Runner context and raw variables | `program.ts`, `restore-cache.ts`, worker |
| `ActionCache` + `CacheKey` | Typed key, restore, save | `restore-cache.ts`, `post.ts` |
| `ActionState` + `ProcessId` | Cross-phase persistence | `restore-cache.ts`, `turbo-cache.ts`, `post.ts`, `state.ts` |
| `ToolInstaller` | `find`/`download`/`extract*`/`cacheDir`/`provisionFile` | `install-runtimes.ts`, `install-biome.ts`, `install-bats.ts`, `install-kcov.ts` |
| `PackageManagerInstaller` | Manager provisioning and shims | `setup-package-manager.ts` |
| `DetachedProcess` | `spawn`, `awaitReady`, `reap` | `turbo-cache.ts`, `post.ts` |
| `BlobStore` / `GitHubCacheBlobStore` | Backend for the embedded cache | `turbo-cache/handler.ts`, `server-config.ts` |
| `Secret` | `mask`, `forSigning`, `forChildEnv`, `forRunnerFile` | `turbo-cache.ts` |
| `GitHubMarkdown` | Job-summary markdown | `summary/format.ts` |
| `PackageManagerPin` (`@effected/npm`) | `<name>@<version>[+<integrity>]` grammar | `setup-package-manager.ts` |
| `SemVer.ExactVersionString` (`@effected/semver`) | Backs `AbsoluteVersion` | `schema/domain.ts` |
| `Jsonc` (`@effected/jsonc`) | `biome.jsonc` parsing | `detect-biome.ts` |
| `Run` (`@effected/commands`) | `Run.succeeds` for the `jq` and `kcov --version` probes, `Run.collect` for each build command | `install-bats.ts`, `install-kcov.ts` |

`@effected/commands` is the newest arrival and the only place this action shells out to a **system** package manager (apt or Homebrew, on kcov's cache-miss path). `Run.collect` rather than `Run.text` for the build steps is deliberate: a non-zero exit is a *result* on `collect`, so the failing command's `stderr` reaches the warning, where `text` would fail the effect and leave a reader with "the build failed" and no cmake or apt diagnostic.

Several `@effected/*` packages are declared in `package.json` but not imported by `src/` today (`git`, `github`, `glob`, `markdown`, `package-json`, `runtimes`, `sbom`, `workspaces`, `yaml`). Notably, lockfile discovery and hashing moved onto `CacheKey.matchingFiles` / `CacheKey.hashFiles`, so `@effected/glob` is no longer a code dependency of the cache path.

### Core `effect` platform services

`FileSystem`, `Path`, `Stream`, `Result`, `Option` and `ChildProcessSpawner` (`effect/unstable/process`) all import from core `effect`. Node implementations (`NodeFileSystem.layer`, `NodeHttpClient.layerUndici`) come from `@effect/platform-node` and are composed by `ActionRuntime` — except in the detached worker, which builds its own.

---

## Related documentation

**Internal:**

- [Effect service model](./effect-service-model.md) — step contracts, error taxonomy, layer and seam patterns.
- [Caching strategy](./caching-strategy.md) — cache key formula, restore ladder, cross-phase state protocol.
- [Runtime installation](./runtime-installation.md) — descriptors, tool cache layout, PATH publication, PM and Biome.
- [Turbo remote cache](./turbo-remote-cache.md) — activation table, detached worker, envelope, teardown.
- [Build and distribution](./build-and-distribution.md) — three-entry bundle, dist management, dependency topology.
- [Testing strategy](./testing-strategy.md) — kit test layers, parity guards, fixture and e2e matrices.

**Context files:**

- [Root CLAUDE.md](../../../CLAUDE.md)
- [src/CLAUDE.md](../../../src/CLAUDE.md)
