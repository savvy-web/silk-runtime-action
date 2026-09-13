---
type: Convention
title: Commit source and dist together
description: Every commit that touches src/ must also carry a rebuilt dist/ and .github/actions/local/, be GPG-signed with the maintainer's verified key, and land on dev rather than main.
tags: [release, ci]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 825d26529ee792b40fc9eb3fd4ae7498e5515f4a5165b7aa8ef11ed2189b7b36
sources:
  - id: action-config
    resource: ../../action.config.ts
  - id: root-claude-common-commands
    resource: ../../CLAUDE.md
---

# Commit source and dist together

Always commit source and compiled output together: `git add src/ dist/
.github/actions/local/`. A change to `src/` that is not rebuilt into both directories is a
change CI never runs, because GitHub Actions loads this action from the committed `dist/` at
the checked-out ref — there is no build step in the runtime.

## Rebuild before every commit

`pnpm build` is **required** before commit, not optional polish. Run it whenever `src/`
changes, then stage all three trees in the same commit: `src/`, `dist/`, and
`.github/actions/local/`. Splitting the rebuild into a follow-up commit leaves a window where
the repository's `HEAD` does not reflect what CI actually executes.

## Why two built directories exist

`action.config.ts`'s `persistLocal` option mirrors every build into
`.github/actions/local/` in the same pass that writes `dist/`.[^action-config] The two
directories serve different consumers: `dist/` is the production artifact `action.yml`
points `runs.main` / `runs.post` at, while `.github/actions/local/` is what the
`test-fixture` composite action references so fixture and e2e workflows exercise the
**built** action without needing a separate checkout or a build step inside a test job. Both
are committed, both are cleaned and rewritten by every build, and neither is optional to
commit — a `dist/` update with no matching `.github/actions/local/` update leaves the fixture
matrices testing a stale bundle.

## Signed commits, or the ruleset rejects them

Commits must be GPG-signed with the GitHub-verified key for `C. Spencer Beggs
<spencer@savvyweb.systems>`, or the repository's signature ruleset rejects the push
outright.[^root-claude-common-commands] This is enforced at the platform level, not merely
requested — an unsigned or wrongly-signed commit does not land regardless of review state.

## All work lands on `dev`, never directly on `main`

`main` always reflects the last released state. Work accumulates on the long-lived `dev`
branch and merges into `main` only when ready to trigger the release pipeline (changeset
detection, the release PR, and eventually publish). Pushing directly to `main` bypasses that
sequencing and is never the intended path for in-progress work, however small.

## See also

- [`../decisions/commit-dist-and-local-copy.md`](../decisions/commit-dist-and-local-copy.md)
  — why the artifact is bundled and committed at all, and the build pipeline that produces
  it.
- [`../runbooks/release.md`](../runbooks/release.md) — the ordered release procedure this
  convention feeds into once work reaches `main`.

[^action-config]: ../../action.config.ts
[^root-claude-common-commands]: ../../CLAUDE.md
