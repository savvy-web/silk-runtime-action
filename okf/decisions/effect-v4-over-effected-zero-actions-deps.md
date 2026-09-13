---
title: Effect v4 over the @effected suite, zero @actions/* dependencies
type: Decision
status: draft
description: Why the action is built on Effect v4 and the first-party @effected suite instead of @actions/*, and why that leaves it with zero @actions/* dependencies.
tags: [architecture, deps, dx]
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 10910ed6c46b082a5c6ec9de900343d2bb570fab2871388502a7bdd3b2f9f651
sources:
  - id: package-json
    resource: ../../package.json
  - id: layers-app
    resource: ../../src/layers/app.ts
---

# Effect v4 over the @effected suite, zero @actions/* dependencies

## Context

This action reads runtime and package-manager configuration from a single
`package.json` `devEngines` field and provisions Node, Bun and Deno, the pinned
package manager, dependency installs, and optional Biome/BATS/kcov/turbo-cache
tooling — all from inside a GitHub Actions runner process. Every side effect
that touches the runner (inputs, outputs, cache, logging, process spawning,
tool download) needs a typed, testable seam, and the runner protocol itself
(`INPUT_*`/`OUTPUT_*` mangling, the cache and blob-storage wire formats, the
tool-installer contract) has to be implemented by something.

## Decision

Build on Effect v4 (via `catalog:effect`) and the first-party `@effected/*`
suite — `@effected/github-actions` for every GitHub Actions runtime
interaction, plus `@effected/npm`, `@effected/semver`, `@effected/jsonc`,
`@effected/lockfiles`, `@effected/workspaces` and `@effected/commands`
(`package.json`'s `dependencies` block declares `@effect/platform-node`,
`@effected/github-actions` and `effect` all under `catalog:effect` /
`catalog:effected`[^package-json]). `@effected/github-actions` implements the
runner protocol — inputs, outputs, cache, blob storage, tool installation,
process handling — natively over core `effect` platform APIs, so the action
carries **zero `@actions/*` dependencies**, direct or transitive.

In Effect v4 the former `@effect/platform` is dissolved into core `effect`:
`FileSystem`, `Path` and `HttpClient` all import from `effect` itself, and
only the Node platform layers (`NodeFileSystem`, `NodeHttpClient.layerUndici`)
ship separately, in `@effect/platform-node`. `layers/app.ts` composes exactly
two extra services on top of what `ActionRuntime.layer` already
provides — `ActionCache`, `PackageManagerInstaller` and `ToolInstaller` for
`MainLive`, `ActionCache` alone for `PostLive`[^layers-app] — because
`Action.run`'s own runtime layer already supplies `ActionEnvironment`,
`ActionLogger`, `ActionOutputs`, `ActionState`, `HttpClient` and the Node
service bundle.

Every `@effected/*` package here is first-party (`spencerbeggs/effected`), so
a missing API or a bug surfaces upstream and gets fixed in that repository,
then dogfooded into this one before it publishes, rather than worked around
locally with a patch or an override.

## Alternatives rejected

- **`@actions/*` toolkit (`@actions/core`, `@actions/cache`, `@actions/tool-cache`,
  …).** Would reintroduce the exact dependency surface `@effected/github-actions`
  exists to replace: untyped inputs/outputs, no typed error channel, and a
  second implementation of the cache and tool-cache protocols to keep in sync
  with the kit's own. Also reopens the version-conflict and override problems
  the zero-`@actions/*` posture is meant to close.
- **Effect v3.** Ruled out because the `@effected/*` suite this action depends
  on targets v4: `Context.Service` class-based services, `Data.TaggedError`,
  and the platform-dissolved-into-core module layout are v4-only shapes, and
  writing against v3 would mean carrying a second, incompatible mental model
  of the same primitives (`Either` vs. `Result`, `catchAllDefect` vs.
  `Effect.catchDefect`) for no benefit.
- **A hand-rolled runner-protocol shim over raw `fetch`/`fs`.** Would have to
  reimplement the cache restore/save wire format, the blob-storage protocol
  the embedded turbo cache depends on, and the tool-installer's find-first
  cache-hit logic — all of which `@effected/github-actions` already owns and
  tests.

## Consequences

- A capability this action needs but the kit does not yet have is a request
  upstream, not a local workaround — kept honest by the dogfood-mailbox
  protocol between this repository and `spencerbeggs/effected`.
- The dependency surface stays auditable: every `@effected/*` package declared
  in `package.json` is either imported directly under `src/` or a required
  peer of one that is (the one peer-only entry, `@effected/yaml`, is a
  dependency of `@effected/lockfiles`) — see
  [dependency honesty](../conventions/dependency-honesty.md).
- Every `@effected/*` and `effect` version is resolved through `catalog:effect`
  / `catalog:effected`, never a hand-written range, so the installed version
  lives in `pnpm-lock.yaml`'s `catalogs:` block and nowhere else — a version
  cited in prose goes stale the next bump.
- Because the runner protocol is implemented natively, this action has no
  `@actions/*` version to track for CVEs or breaking changes, and no pnpm
  override or patch to maintain against one.

[^package-json]: ../../package.json
[^layers-app]: ../../src/layers/app.ts
