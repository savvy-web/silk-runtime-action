---
title: A hand-written test double is more permissive than the runner it replaces
description: Why a green suite over a Map-backed or hand-stubbed service double can hide a bug the real runner reports on every run.
type: Gotcha
status: draft
stale_after: 2027-03-13T00:00:00Z
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: e5ff55a0f696cc65c0c5e69307e832d8b6ca5975e110f6d6b3b54585b8e1897f
resource: ../../__test__/unit/state.test.ts
sources:
  - id: state
    resource: ../../src/state.ts
  - id: state-test
    resource: ../../__test__/unit/state.test.ts
  - id: install-bats
    resource: ../../src/steps/install-bats.ts
  - id: test-fixture
    resource: ../../.github/actions/test-fixture/action.yml
tags:
  - testing
---

# A hand-written test double is more permissive than the runner it replaces

A reader who sees a green unit suite over a hand-written service double will conclude the
behavior it exercises works on a real runner. What is actually true, repeatedly in this
repository's history: a hand-written double answers exactly what its author imagined, and a
real runner answers what the platform, the JSON round trip, or the shell actually does — and
those two answers diverge in specific, previously-shipped ways.

## The cross-phase state double hides a JSON round-trip failure

A `Map`-backed `ActionState` double hands an encoded value straight back in memory, so a
schema whose *encoded* form is not JSON-safe still passes every test built on it. `CacheState`'s
`restoredKey` field is `Schema.OptionFromNullOr(Schema.String)` rather than `Schema.Option`
specifically because `Schema.Option` encodes to an `Option` instance, which stringifies through
`Option.toJSON` to `{"_id":"Option","_tag":"Some",…}` and no longer decodes — reported as
`"Expected Option"` — on every real run, even though a `Map`-backed double round-trips it
without complaint.[^state] `__test__/unit/state.test.ts` therefore does not use a double at
all for this suite: it builds `ActionState.layer` — the real one — pointed at a scoped state
file for the `main`-phase half, and reseeds it from a **republished environment**, the way the
runner actually hands values from `main` to `post`, for the `post`-phase half.[^state-test]
Any future cross-phase state schema needs the same real-layer harness, not a double, to prove
it survives the trip.

## The hand-stubbed `FileSystem.copy` had no opinion about an existing destination

`FileSystem.copy`'s platform default is `errorOnExist`. A hand-stubbed `copy` used in an
earlier version of this suite had no opinion about an existing destination and always
succeeded, so a green suite gave no signal either way. `install-bats.ts` creates its
destination directory and then copies into it; without `{ overwrite: true }` a **warm
`~/.local/share`** — a second invocation of this action within one job — hit `errorOnExist`
and silently failed to provision bats. The real in-memory volume (`@effected/memfs`) enforces
the same rule the platform does, which is what surfaced the missing option; the fix is the
`{ overwrite: true }` at the copy call site.[^install-bats]

## Two smaller platform-shaped surprises

- `readFileString` is derived from `readFile`, so a `NotFound` on a string read names
  `readFile` as the failing method, not `readFileString` — a test that asserts the
  string-level method name is asserting the double's shape, not the platform's report.
- `readDirectory("/")` on a fresh memfs volume is not empty: it includes a pre-created `tmp`
  directory, so any assertion about the root's contents has to account for it rather than
  assuming a truly empty root.

## The e2e harness's own permissiveness

The same shape recurs one tier up, in bash-and-Python rather than TypeScript: `check_value`
and `check_contains` in the fixture harness both used to **return early on an empty actual**,
so a fixture that asserted an output the action had stopped publishing recorded a pass rather
than a failure. Both now fall through to the comparison when `expected` is non-empty, so an
empty actual against a non-empty expected fails as it should; an empty **expected** is still a
deliberate per-fixture skip, since most `expected-*` inputs default to empty.[^test-fixture]

## The general shape

Every one of these is the same lesson in a different layer: a hand-written double, or a
harness assertion with an early-return escape hatch, is strictly more permissive than the
thing it stands in for. The fix in each case was not "write a stricter stub" — it was to stop
stubbing the platform behavior at all and either exercise the real service (`ActionState.layer`),
delegate to a real implementation of the interface (`@effected/memfs`), or remove the shortcut
that let a comparison quietly not happen.

See [plain JSON cross-phase state](../conventions/plain-json-cross-phase-state.md) for the
convention this failure mode produced, [kit test layers and the real volume](../decisions/kit-test-layers-and-real-volume.md)
for the decision to use `@effected/memfs` and the real `ActionState.layer` instead of hand
doubles, and [the test harness module](../modules/test-harness.md) for where the fixture
harness itself lives.

[^state]: state
[^state-test]: state-test
[^install-bats]: install-bats
[^test-fixture]: test-fixture
