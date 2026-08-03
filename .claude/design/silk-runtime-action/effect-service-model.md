---
status: current
module: silk-runtime-action
category: architecture
created: 2026-03-21
updated: 2026-08-02
last-synced: 2026-08-02
completeness: 95
related:
  - ./architecture.md
  - ./runtime-installation.md
  - ./testing-strategy.md
  - ./turbo-remote-cache.md
dependencies: []
---

# Effect service model

How the action uses Effect v4 for typed errors, dependency injection and composable layers — the step-contract rule, the error taxonomy, the seam patterns, and the log-group API.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Rationale](#rationale)
4. [Implementation details](#implementation-details)
5. [Related documentation](#related-documentation)

---

## Overview

Every side effect — file I/O, process execution, caching, outputs, logging, tool installation — flows through a service from `@effected/github-actions` or from core `effect`. The action imports `node:os`, `node:path`, `node:crypto`, `node:http` and `node:url` directly and nothing else. This is what makes service substitution in tests total and error propagation typed end to end.

**Key features:**

- All GitHub Actions integration through `@effected/github-actions` (`^0.3.0`); zero `@actions/*`.
- Inputs decoded once through `ActionInput.*` combinators composed with `Config.all`.
- Errors are per-step `Data.TaggedError` classes with a `reason` literal union and a **stored** `message` field — no central union, no computed getters.
- Log structure through `ActionLogger.group` and `ActionLogger.withBuffer`.
- Untestable statics (`DetachedProcess.*`) injected as **defaulted parameters**, never as repository-local services.
- Layer composition is two lines: `MainLive` and `PostLive` in `src/layers/app.ts`.

**When to load this doc:**

- Adding a step or a service dependency to the pipeline.
- Choosing between a service, a params field and a module-level constant for a new seam.
- Writing tests that swap services or inject failures.

---

## Current state

### The step-contract rule

Each module under `src/steps/` declares four things, and each is a contract change if touched:

1. **A declared result type** — an exported interface (`InstalledRuntime`, `ActivatedPackageManager`, `StartedTurboCache`, …), not an inferred object literal.
2. **A `Data.TaggedError`** with a `reason` literal union, a stored `message` and an optional `cause`.
3. **An explicitly annotated `R`** — never inferred. `program.ts`'s `R` is the union of every step's.
4. **A params object** once the step takes more than a value or two (`RestoreCacheArgs`, `StartTurboCacheArgs`, `SummaryFacts`), so later additions are additive rather than a fifth positional argument.

A frozen contract is sometimes wider than the implementation needs. `loadConfig` declares `Path` and never resolves one; `installBiome` declares `FileSystem` and `ActionLogger` that `ToolInstaller.provisionFile` made unnecessary. Those stay — narrowing `R` is a contract change, and the cost of an unused requirement is a line in a test's layer.

### Service dependencies by module

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
| `steps/turbo-cache.ts` | `ActionState`, `ActionOutputs` |
| `steps/summary.ts` | `ActionOutputs`, `ActionLogger` |
| `summary/format.ts` | — (pure) |
| `turbo-cache/activation.ts`, `meta.ts` | — (pure) |
| `turbo-cache/handler.ts` | `BlobStore` |
| `post.ts` | `ActionCache`, `ActionState` |

`ActionRuntime.layer` (composed by `Action.run`) provides `ActionEnvironment`, `ActionLogger`, `ActionOutputs`, `ActionState`, `HttpClient` and `NodeServices`. `MainLive` adds `ActionCache`, `PackageManagerInstaller` and `ToolInstaller`; `PostLive` adds `ActionCache` alone.

### Detached worker runtime

`src/turbo-server.ts` runs outside `Action.run`. It composes its own layer stack in `turbo-cache/server-config.ts` (`NodeFileSystem`, `NodeHttpClient.layerUndici`, `ActionEnvironment.layer`, `ActionOutputs.layerDetached`) and drives the handler through a `ManagedRuntime` from a plain `node:http` server. `ActionOutputs.layerDetached` is a **secret-leak fix**, not tidiness — see [turbo remote cache](./turbo-remote-cache.md#the-detached-worker-must-not-get-the-real-actionoutputs-layer).

### Input access pattern

All 16 inputs are decoded once, at the top of the pipeline:

```ts
export const loadInputs: Config.Config<Inputs> = Config.all({
  biomeVersion: Config.option(ActionInput.string("biome-version")),
  turboCache: ActionInput.string("turbo-cache").pipe(Config.withDefault("auto")),
  turboToken: Config.option(ActionInput.redacted("turbo-token")),
  installDeps: ActionInput.boolean("install-deps").pipe(Config.withDefault(true)),
  additionalLockfiles: ActionInput.lines("additional-lockfiles").pipe(Config.withDefault([])),
  // …
}).pipe(
  Config.map((raw) => ({
    ...raw,
    turboCache: raw.turboCache === "off" ? ("off" as const) : ("auto" as const),
    cacheBust: Option.filter(raw.cacheBust, (v) => v !== "false" && v !== ""),
  })),
);
```

Three conventions are load-bearing:

- **`ActionInput` owns the naming.** The runner uppercases an input name and **preserves hyphens** (`INPUT_BIOME-VERSION`); only spaces become underscores. A hand-written `INPUT_BIOME_VERSION` reads as absent and the action silently falls back to a default. Because the kit's provider is dual-accept, code and tests key by input name and spell no variable at all.
- **Empty is absent.** `ActionInput` treats an unsupplied input and an empty string as the same case, which is why `Option.isSome` in the activation table is exactly v1's `!== ""` with no empty-string handling of its own.
- **Secrets are `Redacted`.** `turbo-token`, `turbo-s3-secret-access-key` and `turbo-s3-session-token` are read with `ActionInput.redacted` and only declassified through `Secret.*`.

Two normalizations happen in the `Config.map` rather than at a use site: `turbo-cache` collapses to `"auto" | "off"`, and `cache-bust` filters out the `"false"` and empty sentinels so downstream code sees a plain `Option`.

### Error taxonomy

Errors are `Data.TaggedError` subclasses — **not** `Schema.TaggedErrorClass`, and not the legacy computed-getter form:

```ts
export class CacheError extends Data.TaggedError("CacheError")<{
  readonly reason: "key" | "restore" | "state" | "save";
  readonly message: string;
  readonly cause?: unknown;
}> {}
```

The standing rules:

- `reason` is a **literal union** — a routing discriminant, never prose.
- `message` is a **stored field**, assembled at the raise site where the context lives. No getters: a getter cannot see the arguments the call site had.
- `cause` carries the underlying typed failure so a log line can name the kit's own reason literal (`unreachable` and `archiveFailed` call for different responses; the prose alone does not distinguish them).
- There is **no `ActionError` union** and no `errors/` module. Each step owns its taxonomy; `program.ts`'s error channel is the union of them by inference.

Some reason literals exist without a producer today and that is documented at the definition site (`BiomeDetectError`, `TurboDetectError`, `BiomeInstallError`'s `extractFailed` classification arm). One literal was **removed** for that reason during the rebuild: `TurboCacheError`'s `backend`, because the activation table resolves every input combination to one of its four rows, so no such state can be raised.

Classification helpers are written to be **exhaustive by construction**. `setup-package-manager.ts` narrows the kit's reason union in a `switch` with a `const unhandled: never` default; `install-biome.ts` uses a `switch` with **no** default and an annotated return type. Either way a new upstream literal is a typecheck failure here rather than a silent fall-through.

### Failure posture per step

| Step | Posture |
| --- | --- |
| `loadConfig` | Fatal |
| `detectBiome`, `detectTurbo` | Every failure resolves to "absent"/`false` |
| `restoreCache` | Every failure absorbed through one `absorb` helper; answers with a miss-shaped `CacheState` |
| `installRuntimes` | Fatal, sequential, first failure stops the rest |
| `setupPackageManager` | Fatal |
| `installDependencies` | Fatal, no timeout, no retry |
| `installBiome` | Fails typed; `program.ts` catches at the call site and folds `Option.none()` |
| `startTurboCache` | Self-catching: `Effect.catch` + `Effect.catchDefect` → `DISABLED` |
| `writeSummary` | Self-catching: render and write both degrade to a warning |
| `post` | Two independent inner catches, plus an outer `catch` + `catchDefect` |

`main` has **no** `catchDefect`: a defect is a bug in this action and failing the job is the correct outcome. `post` keeps one because a post-action failure must never fail a workflow whose work already succeeded.

### Log structure

`ActionLogger.group(title, effect)` opens a collapsible workflow group per step. Inside the two noisiest steps the transcript is additionally held:

```ts
logger.withBuffer(spec.name, installOne(spec, host), { onSuccess: "discard" })
```

Held-and-discarded on success means a green run is one line per runtime; a failure spills the URL, the cache path and everything else. **Warnings are never buffered**, so `PackageManagerInstaller`'s missing-integrity notice reaches the log even on a green run.

`installDependencies` buffers the *echoed stderr* rather than the install itself — the install's stdout is inherited and streams live — and flushes on every exit path, so a failing install shows all of it and not just the ten-line tail the error message carries.

---

## Rationale

### `Data.TaggedError` over `Schema.TaggedErrorClass`

Errors here are never decoded from an external representation; they are constructed at a raise site and read by a log line or a `catchTag`. `Data.TaggedError` gives structural equality and the tag without a schema's construction-time validation cost, and a stored `message` lets each raise site assemble the one sentence a human needs. Schema-backed errors would also invite persisting an error across the phase boundary, which nothing here does.

### Inputs through `ActionInput` rather than a service

Reading inputs against the `ConfigProvider` keeps defaults co-located with the read and makes the whole input surface one value (`Inputs`) that steps receive as data. Tests provide `ActionInput.layer({ "biome-version": "2.3.14" })` keyed by input name — no service to mock, no variable spelling to get wrong.

### Seams as defaulted parameters

`DetachedProcess.spawn`, `awaitReady` and `reap` are statics on a class, which is the right shape for the kit — a detached child has no scope to hang a service off. It leaves this action with three operations a unit test must not perform for real: `spawn` starts a process that outlives the test run, `awaitReady` polls for six seconds, and `reap` sends a real `SIGTERM` to whatever process owns the pid a fixture made up.

A repository-local service wrapper would have leaked into every consumer's layer composition and into `PostLive`, to make three functions overridable. Instead:

```ts
export interface DetachedProcessOps {
  readonly spawn: typeof DetachedProcess.spawn;
  readonly awaitReady: typeof DetachedProcess.awaitReady;
}
// StartTurboCacheArgs.detached?: DetachedProcessOps
export const makePost = (reap: Reap = DetachedProcess.reap) => /* … */;
```

`R` is unchanged, production runs the kit's statics, and no caller passes one. The same pattern covers the three `process` reads that would otherwise be untestable: `installRuntimes(config, host = currentHost())`, `installBiome(version, host = currentHost())` and `installDependencies(pm, enabled, prepends, platform = process.platform)`.

### Pure modules for everything host-argument-driven

`steps/cache-config.ts`, `summary/format.ts`, `turbo-cache/activation.ts`, `turbo-cache/meta.ts` and every descriptor are pure and service-free. That is what lets a Linux test pin the Windows store paths, the arch segment, an S3 activation and a codepoint-verbatim log line without a runner, a filesystem or a monkey-patched `process`.

`summary/format.ts` is pure for a second reason: the prose **is** the parity surface. A consumer's workflow log and job summary are what change when it drifts, so it lives in one module a test can pin verbatim rather than being inlined at the six call sites that emit it.

### One formatter per fact

`cacheLine` (in `restore-cache.ts`) is the single definition of the cache tristate prose, and `isExactHit` (in `state.ts`) is the single definition of "exact" — the `cache-hit` output, the panel cell and the post phase's save decision all turn on it. `formatTurboLine` renders both the step's log line and the panel row, so the log and the summary cannot disagree.

---

## Implementation details

### Layer composition

```ts
// src/layers/app.ts
export const MainLive = Layer.mergeAll(ActionCache.layer, PackageManagerInstaller.layer).pipe(
  Layer.provideMerge(ToolInstaller.layer),
);

export const PostLive = ActionCache.layer;
```

`provideMerge` rather than `merge`: `PackageManagerInstaller` builds on the tool cache, so one `ToolInstaller` satisfies its requirement *and* stays available to `installRuntimes` and `installBiome`. Everything both layers still require — `ActionEnvironment`, `FileSystem`, `Path`, `ChildProcessSpawner`, `HttpClient` — comes from `ActionServices`, which is what `ActionRunOptions.layer`'s `Layer<R, never, ActionServices>` shape allows.

### Effect v4 API notes

- `catchAll` → `Effect.catch`; `catchAllDefect` → `Effect.catchDefect`; `catchTag` is unchanged.
- `Schema.Literals([...])` for literal unions; `Schema.NonEmptyArray`, `Schema.optionalKey`, `Schema.OptionFromNullOr`.
- `Result` (not `Either`) is what descriptors and `readServerConfig` return.
- `ChildProcessSpawner` and `ChildProcess` live in `effect/unstable/process`.
- Platform abstractions (`FileSystem`, `Path`, `Stream`, `HttpClient`) import from core `effect`; only `NodeFileSystem` / `NodeHttpClient` come from `@effect/platform-node`.
- Services are class-based `Context.Service` with exported `*Shape` companion types — but **this action defines none of its own**. The one local service the legacy implementation had (`RuntimeInstaller`) was dissolved into a descriptor table plus a plain step function.

### Error prose conventions

Two helpers in `install-runtimes.ts` are deliberately kept apart:

- `extractErrorReason(error)` — a defensive accessor returning the sentence a human reads. It prefers `message` over `reason`, which is **swapped** relative to legacy: `@effected` errors carry a discriminant in `reason` (`downloadFailed`) and prose in `message`, so the legacy order rendered every install failure as one word.
- `classify(error)` — reads the `reason` **discriminant** to pick this step's literal. Unifying the two would tie a routing decision to a message string.

Wrapping messages name the failure exactly once. Legacy nested its own prose inside itself (`Failed to install dependencies with pnpm: Failed to install dependencies: …`); every wrap here adds exactly one prefix and carries the inner error verbatim.

### Logging levels

- `Effect.logInfo` — the lines a normal run shows: one per installed tool, the detect headline, the cache verdict, the final group.
- `Effect.logWarning` — every degradation. Never buffered.
- `Effect.logError` — a turbo server that never became ready (the run continues).
- `Effect.logDebug` — the cache key, the restore ladder, the path set, the lockfile list, resolved URLs, tool-cache roots, pids. Visible only with `ACTIONS_STEP_DEBUG=true`.

### Cross-phase state schemas

`ActionState` uses a **JSON text protocol**, so every field's *encoded* form must be plain JSON. This constrains schema choice and has already produced one production bug. The rule and its history live in [caching strategy](./caching-strategy.md#cross-phase-state-protocol); the same constraint applies to the turbo artifact metadata written through `BlobEnvelope` (see `turbo-cache/meta.ts`).

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) — pipeline order, module map, layer topology.
- [Runtime installation](./runtime-installation.md) — the descriptor table that replaced the local service.
- [Turbo remote cache](./turbo-remote-cache.md) — `BlobStore`, the detached runtime, `Secret.*` declassification.
- [Testing strategy](./testing-strategy.md) — kit test layers, failure injection, the real-`ActionState` harness.

**Context files:**

- [src/CLAUDE.md](../../../src/CLAUDE.md)
