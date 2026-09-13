---
title: A workflow trigger filter that matches no branch fails open into silence
description: A typo'd branch name in an on.pull_request.branches filter produces no error, no skipped job and no annotation — the matrix simply never runs against that branch.
type: Gotcha
status: draft
stale_after: 2027-03-13T00:00:00Z
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 5429cce0449be33816d86e7a6e0ae33e74e08cb2e3236fd433c43007426c7395
resource: ../../.github/workflows/test.yml
sources:
  - id: test-yml
    resource: ../../.github/workflows/test.yml
tags:
  - ci
---

# A workflow trigger filter that matches no branch fails open into silence

## What a reader sees

`test.yml`'s `Fixtures` workflow triggers on `pull_request` into three branches:
`main`, `dev`, and `changeset-release/main`.[^test-yml] The `.github/workflows/CLAUDE.md`
that walks through it reads as complete — a named third branch, a matrix of jobs, a
summary — and nothing in the workflow file, the Actions UI, or a release PR's checks tab
calls out anything wrong with it.

## What that leads you to conclude

That because the branch name is present and spelled with intent, the fixture matrix runs on
every pull request into that branch — in particular, on the automated changeset release PR,
the one PR in this repository's flow that a human is least likely to eyeball line by line
before merging.

## What is actually true

For a while, that third entry was spelled `changesets-release/main` — plural `changesets`,
the way the npm package is named — while the branch changesets tooling actually creates is
singular: `changeset-release/main`, matching how `release.yml` refers to it.[^test-yml]
GitHub Actions raises **no error, no skipped-job marker, and no annotation** when a
`branches:` entry in an `on:` filter matches zero branches in the repository — the filter
entry is simply inert. The workflow file looked fully configured the entire time: valid
YAML, a plausible branch name, three-way `branches:` list. The fixture matrix silently never
ran against a single release PR until the typo was fixed in #348. Verify the current
spelling directly — `.github/workflows/test.yml:11` reads `changeset-release/main`, matching
what changesets itself creates.[^test-yml]

The general shape behind this specific defect: **a trigger filter fails open into silence**.
An `on:` branch list, a `paths:` glob, a matrix `include`/`exclude` entry — any filter whose
match set can be empty by mistake gives no feedback when it is. The only way to catch it is
to check the literal string a filter names against the tool, script, or process that actually
produces that name, rather than trusting that the filter compiles and runs at all as proof it
matches something.

[^test-yml]: test-yml
