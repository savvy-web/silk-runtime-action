---
type: Convention
title: Prose is parity surface
description: One formatter per fact, kept in a pure module, and pinned codepoint-verbatim against action.yml and the emitted prose because a consumer reads it as a contract.
tags: [testing, dx]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: ed0cdfa143030dacec2b1e8fb376d48848ec59232678dbdc5bac10bc41c90eb4
sources:
  - id: format-src
    resource: ../../src/summary/format.ts
  - id: restore-cache-src
    resource: ../../src/steps/restore-cache.ts
  - id: state-src
    resource: ../../src/state.ts
  - id: inputs-test
    resource: ../../__test__/unit/schema/inputs.test.ts
  - id: outputs-test
    resource: ../../__test__/unit/schema/outputs.test.ts
  - id: format-test
    resource: ../../__test__/unit/summary/format.test.ts
  - id: action-yml
    resource: ../../action.yml
  - id: inputs-src
    resource: ../../src/schema/inputs.ts
  - id: outputs-src
    resource: ../../src/schema/outputs.ts
---

# Prose is parity surface

Write one formatter per fact, keep it in a pure module, and test it — and `action.yml`
against the code — as a contract, not as incidental output. A consumer's workflow log and
job-summary panel are what change when a formatter drifts, so the prose **is** the parity
surface in exactly the sense `action.yml` is: something a consumer reads and relies on,
tested rather than merely reviewed.

## One formatter per fact

`cacheLine` in `restore-cache.ts` is the single definition of the cache tristate prose
(`exact hit (N lockfiles)`, `partial hit (…)`, `miss (…)`), and `isExactHit` in `state.ts` is
the single definition of "exact" — the `cache-hit` output, the panel cell, and the post
phase's save decision all turn on the same boolean rather than each computing their own
notion of it.[^restore-cache-src][^state-src] `formatTurboLine` renders both the step's log
line and the panel row from the same function, so the log and the summary cannot
disagree.[^format-src] Whenever a second call site needs a fact a formatter already renders,
it must call the same function rather than assembling its own string that happens to look
the same today.

## Pure modules for everything host-argument-driven

`summary/format.ts` is pure and service-free for two reasons. The first is the general one
that applies to every host-argument-driven module in this action (`steps/cache-config.ts`,
`turbo-cache/activation.ts`, `turbo-cache/meta.ts`, every descriptor): purity is what lets a
Linux test pin the Windows store paths, the arch segment, an S3 activation, and a
codepoint-verbatim log line without a runner, a filesystem, or a monkey-patched `process`.

The second reason is specific to the formatters, and it is the reason this file exists: **the
prose *is* the parity surface.** A consumer's workflow log and job-summary panel are what
change when a formatter drifts, so the formatting logic lives in one module a test can pin
verbatim, rather than being inlined at each of the call sites that emit it. A change to one
of these strings is a change to what a human or a CI log-scraper reads, not an internal
refactor, and it should be reviewed and tested with that weight.

## The parity guards

### Inputs

`__test__/unit/schema/inputs.test.ts` parses `action.yml` directly — a deliberate five-line
parse rather than a YAML dependency, because reading the file for real is what makes the
guard bite — and compares three sets: the names declared in `action.yml`, the `INPUT_NAMES`
tuple in `src/schema/inputs.ts`, and the names `loadInputs` actually asks the provider
for.[^inputs-test][^action-yml][^inputs-src]

The third set comes from a `Proxy` over the environment that records every lookup. Since the
provider became dual-accept, one input costs two probes, and a key already spelled as a
runner variable is probed as `INPUT_INPUT_…` before being found as itself. **Repeated
prefixes are stripped in the proxy** rather than added to the expected set — widening the
expected set instead would have made the exhaustiveness assertion vacuous, since a widened
set can absorb almost any probe pattern without ever failing.

### Outputs

`__test__/unit/schema/outputs.test.ts` runs the same `action.yml` cross-check against
`OUTPUT_NAMES` in `src/schema/outputs.ts`, and additionally pins the **mapping**: a fixture
whose 22 values are distinct from each other and from every default proves that swapping any
two model fields fails, so `emitOutputs` cannot quietly publish `bun-version` under
`deno-version` — or `bats-version` under `kcov-version`, in a block of near-identical `set`
calls that grew by six with the BATS work.[^outputs-test][^outputs-src]

### Prose

`__test__/unit/summary/format.test.ts` pins every formatter **codepoint-verbatim** against
the legacy surface — including the middle dot `·` (U+00B7), the panel's emoji cells, and the
two deliberately unharmonized separator conventions (a space in the detect line and the
panel, an `@` in the log groups).[^format-test] The prose is what a consumer sees, so it is
parity surface and is tested as such, exactly as `action.yml`'s declared inputs and outputs
are.

## `action.yml` is checked against the code, not the other way around

`INPUT_NAMES` and `OUTPUT_NAMES` are const tuples in `src/schema/` that tests check against
`action.yml` itself, rather than the reverse — `action.yml` is the ground truth a consuming
workflow reads, and the tuples are what must track it. Both halves of the contract are
guarded this way: a declared input or output that the code no longer reads or writes is a
test failure, and so is code that reads or writes one `action.yml` never declared.

## See also

- [`../glossary/parity-surface.md`](../glossary/parity-surface.md) — the term this repository
  gives to `action.yml` and the emitted prose, and what is deliberately excluded from it
  (`STATE_KEYS`, cache keys).

[^format-src]: `../../src/summary/format.ts`
[^restore-cache-src]: `../../src/steps/restore-cache.ts`
[^state-src]: `../../src/state.ts`
[^inputs-test]: `../../__test__/unit/schema/inputs.test.ts`
[^outputs-test]: `../../__test__/unit/schema/outputs.test.ts`
[^format-test]: `../../__test__/unit/summary/format.test.ts`
[^action-yml]: `../../action.yml`
[^inputs-src]: `../../src/schema/inputs.ts`
[^outputs-src]: `../../src/schema/outputs.ts`
