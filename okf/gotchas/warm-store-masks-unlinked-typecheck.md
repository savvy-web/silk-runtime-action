---
title: A green install after unlinking a dogfooded package does not mean the code still typechecks
description: Why a same-version, different-content file colon link can leave pnpm install green and the typecheck red, and why a warm pnpm store hides it locally.
type: Gotcha
status: draft
stale_after: 2027-03-13T00:00:00Z
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: df0631e73d7f9aae432f8ad5a55852148381a8051655810bc0df4ddf52b3ba87
resource: ../../pnpm-workspace.yaml
sources:
  - id: pnpm-workspace
    resource: ../../pnpm-workspace.yaml
  - id: claude-md
    resource: ../../CLAUDE.md
tags:
  - deps
  - dx
---

# A green install after unlinking a dogfooded package does not mean the code still typechecks

A reader who unlinks a `file:`-linked first-party package, reruns `pnpm install`, and sees it
succeed will conclude the dependency is back to its published, unlinked state and the tree is
safe to push. What is actually true: `pnpm install` only resolves versions and checks
lockfile integrity — it says nothing about whether the *content* at that version still
exports what the code imports. A `file:`-linked package that is **same-version,
different-content** against the registry (the exact shape a dogfood loop produces while a fix
is being iterated on before its own release) makes install succeed while the code no longer
typechecks the moment the link is removed, because the registry version at that version
number never had the APIs the linked content added.

## Why the install itself cannot catch this

pnpm's install step is satisfied once the lockfile's recorded version and integrity hash for
each package resolve. A `file:` override and the registry range it is standing in for can
report the *same version number* while their contents differ completely — nothing in the
install path compares the two, because there is only ever one source pnpm looks at, whichever
the current configuration points to. The only way to observe the mismatch is downstream: a
typecheck or build that references a symbol only the linked content had.

## The warm store makes it worse, not just unhelpful

A warm local pnpm store still holds the **linked package's own content** under the content
hash pnpm wrote when the link was active. Unlinking and reinstalling locally can resolve
straight back to that cached content rather than fetching the actual registry tarball, so a
local reinstall after unlinking can reproduce a tree that still typechecks — while CI, with an
empty or differently-warmed store, fetches the real registry content and fails. A green local
result after unlinking is therefore not evidence the unlinked state is safe; only a cold
install proves that, and CI's install is the only cold one available without deliberately
clearing the local store.

## The related trap: a branch's own `dist/prod` can be stale

The same shape recurs one level up the dogfood loop: an upstream branch's built `dist/prod`
output can be **older than what the registry has already published**, so pointing a link at a
sibling checkout's build artifacts instead of its published package can silently regress
against versions this repository's own `package.json` ranges already require. `npm view` on
the actual published version is the check; a pipeline's own self-report is not.

## Reading whether a link is currently live

`pnpm-workspace.yaml` carries an `overrides:` entry while any `file:` link from the dogfood
protocol is active, and carries none when it is not — there is no other way to tell, because
every declared range in `package.json` is a `catalog:effected` / `catalog:effect` reference
resolved by the `@effected/pnpm-plugin-effect` config dependency rather than a hand-written
caret a reader could compare against a known-good value. The current file has no `overrides:`
key at all.[^pnpm-workspace] The governing rule, stated once and worth repeating here: never
push while linked — unlink, restore the published range, run a **cold** install, and only
then push.[^claude-md]

See [adopting a first-party release](../runbooks/adopt-a-first-party-release.md) for the
procedure that closes a dogfood loop without leaving this trap live.

[^pnpm-workspace]: pnpm-workspace
[^claude-md]: claude-md
