---
title: Adopt a first-party release after a dogfood round
description: How to take a released version of an @effected/* package or the github-action-builder out of a dogfood link and back onto its published range, verified on a cold registry install.
type: Runbook
status: draft
resource: ../../pnpm-workspace.yaml
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: ba0285db726a5143b97e78b4b9aee3d404655f6d9e2618b050a09978dd2e35bf
sources:
  - id: pnpm-workspace
    resource: ../../pnpm-workspace.yaml
  - id: claude-md
    resource: ../../CLAUDE.md
tags:
  - deps
  - release
---

# Adopt a first-party release after a dogfood round

Every `@effected/*` dependency and `@savvy-web/github-action-builder` are authored in-house,
so a bug found here can be fixed in its own repo and dogfooded back before publishing, rather
than waiting on an upstream release. The dogfood mailbox protocol (mail files plus a per-loop
JSONL journal under `.claude/dogfood/`, driven by the `silk:dogfood` skill) coordinates a
request-build-handback-adopt loop between this repo and the sibling checkout — and this
runbook is the "adopt" half: what happens once the upstream package ships a released version
carrying the fix.[^claude-md]

## Trigger

An upstream release wave lands at bumped versions after a dogfood round completes — the
sibling repo has published (or is about to publish) the package(s) this repo linked during
the loop.

## Steps

1. **Confirm what is linked, by reading the tree, not by memory.** `pnpm-workspace.yaml`
   carries an `overrides:` entry only while a link is live; a clean, unlinked checkout has
   none. Every published range in this repository is `catalog:effected` or `catalog:effect`,
   resolved by the `@effected/pnpm-plugin-effect` config dependency — there is no
   hand-written caret to read a link out of, so the `overrides:` block is the one place link
   state is visible.[^pnpm-workspace][^claude-md]
2. **Take the new versions from the catalog, not from an edited range.** The `effected`
   catalog moves under `@effected/pnpm-plugin-effect`'s own release, which is itself a
   `configDependencies` entry in `pnpm-workspace.yaml`. Nothing in this repository's own
   `package.json` names an exact `@effected/*` version to bump by hand.[^pnpm-workspace]
3. **Unlink and remove the `overrides:` entry.** Links are added lazily, for one round, and
   removed before push — this is not deferred cleanup, it is the state the checkout must be
   in before the next step can mean anything.[^claude-md]
4. **`pnpm install`** against the now-unlinked catalog resolution.
5. **`pnpm typecheck` + `pnpm test` + `pnpm build`**, in that order, against the unlinked
   install — the same three checks any other change here has to pass.
6. **Push and verify with a COLD registry install in CI, never a warm local one.** A warm
   pnpm store can still resolve a same-version, different-content package left over from the
   link, which is exactly the trap
   [`../gotchas/warm-store-masks-unlinked-typecheck.md`](../gotchas/warm-store-masks-unlinked-typecheck.md)
   describes: green locally, red in CI. **Never push while linked** — the `overrides:` entry
   has to be gone before this step, or the "cold" CI install is cold in name only.[^claude-md]
7. **Verify the version that actually landed with `npm view`, not with a pipeline's own
   report.** A build or install log can echo back the version it was told to fetch without
   proving the registry actually serves it; `npm view <package> version` (or `dist-tags`)
   is an independent read against the registry itself.

## Reference: the local checkout table and the build step

When a dogfood round is active, the sibling checkouts this repo links against are:

| Package | Local checkout |
| --- | --- |
| `@effected/*` | `../../spencerbeggs/effected/packages/<name>` |
| `@savvy-web/github-action-builder` | `../systems/packages/github-action-builder` |

Building the library in its own repo, before linking it, is `cd packages/<name> && node
savvy.build.ts --target dev`; the builder is linked with `pnpm link
../systems/packages/github-action-builder`, and anything `@effected/*` goes through the
`silk:dogfood` protocol instead of a raw `pnpm link`.[^claude-md] Library edits ship
separately, on their own branch — they are not folded into whatever branch triggered the
dogfood loop.[^claude-md]

## End state

CI is green on an unlinked checkout: `pnpm-workspace.yaml` carries no `overrides:` entry, the
installed `@effected/*` and `@savvy-web/github-action-builder` versions match what `npm view`
reports for the registry, and the cold-install CI run that exercises them has passed.

See also [`../conventions/dependency-honesty.md`](../conventions/dependency-honesty.md) for
the rule this runbook's dependency set is held to once it is unlinked, and
[`../gotchas/warm-store-masks-unlinked-typecheck.md`](../gotchas/warm-store-masks-unlinked-typecheck.md)
for the specific false-green this runbook's cold-install step exists to rule out.

[^pnpm-workspace]: pnpm-workspace
[^claude-md]: claude-md
