---
status: current
module: silk-runtime-action
category: testing
created: 2026-03-21
updated: 2026-08-20
last-synced: 2026-08-20
completeness: 95
related:
  - ./architecture.md
  - ./effect-service-model.md
  - ./build-and-distribution.md
  - ./turbo-remote-cache.md
dependencies: []
---

# Testing strategy

Two tiers: `@effect/vitest` unit tests over the kit's test layers, and fixture-based workflow tests running the built action on real runners.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [What a test double cannot tell you](#what-a-test-double-cannot-tell-you)
4. [The parity guards](#the-parity-guards)
5. [Rationale](#rationale)
6. [Implementation details](#implementation-details)
7. [Related documentation](#related-documentation)

---

## Overview

Unit tests run in Vitest through `@effect/vitest`, over service doubles provided by `@effected/github-actions` itself. Integration tests run inside real GitHub Actions workflow jobs against the **built** action.

**Key features:**

- **530 unit tests** in `__test__/unit/`, mirroring `src/` — never co-located.
- Kit-provided `X.layerTest({ … })` doubles with partial overrides; unstubbed members die on use, deliberately.
- Cross-phase state schemas are tested against the **real** `ActionState` layer, not a double.
- `action.yml` ↔ code parity is a test, for both inputs and outputs.
- Formatter prose is pinned **codepoint-verbatim**.
- Two e2e matrices: 39 fixture jobs across ubuntu/macos/windows, and 5 turbo-cache jobs including real S3.

**When to load this doc:**

- Writing a test, or deciding whether a double is trustworthy for what you are testing.
- Adding a fixture or an e2e assertion.
- Debugging a test that passes locally and fails on a runner.

---

## Current state

### Test organization

```text
__test__/unit/
  layers.test.ts            post.test.ts            program.test.ts       state.test.ts
  schema/{domain,inputs,outputs}.test.ts
  steps/{cache-config,detect-bats,detect-biome,detect-turbo,install-bats,install-biome,
         install-dependencies,install-kcov,install-runtimes,load-config,restore-cache,
         setup-package-manager,steps,summary,turbo-cache}.test.ts
  summary/format.test.ts
  turbo-cache/{activation,handler,meta,server-config}.test.ts
  descriptors.test.ts
  descriptors/{bats,kcov}.test.ts
```

Tests are **never co-located** with source. The tree mirrors `src/` so the mapping is mechanical.

`steps/steps.test.ts` is the cross-cutting one: it asserts the shape every step contract shares rather than any single step's behaviour.

### Kit test layers

`@effected/github-actions` exports a `layerTest` factory per service, taking **partial overrides**:

```ts
ActionCache.layerTest({ restore: () => Effect.succeed(Option.none()) })
ActionState.layerTest({ save: () => Effect.void })
ActionOutputs.layerTest({ addPath: () => Effect.void, summary: () => Effect.void })
ActionEnvironment.layerTest({ GITHUB_REPOSITORY: "" })
ActionEnvironment.layerFrom({ GITHUB_STATE: file })
ActionInput.layer({ "biome-version": "2.3.14" })
ActionLogger.layerTest()
ToolInstaller.layerTest({ /* … */ })
PackageManagerInstaller.layerTest({ /* … */ })
BlobStore.layerTest({ /* … */ })
```

**An unstubbed member dies on use, and that is the design.** A test that stubs only what the code under test should touch turns any unexpected call into a loud failure. `program.test.ts` leans on this explicitly: its `ChildProcessSpawner` double implements `spawn` and `exitCode` and lets the derived members die, because no step should be collecting a command's output wholesale.

Inputs are keyed by **input name** (`"biome-version"`), never by a runner variable spelling. The provider is dual-accept, so no test needs to know that the runner writes `INPUT_BIOME-VERSION` with the hyphen intact. `ActionInput.variable(name)` exists for the rare test that must speak the variable form.

### Failure injection

A hand-written override on the same `layerTest` call is how a specific failure is injected — a `restore` that fails with a typed `CacheError`, a `ToolInstaller.download` that 404s, a `provisionFile` that reports `cacheFailed`. There is no separate mock idiom: the partial-override shape already covers it, and the resulting layer is still type-checked against the real service shape.

### Discriminating cases

Some suites have one case that is the reason the code is shaped the way it is. Those are worth naming, because deleting them leaves a green suite over a design nothing checks:

| Suite | The case that carries the design |
| --- | --- |
| `steps/install-kcov.test.ts` | **cache hit → probe fails → rebuild.** The whole reason the verify probe exists; a probe that detected without rebuilding would be worse than none. |
| `steps/detect-bats.test.ts` | `.bats` present with no dependency, and `vitest-bats` present with no `.bats` file. Either alone would pass a suite that treated the other as a fallback. |
| `steps/install-bats.test.ts` | bats-mock's `load.bash` synthesis when the tarball ships none, and `binstub` keeping its executable bit. |
| `post.test.ts` | A kcov save *failing* without preventing the dependency-cache save. Three independent branches is a claim, and this is where it is checked. |
| `summary/format.test.ts` | The `⚠️ unavailable` kcov row — the one place BATS/kcov and Biome are deliberately unharmonized, pinned so it is not "fixed" later. |

### Seams a unit test must not exercise for real

Three defaulted parameters exist so a test never performs an untestable operation:

| Seam | Why |
| --- | --- |
| `StartTurboCacheArgs.detached` | `spawn` starts a process that outlives the test run; `awaitReady` polls for six seconds |
| `makePost(reap)` | the default would send a real `SIGTERM` to whatever process owns the pid a fixture made up |
| `host` / `platform` on the install steps | a Linux test exercises the Windows layout and the `shell: true` branch |

`StartTurboCacheArgs.serverEntry` is always supplied too, because `defaultServerEntry()` resolves a sibling of the *bundle* and is meaningless when running from source.

The recorded cost: `program.test.ts` **cannot reach the embedded turbo path** (that would be a real spawn), so its turbo case is pinned to `turbo-cache: off`, and the outputs fold for a started server is pinned separately through the exported pure `turboCacheOutputs`.

### Coverage

`vitest.config.ts` uses `@vitest-agent/plugin`'s **strict** level for both thresholds and per-file coverage targets, with:

```ts
coverage: { enabled: true, provider: "v8", include: ["src/**/*.ts"], exclude: [] }
```

`include` is what makes a never-imported source file score **0%** instead of being silently omitted from the report.

`/* v8 ignore */` is reserved for code that only a real runner can execute: `main.ts`'s `Action.run` call, `post.ts`'s entry-point guard, and the whole body of `turbo-server.ts`. Each of those is covered by the e2e matrices instead.

**Tooling note:** the agent coverage tool needs the project named explicitly (`@savvy-web/silk-runtime-action`); the no-argument default reports nothing and looks like a dead gate.

### Fixtures and e2e

`__fixtures__/` holds one directory per supported configuration: `node-npm`, `node-pnpm`, `node-yarn`, `node-multi`, `bun-bun`, `biome-enabled`, `turbo-enabled`, `bats-kcov`, `additional-inputs`, `turbo-monorepo`. Each carries a `package.json` with valid `devEngines`.

| Workflow | Jobs | Covers |
| --- | --- | --- |
| `test.yml` | 37 across ubuntu/macos/windows | create-cache (5 fixtures × 3 OS, plus `bats-kcov` on ubuntu/macos), restore-cache (4 × 3), feature detection (2 × 3), additional inputs |
| `test-turbo-cache.yml` | 5 | within-job double build, cross-job hit via `needs:`, MinIO-backed S3, a real-S3 gate and a real-S3 double build |

Both matrices use `fail-fast: false` so a single run surfaces every failure. Both run `.github/actions/local` — the **built** action — not the source.

Cache fixtures run as a dependent pair: a create job installs everything and saves, then a restore job asserts `cache-hit`. Turbo fixtures use a double-build pattern: run `turbo run` twice and assert the second build is a remote cache hit.

### What the `bats-kcov` fixture is for

The fixture holds `hello.sh` and `test/hello.bats`, and its `test-command` is `bats --version && bats test/`. The second half is the whole point: it proves **`bats_load_library` resolving through the exported `BATS_LIB_PATH`**, end to end, on a real runner.

No unit test can reach that. The unit suite proves that `install-bats` writes the libraries to `$HOME/.local/share` and exports the variable; it cannot prove that bats's own library resolver, running in a later workflow step, finds them there — a claim that spans a process boundary, a runner-published `GITHUB_ENV`, and a third-party shell builtin. It is also the standing check on the synthesized `bats-mock` loader reaching disk verbatim, since the fixture runs the **built** action (see [build and distribution](./build-and-distribution.md#verification-means-the-built-artifact)).

Two deliberate scoping decisions on that row:

- **Windows is excluded from the matrix.** kcov refuses `win32` outright, and the bats install path is POSIX-shaped and unvalidated there. An excluded row is honest; a row asserting `false` everywhere would look like coverage.
- **`kcov: "false"`, even though `auto` would follow the bats decision.** The matrix scopes its `cache-bust` to `github.run_id`, so a kcov build here could never be restored — every PR would pay a multi-minute source build for a result nothing reuses. Worse, kcov failures degrade to warnings, so a broken build would not even turn the job red: the row would cost minutes and prove nothing. kcov's end-to-end validation (build, cache, restore) belongs on a downstream consumer's CI, where it is actually used and the warm-cache path is observable. With kcov uniformly off, `expected-kcov-enabled: "false"` can be asserted as a literal — while it followed `auto` the expected value differed per OS and no single literal held across the matrix.

---

## What a test double cannot tell you

Lessons from production bugs that green unit suites did not catch. The first two reduce to the same thing — **an in-memory double is strictly more permissive than the runner** — and the last to a sharper version of it: the thing under test in a unit suite is the source, and the thing CI runs is the bundle.

### Cross-phase state must round-trip through text

`ActionState` uses a JSON text protocol — `save` appends heredoc blocks to `GITHUB_STATE`, and the runner republishes each as a `STATE_<key>` variable that `get` parses. A `Map`-backed double hands the encoded object straight back and therefore round-trips schemas that JSON cannot.

`CacheState.restoredKey` as `Schema.Option` passed every double and failed on every real run (`"Expected Option"`), because `Schema.Option`'s *encoded* form is an `Option` instance. See [caching strategy](./caching-strategy.md#cross-phase-state-protocol).

`__test__/unit/state.test.ts` is therefore built on the **real** `ActionState.layer`:

```ts
const realState = (env: Record<string, string>): Layer.Layer<ActionState> =>
  ActionState.layer.pipe(
    Layer.provide(ActionEnvironment.layerFrom(env)),
    Layer.provide(ActionOutputs.layerTest()),
    Layer.provide(NodeFileSystem.layer),
  );
```

A full trip saves through a service pointed at a scoped temp state file, **republishes that file the way the runner does** (a five-line heredoc parser), and reads it back through a second, independently built service. That is the harness pattern for any future state schema.

### `ProcessId.make`, never `makeUnsafe`

`makeUnsafe` typechecks through a test double and then dies at runtime in exactly the place `catchDefect` goes blind. Every construction uses `ProcessId.make`. `TurboServerState.pid` is `ProcessId` rather than a number for the same class of reason: a truncated state file, an absent key or `Number("")` all decode to `0`, and the brand refuses that value before it reaches `DetachedProcess.reap`.

### A passing unit test proves the source, not the bundle

`install-bats` synthesizes a `load.bash` for `bats-mock`, and the unit suite covers that synthesis directly — the case exists, it asserts the file's exact contents, and it was green throughout. The bundled `dist/main.js` nonetheless carried a live `${BASH_SOURCE[0]}` template substitution, because the minifier constant-folded the escaped source form back into one, and every run of the built action died at module load with `ReferenceError: BASH_SOURCE is not defined`.

The full account, and the rule it generalizes to, live in [build and distribution](./build-and-distribution.md#verification-means-the-built-artifact). What it means *here*: for any literal that must reach disk verbatim, the unit test is necessary and not sufficient. The e2e tier is the only tier that runs the artifact CI runs, which is one more reason the fixture matrices are not optional garnish.

### The e2e harness must fail on an empty answer

The fixture harness's `check_value` and `check_contains` both used to *return early* on an empty actual, so a fixture that asserted `lockfiles` and got back an empty output recorded a pass. Both now fail when the actual is empty and the expected is not — an empty string cannot equal a non-empty expected, and an empty item list makes every expected item missing by definition. An empty **expected** is still a deliberate skip, because most `expected-*` inputs default to empty.

The matrices were re-run at HEAD after that fix specifically to prove no latent failures had been hiding behind it.

---

## The parity guards

`action.yml` is the contract with consumers, and both halves of it are guarded by tests rather than by convention.

### Inputs

`__test__/unit/schema/inputs.test.ts` parses `action.yml` directly (a deliberate five-line parse rather than a YAML dependency — reading the file for real is what makes the guard bite) and compares three sets: the names declared in `action.yml`, the `INPUT_NAMES` tuple, and the names `loadInputs` actually asks the provider for.

The third set comes from a `Proxy` over the environment that records every lookup. Since the provider became dual-accept, one input costs two probes, and a key already spelled as a runner variable is probed as `INPUT_INPUT_…` before being found as itself. **Repeated prefixes are stripped in the proxy** rather than added to the expected set — widening the expected set would have made the exhaustiveness assertion vacuous.

### Outputs

`__test__/unit/schema/outputs.test.ts` runs the same `action.yml` cross-check against `OUTPUT_NAMES`, and additionally pins the **mapping**: a fixture whose 22 values are distinct from each other and from every default proves that swapping any two model fields fails, so `emitOutputs` cannot quietly publish `bun-version` under `deno-version` — or `bats-version` under `kcov-version`, in a block of near-identical `set` calls that grew by six with the BATS work.

### Prose

`__test__/unit/summary/format.test.ts` pins every formatter **codepoint-verbatim** against the legacy surface — including the middle dot `·` (U+00B7), the panel's emoji cells, and the two deliberately unharmonized separator conventions (a space in the detect line and the panel, an `@` in the log groups). The prose is what a consumer sees, so it is parity surface and is tested as such.

---

## Rationale

### Kit test layers over hand-rolled mocks

The doubles ship with the services, so they cannot drift from a shape they are defined against. Partial overrides mean a test declares exactly the surface it depends on, and anything else failing loudly is a feature: a step that starts calling a service it should not is a design change, and the test should say so.

### Tests in `__test__/`, not co-located

The rebuild moved every test out of `src/`. Two reasons: coverage `include: ["src/**/*.ts"]` stays a clean statement about production code, and the bundler never has to reason about test files sitting beside entry points. The mirrored path makes the mapping mechanical in the other direction.

### Purity as a testing strategy

Roughly half the behaviour worth testing lives in pure modules — `steps/cache-config.ts`, `summary/format.ts`, `turbo-cache/activation.ts`, `turbo-cache/meta.ts` and every descriptor. Those need no layer at all, which is how a Linux test pins the Windows store paths, the bun-on-Windows x64 pin, the arch segment and an S3 activation. Legacy read `process.platform` inside its installer and `os.platform()` inside its Biome descriptor, and consequently no legacy test ever covered a second platform.

### Two tiers, and what each is for

Unit tests catch logic fast and are the only place a failure path is cheap to exercise. But three things are provable **only** on a real runner, and each of them was a live bug:

- The Windows tool-cache layout and the `.cmd` shell launch.
- The lifecycle-script `PATH` (`deno: not found` from a `postinstall`).
- The cache round trip, including the restore ladder against the real service.
- `bats_load_library` resolving through the exported `BATS_LIB_PATH` in a later workflow step — and, with it, whether a synthesized loader survived minification into `dist`.

The matrices are the pin for all four.

---

## Implementation details

### Full-pipeline composition

`program.test.ts` composes every layer the program needs and swaps individual ones per case:

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

Cases assert on captured outputs, recorded spawns (including the child's `PATH`), and exported variables. The fail-fast case asserts the **`ActionEnvironmentError` tag** specifically, not merely that the run failed with no outputs.

### Runner facts that shape the workflows

**A `uses:` step runs at `GITHUB_WORKSPACE` regardless of `defaults.run.working-directory`.** A `run:` step honours the default; a `uses:` step does not. The turbo e2e workflow learned this the hard way — the action installed *this repository's* dependencies instead of the fixture's. The fix is `install-deps: "false"` on every fixture-scoped `uses:` step, with the fixture's own install done by a `run:` step that does honour the working directory. Every job in `test-turbo-cache.yml` carries that pattern with a comment.

**`ACTIONS_STEP_DEBUG=true`** is what surfaces the cache key, the ladder, the resolved path set and the lockfile list — the four things worth reading when a fixture's cache assertion fails.

### Fixture harness

`.github/actions/test-fixture/` is a composite action that:

1. Cleans the workspace and copies the fixture to the repository root.
2. Runs `.github/actions/local` (the built action), sometimes twice for a cache pair.
3. Compares actual outputs against `expected-*` inputs in a Python step (`check_value` for exact fields, `check_contains` for the comma-joined `lockfiles` and `cache-paths`).
4. Writes a step summary.

### Common issues

| Issue | Cause | Fix |
| --- | --- | --- |
| "Service not found" | A layer missing from the composition | Add the matching `X.layerTest({ … })` |
| A double dies mid-test | An unstubbed member was called | Stub it — or ask whether the code should be calling it |
| Input reads as absent | A hand-written `INPUT_*` spelling | Key by input name through `ActionInput.layer` |
| Green unit test, red runner | A state or envelope schema whose encoded form is not JSON | Round-trip it through the real `ActionState` harness |
| Passes locally, fails in CI | Platform branching | Pass an explicit `host` / `platform` and pin both |
| An e2e assertion passes suspiciously | Empty actual against a non-empty expected | Already fixed in the harness; if it recurs, fix the harness first |

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) — the pipeline under test and the seams that make it testable.
- [Effect service model](./effect-service-model.md) — the step contract, error taxonomy and defaulted-parameter seams.
- [Caching strategy](./caching-strategy.md) — the state protocol the real-`ActionState` harness exists for.
- [Turbo remote cache](./turbo-remote-cache.md) — the subsystem the five e2e jobs exercise.
- [Build and distribution](./build-and-distribution.md) — how the local copy the fixtures run is produced.

**Context files:**

- [src/CLAUDE.md](../../../src/CLAUDE.md) — per-module conventions.
- [**fixtures**/CLAUDE.md](../../../__fixtures__/CLAUDE.md) — fixture inventory.
- [.github/workflows/CLAUDE.md](../../../.github/workflows/CLAUDE.md) — workflow test wiring.
