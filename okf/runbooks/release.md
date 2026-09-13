---
title: Release dev to main
description: The full path from a changeset on dev to a published release, the shared workflow it delegates to, and the branch-sync jobs that keep dev and main coherent afterward.
type: Runbook
status: draft
resource: ../../.github/workflows/release.yml
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 8543639263fa22c4a7ea2452e0b6a0f597b1e1a5f26517121df51d62112b9c9e
sources:
  - id: release-yml
    resource: ../../.github/workflows/release.yml
  - id: branch-sync
    resource: ../../.github/workflows/branch-sync.yml
  - id: package-json
    resource: ../../package.json
tags:
  - release
  - ci
---

# Release dev to main

## Trigger

Work accumulated on `dev` is ready to ship. All in-progress work lands on `dev`, never
directly on `main`; `main` always reflects the last released state.

## Steps

1. **Write a changeset with `/silk:changeset`.** There is **no `changeset` script** in
   `package.json`. `pnpm exec savvy changeset` covers the rest of the lifecycle — `lint`,
   `check`, `deps`, `version` — and has no `add` subcommand of its own; authoring a new
   changeset goes through the skill, not a bare CLI invocation.[^package-json]
2. **Merge `dev` into `main`.**
3. **Phase 1 — changeset detection.** The push to `main` triggers the shared workflow
   (`savvy-web/.github/.github/workflows/release.yml@main`, delegated to by this
   repository's `release.yml`), which creates or updates the `changeset-release/main`
   branch and its release PR.[^release-yml]
4. **Phase 2 — validation on `changeset-release/main`.** Pushes to that branch run build,
   publish dry-runs, a release-notes preview, and a sticky PR comment. `release.yml` also
   listens for pull requests into `changeset-release/main` itself, alongside `main` and
   `dev`.[^release-yml]
5. **Phase 3 — merge and publish.** Merging the release PR runs the actual publish, cuts
   Git tags, and creates the GitHub release. `pnpm ci:version` — `savvy changeset version &&
   biome format --write .` — is what the workflow runs to apply the version bump, not a
   step a human runs by hand.[^package-json]
6. **`branch-sync.yml` puts the branch pair back in order.** Three jobs share one
   `branch-sync` concurrency group, all running as the GitHub App bot so their pushes bypass
   branch protection without recursing:[^branch-sync]
   - **`sync-dev`** triggers on any push to `main` (`on: push: branches: [main]`), not on a
     release being published — a dependency promotion with no changeset still has to even
     the branches out, and keying on `release` would miss exactly that case. It merges `dev`
     into `main` in memory (`git merge-tree --write-tree`) and resets `dev` only when the
     resulting tree equals `main`'s; a `dev` that genuinely holds unmerged work is rebased
     instead, and a rebase conflict leaves `dev` untouched with a warning. Every push is
     `--force-with-lease`d against the `dev` head the job read, so a concurrent push aborts
     the sync rather than losing to it.
   - **`major-tag`** moves the `v<major>` alias tag on `release: [published]`.
   - **`promote`** opens or refreshes the `dev` → `main` PR when a `pnpm/config-deps` branch
     merges into `dev`.
7. **Close linked issues by hand.** `Closes #N` in a PR body does not auto-close on a merge
   into `dev` — GitHub only auto-closes on a merge into the **default branch**, and ordinary
   work here targets `dev`. Keep the trailer in the PR body anyway (it still links the issue
   in the UI, and fires later when `dev` reaches `main`), but close the issue by hand after
   the `dev` merge, with a pointer to the merge commit.

## End state

The release is published: a Git tag and a GitHub release exist for the new version, the
`v<major>` alias tag has been moved by `major-tag`, and `dev` is even with `main` (whether by
a no-op content match or a completed rebase). Consumers reference this action as
`savvy-web/silk-runtime-action@v1`.

See also
[`../decisions/branch-sync-by-content-not-commits.md`](../decisions/branch-sync-by-content-not-commits.md)
for why `sync-dev` compares merged trees instead of commit history,
[`../gotchas/closes-does-not-fire-on-dev-merge.md`](../gotchas/closes-does-not-fire-on-dev-merge.md)
for the issue-closing trap step 7 exists to avoid, and
[`../conventions/commit-source-and-dist-together.md`](../conventions/commit-source-and-dist-together.md)
for what every commit reaching `main` through this path must already carry.

[^release-yml]: release-yml
[^branch-sync]: branch-sync
[^package-json]: package-json
