---
title: "A `Closes #N` trailer merged into `dev` does not close the issue"
description: Why a PR body's Closes trailer silently fails to auto-close its issue when the PR merges into dev instead of main, and what to do instead.
type: Gotcha
status: draft
stale_after: 2027-03-13T00:00:00Z
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 1e470e689d3b4fa5dd060a37276b1f5e7b90066ee49ed18b669c6960875becf8
resource: ../../.github/workflows/branch-sync.yml
sources:
  - id: branch-sync
    resource: ../../.github/workflows/branch-sync.yml
  - id: github-closing-keywords
    resource: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/linking-a-pull-request-to-an-issue
tags:
  - release
  - dx
---

# A `Closes #N` trailer merged into `dev` does not close the issue

A contributor who writes `Closes #N` in a PR body, watches the PR merge, and moves on will
conclude the linked issue closed automatically the way it does on every other repository they
have worked in. What is actually true here: GitHub only auto-closes a linked issue when the
closing PR merges into the repository's **default branch**, and ordinary work in this
repository targets `dev`, which is not the default branch — `main` is, and `main` only moves
forward through the release flow that `branch-sync.yml` participates in (`sync-dev` triggers
on `push: [main]`, not on a merge into `dev`).[^branch-sync][^github-closing-keywords] A PR
merged into `dev` with a `Closes #N` trailer leaves the issue open, silently, with nothing in
the merged PR's UI or the issue itself indicating that the automation did not fire.

## What actually happened

Two issues were left silently open this way before the gap was noticed: the PRs merged into
`dev` carrying valid `Closes #N` trailers, the trailers rendered as linked issues in the PR
UI exactly as expected, and the issues simply never closed because the merge target was never
`main`.

## What to do about it

Close the issue **by hand** after merging into `dev`, with a comment pointing at the merge
commit, rather than trusting the trailer to have done it. Keep the `Closes #N` trailer in the
PR body anyway — it still renders the link in GitHub's UI immediately, and it is what fires
for real later, automatically, when that same commit reaches `main` through the release flow
(`dev` -> `main` -> the release PR -> the actual auto-close). The trailer is not wrong to
write; the assumption that merging into `dev` is the same event as merging into the default
branch is the trap.

See [the release runbook](../runbooks/release.md) for the `dev` -> `main` -> release sequence
this trailer eventually rides through, and
[branch-sync by content, not commits](../decisions/branch-sync-by-content-not-commits.md) for
why `dev` and `main` are kept in agreement the way they are.

[^branch-sync]: branch-sync
[^github-closing-keywords]: github-closing-keywords
