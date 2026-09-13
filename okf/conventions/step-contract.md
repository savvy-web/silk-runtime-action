---
type: Convention
title: The step-contract rule
description: Every module under src/steps/ freezes four things, and touching any one is a contract change.
tags: [architecture, dx]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 3fd2b2f41d92650cf496618b1bc6b44c192bcf4ca01d5347d6fa95411142669e
sources:
  - id: step-contract-modules
    resource: ../../src/steps
  - id: program-composition
    resource: ../../src/program.ts
  - id: layers-app
    resource: ../../src/layers/app.ts
  - id: steps-shared-shape-test
    resource: ../../__test__/unit/steps/steps.test.ts
---

# The step-contract rule

Declare all four of the following in every module under `src/steps/`, and treat a change to
any one of them as a contract change, not a refactor:

1. A declared **result type** — an exported interface (`InstalledRuntime`,
   `ActivatedPackageManager`, `StartedTurboCache`, …), never an inferred object literal.
2. A **`Data.TaggedError`** subclass with a `reason` literal union, a stored `message` field
   and an optional `cause`.
3. An **explicitly annotated `R`** on the step's `Effect` — never let it be inferred.
4. A **params object** once the step takes more than a value or two (`RestoreCacheArgs`,
   `StartTurboCacheArgs`, `SummaryFacts`), so a later addition is additive rather than a
   fifth positional argument.

`src/program.ts`'s own `R` is the union of every step's `R`, assembled by inference over the
whole `Effect.gen` pipeline rather than declared by hand — which is exactly why each step's
own `R` has to be explicit: an inferred step `R` would make `program.ts`'s union silently
track whatever a step happened to touch, rather than what its contract promises. `MainLive`
and `PostLive` (`../../src/layers/app.ts`) supply only what `ActionServices` — the layer
`Action.run` already composes — lacks: `ActionCache`, `PackageManagerInstaller`,
`ToolInstaller` and `WorkspaceDiscovery` for `main`; `ActionCache` alone for `post`.
Everything else a step's `R` names (`ActionEnvironment`, `FileSystem`, `Path`,
`ChildProcessSpawner`, `HttpClient`) comes from `ActionServices` itself, because
`ActionRunOptions.layer` is typed `Layer<R, never, ActionServices>` — the shape that lets
both layers *require* the runtime's services instead of rebuilding them.

## A frozen contract may be wider than the implementation

A step's `R` is allowed to name a service the current implementation does not use, and that
is not drift to clean up:

- `loadConfig` (`../../src/steps/load-config.ts:46`) declares `Path.Path` in its `R` even
  though nothing in the step resolves a path — `Path` sits there because the frozen Phase A
  contract declared it, not because the step needs it (`load-config.ts:33-34`).
- `installBiome` (`../../src/steps/install-biome.ts:91`) declares `FileSystem.FileSystem`
  and `ActionLogger` in its `R` though nothing in the step body touches either — the chmod
  they were once needed for now belongs to `ToolInstaller.provisionFile` (`install-biome.ts:80-83`).

**Narrowing `R` is a contract change, even when the narrower type would still typecheck
today.** A step contract exists so a caller — chiefly `program.ts`'s union and the layer
composition in `layers/app.ts` — can rely on what a step asks for without re-reading its
body on every kit upgrade. Dropping a service from `R` because today's implementation
happens not to call it removes headroom the contract was written to keep, and the cost of
leaving an unused requirement in place is a single unused line in a test's layer
composition — not a correctness problem anywhere.

## The shared shape is asserted, not merely by convention

`../../__test__/unit/steps/steps.test.ts` is the cross-cutting suite: rather than testing
any one step's behaviour, it asserts the shape every step's error class shares — a
`Data.TaggedError` whose `_tag`, `reason` and `message` fields round-trip through
construction — for `CacheError`, `BiomeInstallError`, `BiomeDetectError`, `TurboDetectError`,
`TurboCacheError` and `SummaryError`. A step whose error class drops the stored `message` or
turns `reason` into free-form prose fails this suite even if the step's own behavioural
tests, living beside it, still pass.
