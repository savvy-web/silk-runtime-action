---
type: Convention
title: Unit test conventions
description: How src/ tests are organized, doubled, and asserted, and which operations a unit test must never perform for real.
tags: [testing]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 007b3d2abf9505f849529350de65f2c26fb98d5abd8828787f8bdcccb114f22a
sources:
  - id: test-tree
    resource: ../../__test__/unit
  - id: steps-test
    resource: ../../__test__/unit/steps/steps.test.ts
  - id: environment-test
    resource: ../../__test__/unit/environment.test.ts
  - id: program-test
    resource: ../../__test__/unit/program.test.ts
  - id: install-kcov-test
    resource: ../../__test__/unit/steps/install-kcov.test.ts
  - id: detect-bats-test
    resource: ../../__test__/unit/steps/detect-bats.test.ts
  - id: install-bats-test
    resource: ../../__test__/unit/steps/install-bats.test.ts
  - id: post-test
    resource: ../../__test__/unit/post.test.ts
  - id: format-test
    resource: ../../__test__/unit/summary/format.test.ts
  - id: install-bats-src
    resource: ../../src/steps/install-bats.ts
  - id: main-src
    resource: ../../src/main.ts
  - id: post-src
    resource: ../../src/post.ts
  - id: turbo-server-src
    resource: ../../src/turbo-server.ts
  - id: vitest-config
    resource: ../../vitest.config.ts
  - id: root-claude-contributing
    resource: ../../CLAUDE.md
---

# Unit test conventions

Mirror `src/` under `__test__/unit/`, never co-located, so the mapping between a source
module and its test file is mechanical in both directions:[^test-tree]

```text
__test__/unit/
  environment.test.ts       layers.test.ts          post.test.ts
  program.test.ts           state.test.ts
  schema/{domain,inputs,outputs}.test.ts
  steps/{cache-config,detect-bats,detect-biome,detect-turbo,install-bats,install-biome,
         install-dependencies,install-kcov,install-runtimes,load-config,restore-cache,
         setup-package-manager,steps,summary,turbo-cache}.test.ts
  summary/format.test.ts
  turbo-cache/{activation,handler,meta,server-config}.test.ts
  descriptors.test.ts
  descriptors/{bats,kcov}.test.ts
```

Two reasons drive the split, and both are why the tree stays this shape rather than
collapsing test files next to the modules they cover: coverage `include: ["src/**/*.ts"]`
stays a clean statement about production code, and the bundler never has to reason about a
test file sitting beside an entry point. Root `CLAUDE.md`'s own Contributing rule 2 restates
this repository-wide: add or update unit tests in `__test__/unit/`, mirroring the `src/`
path — never co-located — using `it.effect` plus `assert.*`, and `@effected/memfs` for
anything filesystem-shaped.[^root-claude-contributing]

`steps/steps.test.ts` is the cross-cutting suite: it asserts the shape every step's error
class shares — `_tag`, `reason` and `message` round-tripping through construction — rather
than any single step's behaviour.[^steps-test] `environment.test.ts` is the other odd one
out: it tests the *harness*, asserting from inside a worker that `vitest.setup.ts` really
stripped `GITHUB_ACTIONS`, `INPUT_*` and `STATE_*` before the fork pool inherited the
environment.[^environment-test][^vitest-config] Both prove a fact about the test rig itself,
not about a pipeline step, which is why neither lives under `steps/`.

## Kit test layers, partial overrides

`@effected/github-actions` exports a `layerTest` factory per service, taking **partial
overrides** — `ActionCache.layerTest({ restore: () => Effect.succeed(Option.none()) })`,
`ActionState.layerTest({ save: () => Effect.void })`, `ActionOutputs.layerTest({ addPath:
() => Effect.void, summary: () => Effect.void })`, and so on. **An unstubbed member dies on
use, and that is the design**: a test that stubs only what the code under test should touch
turns any unexpected call into a loud failure, so a step that starts calling a service it
should not is a design change the suite reports rather than silently tolerates.

Inputs are keyed by **input name** (`"biome-version"`), never by a runner variable spelling —
the provider is dual-accept, so no test needs to know the runner writes
`INPUT_BIOME-VERSION` with the hyphen intact. `ActionInput.variable(name)` exists for the
rare test that must speak the variable form directly.

## Failure injection has no separate idiom

A hand-written override on the same `layerTest` call is how a specific failure is injected —
a `restore` that fails with a typed `CacheError`, a `ToolInstaller.download` that 404s, a
`provisionFile` that reports `cacheFailed`. There is no separate mock idiom: the
partial-override shape already covers it, and the resulting layer is still type-checked
against the real service shape.

## Discriminating cases

Some suites have one case that is the reason the code is shaped the way it is. Naming them
matters, because deleting one of these leaves a green suite over a design nothing checks
anymore:

| Suite | The case that carries the design |
| --- | --- |
| `steps/install-kcov.test.ts` | **cache hit → probe fails → rebuild.** The whole reason the verify probe exists; a probe that detected without rebuilding would be worse than none.[^install-kcov-test] |
| `steps/detect-bats.test.ts` | `.bats` present with no dependency, and `vitest-bats` present with no `.bats` file. Either alone would pass a suite that treated the other as a fallback.[^detect-bats-test] |
| `steps/install-bats.test.ts` | bats-mock's `load.bash` synthesis when the tarball ships none, and `binstub` keeping its executable bit.[^install-bats-test] |
| `post.test.ts` | A kcov save *failing* without preventing the dependency-cache save. Three independent branches is a claim, and this is where it is checked.[^post-test] |
| `summary/format.test.ts` | The `⚠️ unavailable` kcov row — the one place BATS/kcov and Biome are deliberately unharmonized, pinned so it is not "fixed" later.[^format-test] |

## Seams a unit test must not exercise for real

Three defaulted parameters exist so a test never performs an untestable operation:

| Seam | Why |
| --- | --- |
| `StartTurboCacheArgs.detached` | `spawn` starts a process that outlives the test run; `awaitReady` polls for six seconds |
| `makePost(reap)` | the default would send a real `SIGTERM` to whatever process owns the pid a fixture made up |
| `host` / `platform` on the install steps | a Linux test exercises the Windows layout and the `shell: true` branch |

`StartTurboCacheArgs.serverEntry` is always supplied too, because `defaultServerEntry()`
resolves a sibling of the *bundle* and is meaningless when running from source.

The recorded cost: `program.test.ts` **cannot reach the embedded turbo path** (that would be
a real spawn), so its turbo case is pinned to `turbo-cache: off`, and the outputs fold for a
started server is pinned separately through the exported pure
`turboCacheOutputs`.[^program-test]

## Assertions are `assert.*`, and a prototype gotcha rides along

The suite uses chai-style `assert.*` from `@effect/vitest` throughout, never `expect`.
**`assert.deepStrictEqual` compares prototypes and `expect(...).toEqual` does not**, so a
decoded `Schema.Class` instance can never be compared against an object literal with
`deepStrictEqual` — assert its fields individually instead.

## `/* v8 ignore */` is reserved for runner-only code

`/* v8 ignore */` marks code that only a real runner can execute: `main.ts`'s `Action.run`
call,[^main-src] `post.ts`'s entry-point guard,[^post-src] and the whole body of
`turbo-server.ts`.[^turbo-server-src] Each of those is covered by the e2e matrices instead of
a unit double. Reaching for `/* v8 ignore */` on anything a unit test *could* reach is
scope creep on the exemption; it exists for the seam between the process boundary and the
runner, not as a general coverage escape hatch.

## The "unset $HOME" lesson

`install-bats` derives its BATS library root from `process.env.HOME`, defaulting — as of the
fix — to `os.homedir()` rather than `""`.[^install-bats-src] The lesson generalizes past this
one step: **a default that silently produces a relative path is a success in the wrong
place, not a failure anywhere.** On a runner where `$HOME` was absent, the old `""` default
resolved the library root to a *relative* path; the libraries installed into the checkout,
`BATS_LIB_PATH` exported a relative path, the action reported success, and every
`bats_load_library` in the consuming repository failed one step later with nothing in the
failure naming the cause. Two changes were needed together, because either alone is
insufficient: the default now falls back to `os.homedir()`, **and** an absolute-path check
fails typed before the first archive is fetched — the step refuses to install to a relative
root at all, rather than installing somewhere useless and reporting success. A convention
that follows from this: any host-derived filesystem root a step resolves must be checked
absolute before it is used, not merely defaulted to something that is usually absolute.

## Full-pipeline composition

`program.test.ts` composes every layer the program needs and swaps individual ones per
case:[^program-test]

```ts
Layer.mergeAll(
  ActionInput.layer(inputs),
  ActionLogger.layerTest(),
  options.cache ?? ActionCache.layerTest({ restore: () => Effect.succeed(Option.none()) }),
  ActionOutputs.layerTest({ addPath: () => Effect.void, summary: () => Effect.void, ...outputs }),
  ActionState.layerTest({ save: () => Effect.void }),
  options.environment ?? ActionEnvironment.layerTest(),
  toolInstallerTest,
  packageManagerInstallerTest,
  spawnerLayer(spawns),
  fileSystemLayer(files),
  // …
)
```

Cases assert on captured outputs, recorded spawns (including the child's `PATH`), and
exported variables. The fail-fast case asserts the **`ActionEnvironmentError` tag**
specifically, not merely that the run failed with no outputs — a run that fails for the
wrong reason is a different bug than a run that never fails at all, and a bare "it
failed" assertion cannot tell them apart.[^program-test]

## See also

- [`../decisions/kit-test-layers-and-real-volume.md`](../decisions/kit-test-layers-and-real-volume.md)
  — why the doubles come from the kit rather than being hand-rolled, and why the filesystem
  double is a real in-memory volume rather than a stub.
- [`../gotchas/in-memory-doubles-are-more-permissive.md`](../gotchas/in-memory-doubles-are-more-permissive.md)
  — what a green double proved and did not prove, and the production bug that closed the gap.

[^test-tree]: `../../__test__/unit`
[^environment-test]: `../../__test__/unit/environment.test.ts`
[^steps-test]: `../../__test__/unit/steps/steps.test.ts`
[^program-test]: `../../__test__/unit/program.test.ts`
[^install-kcov-test]: `../../__test__/unit/steps/install-kcov.test.ts`
[^detect-bats-test]: `../../__test__/unit/steps/detect-bats.test.ts`
[^install-bats-test]: `../../__test__/unit/steps/install-bats.test.ts`
[^post-test]: `../../__test__/unit/post.test.ts`
[^format-test]: `../../__test__/unit/summary/format.test.ts`
[^install-bats-src]: `../../src/steps/install-bats.ts`
[^main-src]: `../../src/main.ts`
[^post-src]: `../../src/post.ts`
[^turbo-server-src]: `../../src/turbo-server.ts`
[^vitest-config]: `../../vitest.config.ts`
[^root-claude-contributing]: `../../CLAUDE.md`
