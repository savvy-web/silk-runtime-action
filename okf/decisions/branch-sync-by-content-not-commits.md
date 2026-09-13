---
title: dev/main sync resets by content comparison, never by commit-level history
description: Why keeping dev even with main compares merged trees rather than commits, why the trigger is a push to main rather than a published release, and why every push is force-with-lease.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: ec48625c30bcc3f928780ef0f334e8c4c1b5ddae1630648286ea8d3b09d4f311
sources:
  - id: branch-sync
    resource: ../../.github/workflows/branch-sync.yml
tags:
  - ci
  - release
---

# dev/main sync resets by content comparison, never by commit-level history

## Context

All in-progress work lands on the long-lived `dev` branch, never directly on `main`, and
`main` always reflects the last released state. Once a release PR merges into `main`, `dev`
has to be brought back in line with it — but `main`'s ruleset allows only squash merges, and
a naive commit-level "is this merged?" check cannot see through one.

## Decision

`.github/workflows/branch-sync.yml` names `dev`/`main`, three jobs, one concurrency group:
`sync-dev` evens `dev` out with `main`, `major-tag` moves the `v<major>` alias tag on a
published stable release, and `promote` opens or refreshes the `dev -> main` PR after a
`pnpm/config-deps` merge into `dev`. All three mutate the `dev`/`main` relationship and
therefore share one `branch-sync` concurrency group so they cannot race.[^branch-sync]

**`sync-dev` keys off a push to `main`, not off a published release.** A push to `main` that
produces no release — a dependency promotion with no changeset, the common case once
config-dependency bumps flow through `promote` — still has to even the branches out, and a
release-only trigger would miss exactly that case. Merging `changeset-release/main` is
itself a push to `main`, so the release path is still covered by the broader
trigger.[^branch-sync]

**`dev` is never blindly clobbered.** The job asks the only question that matters — would
resetting `dev` lose work? — by merging `dev` into `main` **in memory** with
`git merge-tree --write-tree` and comparing the resulting tree to `main`'s own tree:

```bash
main_tree="$(git rev-parse "${main_head}^{tree}")"
merged_tree="$(git merge-tree --write-tree "$main_head" FETCH_HEAD 2>/dev/null || true)"
```

Equal trees mean `dev` holds no content `main` lacks — true whether `dev` is even, strictly
behind, or was already squash-merged — and the reset is a content no-op. A `dev` that
genuinely is ahead gets **rebased** instead (`git rebase --empty=drop "$main_head"`), and a
rebase that conflicts leaves `dev` untouched with a warning rather than forcing
anything.[^branch-sync]

**Content is the source of truth because squash merges destroy patch-id equality.**
`git cherry` and every other commit-level "is this merged?" test compares patch-ids one
commit at a time, so N `dev` commits squashed into one commit on `main` match nothing and
read as unmerged work — which would make a commit-level safe path never fire on this
repository, where `main`'s ruleset allows only squash merges.[^branch-sync]

**Every push is `--force-with-lease`d against the head this job read**, via a `push_dev`
helper that leases on the `dev` sha captured at the start of the run, so a concurrent push to
`dev` aborts this sync rather than silently losing to it.[^branch-sync]

The other two jobs, briefly: `major-tag` moves the `v<major>` alias tag on
`release: [published]` (or manual dispatch naming an existing tag); `promote` opens or
refreshes the `dev -> main` PR when the `pnpm/config-deps` branch merges into `dev`, or on
manual dispatch.[^branch-sync]

## Alternatives rejected

- **A hard reset justified by "dev work always lands in main first."** That is a claim about
  process, not a check, and it is exactly the behavior this workflow replaced.
- **Keying `sync-dev` on `release: [published]`.** Misses every push to `main` that produces
  no release, which is the common case for a dependency promotion with no changeset.
- **`git cherry` or another commit-level "is this merged" test.** Compares patch-ids per
  commit, which a squash merge destroys — the exact case this repository's own branch
  protection guarantees will happen on every `dev -> main` merge.
- **Force-pushing without a lease.** Would let this job silently clobber a concurrent push to
  `dev` instead of aborting in its favor.

## Consequences

`dev` and `main` stay in content agreement without ever discarding work a human is not aware
of, at the cost of an in-memory merge-tree computation and a rebase attempt on every
divergence the tree comparison cannot resolve as a no-op. A rebase conflict is surfaced as a
workflow warning rather than resolved automatically, so `dev` can sit ahead of a clean sync
until someone rebases it by hand.

[^branch-sync]: branch-sync
