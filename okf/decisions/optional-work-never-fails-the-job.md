---
title: Optional work never fails the job
type: Decision
status: draft
description: Cache restore, Biome/BATS/kcov installs, the turbo cache server and the whole post phase all degrade to a warning rather than failing the workflow, and auto-detected optional work degrades harder than explicitly requested work.
tags: [architecture, dx, caching, observability]
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: c4b2fdfe2bdbc542245319613e42289a8ba42181e44a520c4cde95a852795a89
sources:
  - id: restore-cache
    resource: ../../src/steps/restore-cache.ts
  - id: program
    resource: ../../src/program.ts
  - id: post
    resource: ../../src/post.ts
  - id: turbo-cache-step
    resource: ../../src/steps/turbo-cache.ts
---

# Optional work never fails the job

## Context

Several pieces of this action's work are enhancements a consumer's build does
not strictly need to succeed: restoring a dependency cache, installing
Biome/BATS/kcov, and starting the embedded turbo remote-cache server. BATS
and kcov are additionally **auto-detected** — a repository that never asked
for either by name can end up with both installed because one stray `.bats`
fixture was enough to trigger the glob signal. Any of these failing for
reasons unrelated to the actual build (a flaky download, a compiler missing
on an unusual runner image, a cache backend misconfiguration) should not be
what turns a workflow red.

## Decision

Every optional operation degrades to a warning through its own mechanism,
never a shared catch-all:

- **Cache restore** absorbs every internal failure through one `absorb`
  helper (`src/steps/restore-cache.ts:114`) and answers with a miss-shaped
  `CacheState` rather than propagating[^restore-cache].
- **Biome, BATS and kcov installs** are each caught at their call site in
  `program.ts`, folding to `Option.none()` and logging a warning naming the
  step and the error's message[^program].
- **`startTurboCache`** self-catches its own typed channel *and* defects,
  answering `DISABLED`[^turbo-cache-step].
- **The whole post phase** catches typed failures and defects across three
  independent branches — the turbo-server reap, the dependency-cache save,
  the kcov-cache save — so a failure in one costs neither of the others its
  work[^post].

For BATS and kcov specifically, the auto-detection is the sharper argument
for this posture, not just a restatement of "it's optional." A repository
that never opted in by name must not be able to lose a build to a kcov
compile failure on an unusual runner image, or to a helper library's tarball
returning a 404 — the consuming workflow's own test step is what should go
red if tooling it genuinely needs is missing, and `vitest-bats` already
reports a missing dependency clearly on its own. The cost of a bad
auto-detection is therefore bounded to *time* — a wasted install attempt —
never a red build.

## Alternatives rejected

- **Fail the job on any install failure, since a consumer explicitly asked
  for the feature.** Rejected even for explicitly requested Biome/BATS/kcov:
  none of the three tools is invoked by this action itself, so an install
  failure here means only that a *later*, consumer-owned step will discover
  the absence and fail on its own terms — this action failing first would
  just move the red X to a less informative place in the log. (This posture
  is deliberately not extended to `loadConfig`, `installRuntimes`,
  `setupPackageManager` or `installDependencies`, which stay fatal because
  nothing downstream can proceed without them.)
- **One shared top-level `catchAll` around the whole pipeline.** Would hide
  which specific step degraded and why, collapsing the failure posture table
  to a single line and losing the per-step warning a consumer needs to
  diagnose which tool did not install.
- **Skip auto-detection entirely and require an explicit `bats: true` /
  `kcov: true`.** Would remove the one-`.bats`-file convenience this feature
  exists to provide, trading detection ergonomics for a marginal reduction in
  wasted install attempts that non-fatal demotion already makes cheap.

## Consequences

- A consumer reading the log sees a warning naming exactly which optional
  feature degraded and why, rather than either silence or a job failure that
  points at the wrong cause.
- **Recorded deviation, carried deliberately:** cache state is persisted even
  after a failed restore, so the post phase still saves what this run
  installed — a run that misses its cache leaves the *next* run cold too,
  matching legacy behaviour, rather than compounding the miss by also losing
  the save.
- **Recorded cost, carried deliberately:** `post` runs even when `main`
  failed partway through, so an install that died mid-way can seal a
  half-populated `node_modules` under the primary cache key. Fixing this
  would require `main` to leave a completed marker `post` can check — a
  hardening pass of its own, not yet done.

[^restore-cache]: ../../src/steps/restore-cache.ts
[^program]: ../../src/program.ts
[^turbo-cache-step]: ../../src/steps/turbo-cache.ts
[^post]: ../../src/post.ts
