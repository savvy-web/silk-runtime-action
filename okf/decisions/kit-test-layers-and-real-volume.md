---
title: Kit test layers over hand-rolled mocks, and a real in-memory filesystem
description: Why unit tests use the kit's partial-override test layers instead of local mocks, why they live in __test__/ rather than beside source, and why the filesystem double is a real volume rather than a stub.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 7286ba00d4eb3adb08b03420de2b8d2da95d3dd6bde0b5b1ee7b01e0bbff5558
sources:
  - id: state-test
    resource: ../../__test__/unit/state.test.ts
  - id: install-bats-test
    resource: ../../__test__/unit/steps/install-bats.test.ts
  - id: vitest-config
    resource: ../../vitest.config.ts
tags:
  - testing
---

# Kit test layers over hand-rolled mocks, and a real in-memory filesystem

## Context

Every side effect in this action flows through a service from `@effected/github-actions` or
core `effect`, so the test suite's trust in a double is trust in the service composition
itself. A hand-rolled mock can drift from the shape of the service it stands in for, and a
double that is more permissive than the runner it replaces has already shipped a production
bug once, in the filesystem specifically.

## Decision

**Kit test layers over hand-rolled mocks.** `@effected/github-actions` exports a
`layerTest` factory per service, taking partial overrides — `ActionCache.layerTest({...})`,
`ActionState.layerTest({...})`, `ActionOutputs.layerTest({...})`, `ActionEnvironment.layerTest({...})`,
`ActionInput.layer({...})`, `ToolInstaller.layerTest({...})`, `PackageManagerInstaller.layerTest({...})`,
`BlobStore.layerTest({...})`. The doubles ship with the services, so they cannot drift from a
shape they are defined against, and a partial override means a test declares exactly the
surface it depends on. **An unstubbed member dies on use, and that is the design**: a step
that starts calling a service it should not is a design change, and the test should say so
rather than silently succeeding against a permissive stub.

A hand-written override on the same `layerTest` call is how a specific failure is injected —
a `restore` that fails with a typed error, a download that 404s — there is no separate mock
idiom, and the resulting layer is still type-checked against the real service shape. Inputs
are keyed by **input name** (`"biome-version"`), never by a runner variable spelling, because
the provider is dual-accept and no test needs to know that the runner writes
`INPUT_BIOME-VERSION` with the hyphen intact.

Cross-phase state is the one place a kit test **double** is deliberately not trusted alone:
`state.test.ts` builds its layer from the **real** `ActionState.layer`, pointed at a scoped
temp state file for the `main`-phase half and re-seeded from a republished environment for
the `post`-phase half, rather than from `ActionState.layerTest`. An in-memory double hands the
encoded object straight back and round-trips schemas that JSON cannot, which is exactly the
bug this harness exists to catch.[^state-test]

**Tests live in `__test__/`, never co-located with source.** Two reasons: `vitest.config.ts`'s
coverage `include: ["src/**/*.ts"]` stays a clean statement about production code with no test
files mixed in, and the bundler never has to reason about test files sitting beside entry
points it compiles.[^vitest-config] The tree mirrors `src/` so the mapping between a source
module and its test file is mechanical rather than a lookup.

**Purity as a testing strategy.** Roughly half the behavior worth testing lives in pure,
service-free modules — cache-key derivation, summary formatting, turbo-cache activation and
metadata, and every runtime descriptor. Those need no layer at all, which is what lets a test
running on one platform pin another platform's store paths, arch segment, or shell-launch
behavior without a runner, a filesystem, or a monkey-patched `process`.

**Two tiers, and what each is for.** Unit tests catch logic fast and are the only place a
failure path is cheap to exercise. Some things are provable only on a real runner and each
was a live bug once: the Windows tool-cache layout and `.cmd` shell launch; the
lifecycle-script `PATH` a `postinstall` needs; the cache round trip against the real service;
and `bats_load_library` resolving through an exported environment variable in a later
workflow step, which also proves a synthesized loader survived minification into `dist`. The
fixture and e2e matrices are the pin for all of these.

### The filesystem is a real volume

The filesystem double is `@effected/memfs`'s `MemoryFileSystem`, not a hand-rolled stub, and
there are zero `FileSystem.layerNoop` sites left in the suite. Three constructors cover
everything a test needs:

| Constructor | Use |
| --- | --- |
| `MemoryFileSystem.layerWith(seed)` | a volume pre-populated with files and directories |
| `MemoryFileSystem.layer` | an empty volume |
| `MemoryFileSystem.layerFaulty(faults).pipe(Layer.provide(volume))` | an injected failure, or a delegating recorder over a real volume |

`install-bats.test.ts` composes a faulty layer over a seeded volume to inject a copy failure
during bats-mock loader synthesis, which is the shape every fault-injection test in the suite
follows.[^install-bats-test] **Fault handlers delegate when they return `undefined`**, which
is what makes the recorder pattern work: a handler records the path it was asked about,
returns `undefined`, and the underlying volume answers for real — so a test can observe
*which* paths a step probed without also having to simulate what it finds there.

This changes what a filesystem-shaped test proves. Under a hand-stubbed `FileSystem`, an
absent file was a stub author's decision; under a real volume, it is the volume's own honest
answer, produced by the same code path the real thing uses. Three behavioral differences
surfaced during the conversion from hand-rolled stubs to the real volume, and each is a case
where the old double had been quietly more permissive than reality:

- `readFileString` is derived from `readFile`, so a `NotFound` on a string read names
  `readFile` as the failing method — matching the real Node filesystem's own report, and
  requiring a test that had asserted the string-level method name to be corrected.
- `FileSystem.copy` refuses an existing destination by default (`errorOnExist`). A step that
  created its destination directory and then copied into it without `{ overwrite: true }`
  would **silently fail to provision** on a warm second invocation within one job — a bug the
  hand-stubbed `copy` it replaced had no opinion about existing destinations and could not
  have caught at any level of test effort.
- `readDirectory("/")` on a fresh volume is not empty; it includes a pre-created `tmp`
  directory, so any assertion about the root's contents has to account for it.

The second of those is the argument for the whole conversion in one line: the bug was in
production, the unit suite was green, and the reason it was green is that the old double was
a **simplification** of the filesystem interface rather than an **implementation** of it.

**Assertions are `assert.*`**, chai-style from `@effect/vitest`, not `expect`. One gotcha
rides along: `assert.deepStrictEqual` compares prototypes and `expect(...).toEqual` does not,
so a decoded `Schema.Class` instance cannot be compared against an object literal — its
fields have to be asserted individually instead.

## Alternatives rejected

- **Hand-rolled mocks per service**, built and maintained locally instead of shipped with the
  kit. Nothing keeps a hand-written double's shape aligned with the real service as it
  evolves; the kit's `layerTest` is generated from the same source the production layer is.
- **A permissive default for every unstubbed member** (returning a benign default instead of
  dying). Would let a step start calling a service it should not without any test noticing.
- **Co-locating tests with source.** Would put test files inside the coverage `include` glob's
  natural reach and hand the bundler files it never needs to compile.
- **A hand-stubbed `FileSystem`**, kept after the memfs conversion for speed or familiarity.
  Already shown to hide at least one production bug (`copy` onto an existing destination) that
  no amount of additional hand-stubbing effort would have caught, because the stub was a
  simplification of the interface rather than an implementation of it.
- **`expect`-style assertions.** Would lose the chai-style `assert.*` surface `@effect/vitest`
  is written against and the prototype-sensitive `deepStrictEqual` behavior this suite relies
  on to catch a `Schema.Class` compared against a plain object.

## Consequences

A test that stubs only what the code under test should touch turns any unexpected service
call into a loud, immediate failure rather than a silent pass. Filesystem-shaped tests prove
platform behavior rather than a stub author's assumptions about it, at the cost of a test
occasionally needing correction when the real volume's answer differs from what a prior
hand-rolled double had assumed — which is the mechanism, not a defect in it.

[^state-test]: state-test
[^install-bats-test]: install-bats-test
[^vitest-config]: vitest-config
