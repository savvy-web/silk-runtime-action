---
title: "spencerbeggs/effected"
description: The reference consumer and the dogfood upstream — the repository whose fixture layout, dependency provenance, and one production incident have shaped this action's cache logic directly.
type: Consumer
status: draft
repository: spencerbeggs/effected
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 2225497fde827dfb689a7751f677d8df1d416e86978a124caee190feede375cb
sources:
  - id: cache-config
    resource: ../../src/steps/cache-config.ts
  - id: claude-md
    resource: ../../CLAUDE.md
tags:
  - deps
  - testing
---

# spencerbeggs/effected

`spencerbeggs/effected` is the reference consumer of this action, and simultaneously the
dogfood upstream: every `@effected/*` package this action bundles is authored there, and the
[`adopt-a-first-party-release`](../runbooks/adopt-a-first-party-release.md) and dogfood
mailbox loop (`.claude/dogfood/`, the `silk:dogfood` skill) both run against a sibling
checkout of it.[^claude-md]

## Surfaces exercised

- **Every `@effected/*` dependency this action imports** — `ActionCache`,
  `ActionEnvironment`, `ActionInput`, `ActionLogger`, `ActionOutputs`, `ActionState`,
  `BlobStore`, `CacheKey`, `ChildEnv`, `DetachedProcess`, `GitHubMarkdown`,
  `PackageManagerInstaller`, `ProcessId`, `Secret`, `ToolInstaller`, and the peer-only
  `@effected/yaml` — comes from this repository. A bug found in any of them is fixed there
  first, before being dogfooded back through the mailbox protocol.
- **The dependency-caching logic**, indirectly: `effected`'s own package layout is what
  surfaced two of this action's cache-key decisions directly.

## Where the edge sits

`effected` implements the runner protocol (the `@effected/*` service surfaces this action
composes); this action composes that protocol into one JavaScript-runtime setup action. The
edge is a plain dependency edge in one direction — this repository is a consumer of
`effected`'s packages, never the reverse — except during an active dogfood round, when a
`pnpm-workspace.yaml` `overrides:` entry temporarily points at a local, unpublished build of
one or more packages from a sibling checkout.

## What was learned from it

**The cache-poisoning incident was observed there first.** An `install-deps: false` job's
near-empty archive won every subsequent restore under the install-policy-blind key that
predated `installSegment` — surfacing as an "exact hit" restore immediately followed by
pnpm's own `reused 0, downloaded 939`. That observation is what the install-policy token in
`cache-config.ts`'s version digest exists to prevent.[^cache-config]

**Its 41 fixture lockfiles motivated root-anchoring the lockfile patterns.** `effected`
carries forty-one lockfiles under `packages/*/__test__/fixtures/`, none of which are real
workspace lockfiles — anchoring every built-in lockfile pattern at the workspace root
(rather than globbing at any depth) is what keeps a cache key from being derived from test
fixtures instead of the actual dependency tree.[^cache-config]

**It is the reference consumer for which the `vitest-bats` glob signal never fires.** Because
`vitest-bats` generates its `.bats` files at run time and commits none of them, `effected`'s
own tree never satisfies `detect-bats`'s bounded glob — only the manifest probe (a
`vitest-bats` dependency in the root `package.json`) turns bats detection on for a consumer
shaped this way.

## Open questions

- Whether a future `@effected/*` package split changes which packages this action's
  dependency-honesty rule (every declared `@effected/*` import traced to `src/`, or a
  required peer of one that is) has to re-derive its peer closure against.
- Whether `effected`'s fixture-lockfile count staying at 41 (rather than growing without
  bound) remains a safe assumption for anyone reasoning informally about lockfile-pattern
  cost, since it is cited here as an observed number rather than a guaranteed one.

[^cache-config]: cache-config
[^claude-md]: claude-md
