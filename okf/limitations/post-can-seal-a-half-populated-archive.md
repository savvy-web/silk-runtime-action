---
type: Limitation
title: post can seal a half-populated dependency cache after a failed install
description: post runs and saves the dependency cache even when main failed partway through the install, so a workflow that dies mid-install can seal an incomplete node_modules under the primary cache key.
status: draft
bounds: ../modules/silk-runtime-action.md
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 17e23768c0e008ec805be72da56dac964aad61281c419015d92beaa9bd45f926
sources:
  - id: post
    resource: ../../src/post.ts
tags:
  - caching
---

# post can seal a half-populated dependency cache after a failed install

## Trigger

`post` runs unconditionally as a GitHub Actions post step, whether or not `main` succeeded.
Its dependency-cache save (`saveDependencyCache`) only skips on an exact hit or an empty path
list — it has no way to know whether the install that populated those paths actually finished,
because nothing upstream records that fact anywhere `post` can read it.[^post]

## Symptom

A job whose install died halfway through — network failure, a lifecycle script crash, an
`install-deps` step that exits non-zero after writing part of `node_modules` — still lets
`post` run to completion. `post` sees a non-exact cache state with a non-empty path list and
saves it under the **primary** key, exactly as it would for a successful install. The next
run that would have restored an exact hit on that key instead restores an
incompletely-installed `node_modules`, and nothing in the cache-hit reporting distinguishes
this from a genuinely complete cache.[^post]

## Why this is acceptable

The alternative — `post` refusing to save whenever `main` might have failed — would need
`post` to know something about `main`'s outcome that the post-action contract does not
naturally give it, and getting that wrong in the conservative direction (skipping a save that
was actually fine) throws away a legitimate cache entry on every partial restore, which is
the common, successful case this save exists to serve. The known cost is carried
deliberately rather than guarded against with an incomplete signal.[^post]

## What a fix would take

`main` would need to leave a completed marker behind — written only once the install genuinely
finishes — for `post` to check before it saves. That is a cross-phase state addition of its
own, not a change to `saveDependencyCache`'s existing skip conditions, and it has not been
built.[^post]

[^post]: post
