---
title: "`defaults.run.working-directory` does not reach a `uses:` step"
description: A composite or Docker uses step always executes at GITHUB_WORKSPACE regardless of a job's defaults.run.working-directory, so a fixture-scoped action step installs the wrong repository's dependencies unless told not to.
type: Gotcha
status: draft
stale_after: 2027-03-13T00:00:00Z
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 1e09678e9f54e51597c816a88e2b6fb7099557ef77dbfe3fee66e2397baf384e
resource: ../../.github/workflows/test-turbo-cache.yml
sources:
  - id: test-turbo-cache-yml
    resource: ../../.github/workflows/test-turbo-cache.yml
tags:
  - ci
  - testing
---

# `defaults.run.working-directory` does not reach a `uses:` step

## What a reader sees

`test-turbo-cache.yml`'s jobs each set `defaults.run.working-directory:
__fixtures__/turbo-monorepo`, then run `uses: ./.github/actions/local` — this repository's
own bundled action — followed by `run:` steps that build and assert against the fixture.[^test-turbo-cache-yml]
A job-level `defaults.run.working-directory` reads as scoping *every* step underneath it to
the fixture directory, `uses:` steps included.

## What that leads you to conclude

That the action step, like the `run:` steps around it, executes inside
`__fixtures__/turbo-monorepo`, discovers that fixture's `package.json`, and installs *its*
dependencies — the ones the e2e test actually wants provisioned before the fixture's own
build and assertion steps run.

## What is actually true

A `uses:` step — whether a composite action, a Docker action, or a JavaScript action —
**always executes at `GITHUB_WORKSPACE`, the repository root, regardless of
`defaults.run.working-directory`**. Only `run:` steps honor that default.[^test-turbo-cache-yml]
Before this was accounted for, the turbo e2e's `uses: ./.github/actions/local` step installed
*this repository's own* dependencies instead of the fixture's — a real, silent scope
mismatch, not a hypothetical one.

The fix carried at every fixture-scoped `uses:` step in this workflow is
`install-deps: "false"`, paired with a `run:` step below it that performs the fixture's own
install and *does* honor the working-directory default:

```yaml
# `install-deps: false` because a `uses:` step does not honour
# `defaults.run.working-directory` — the action always executes at
# GITHUB_WORKSPACE. Left on, its install step would install the *action
# repo's* dependencies, which is never what this workflow wanted; the
# fixture is installed by its own `run:` step below, which does honour the
# default. Turbo detection and the cache server are unaffected.
- uses: ./.github/actions/local
```

That comment and pattern repeat at `.github/workflows/test-turbo-cache.yml:21-27` (job 1),
again ahead of the `uses:` step in the cross-job cache-hit job, and again in the S3-backed
jobs — every fixture-scoped `uses:` step in the file pairs `install-deps: "false"` with a
`run:` step that performs the real install.[^test-turbo-cache-yml] Turbo detection and the
embedded cache server are unaffected by disabling the dependency install, because both read
the fixture's `turbo.json` and lockfiles directly rather than depending on what the action's
own install step would have provisioned.

The rule this leaves behind: a `uses:` step's effective working directory is never a job
default, and any assumption that a composite/Docker/JS action step operates "wherever the
surrounding `run:` steps do" needs a `working-directory` input on the action itself (when the
action exposes one) or an explicit disable of whatever the action would otherwise do at
`GITHUB_WORKSPACE`.

[^test-turbo-cache-yml]: test-turbo-cache-yml
