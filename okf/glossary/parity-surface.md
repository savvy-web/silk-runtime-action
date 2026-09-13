---
type: Glossary
title: Parity surface
description: What a consumer observes and this repository's tests pin verbatim — action.yml's inputs and outputs, plus the exact log and job-summary prose — as distinct from internal shapes that are free to change.
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 17c4ba67b7949d8cac8af178c81b03d23898e3db51c1275e48f4ba9664184cc6
sources:
  - id: inputs-test
    resource: ../../__test__/unit/schema/inputs.test.ts
  - id: outputs-test
    resource: ../../__test__/unit/schema/outputs.test.ts
  - id: format-test
    resource: ../../__test__/unit/summary/format.test.ts
  - id: format
    resource: ../../src/summary/format.ts
  - id: state
    resource: ../../src/state.ts
  - id: cache-config
    resource: ../../src/steps/cache-config.ts
tags:
  - testing
  - dx
---

# Parity surface

In this repository, "parity surface" means specifically what a consumer of the action
observes from outside it, and what the test suite therefore pins to an exact value rather
than merely asserting shape:

- **`action.yml`'s inputs and outputs.** `INPUT_NAMES` is cross-checked against the file
  itself by parsing its `inputs:` block directly, so the two cannot drift apart without a
  test failing; the same guard exists for outputs, closing what one test's own comment calls
  "the unguarded half of the parity contract" — the inputs side had this check first, and the
  outputs side went unguarded until it was added.[^inputs-test][^outputs-test]
- **The log and job-summary prose**, defined once in `summary/format.ts` (`formatDetectLine`,
  `formatTurboLine`, `cacheCell`, `buildRuntimeSummary`, and the `cacheLine` /
  `isExactHit` facts each of those formatters draws from) and pinned
  **codepoint-verbatim** — including exact punctuation and separator characters — in
  `__test__/unit/summary/format.test.ts`, because that text is precisely what a consumer sees
  in their own workflow log and job summary.[^format][^format-test]

## What is NOT parity surface

Several internal shapes look like they should matter to a consumer and deliberately do not,
because nothing external ever reads them directly:

- **`STATE_KEYS` values** (`src/state.ts`) — the literal strings a cross-phase state entry is
  saved and read under are private to this action's own `main`/`post` handoff.[^state]
- **Cache-key layout** (`src/steps/cache-config.ts`) — the exact digest format, segment
  order, and separators of a cache key are an implementation detail of how this action finds
  its own cache entries, not a promise any consumer's workflow depends on.[^cache-config]
- **The `"empty"` no-lockfile placeholder** — a spelling chosen because the kit's key
  primitive refuses an empty segment, not a value any consumer reads or compares against.

## Where the ecosystem differs

Outside this repository, "parity" more often means behavioral parity between two
implementations of the same interface — for example, a rewrite matching a legacy tool's
observable behavior in general. Here the term is narrower and more literal: it names the
*specific set of surfaces* — `action.yml`'s declared contract and rendered prose — that a
consumer can observe and that a test therefore pins exactly, as distinct from every other
internal shape this action is free to change without notice. The convention that follows
from this definition — one formatter per fact, pinned verbatim — lives at
[prose is parity surface](../conventions/prose-is-parity-surface.md).

[^inputs-test]: inputs-test
[^outputs-test]: outputs-test
[^format]: format
[^format-test]: format-test
[^state]: state
[^cache-config]: cache-config
