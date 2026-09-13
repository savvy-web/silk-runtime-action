---
type: Project
title: silk-runtime-action
description: What this project is, its boundaries, and its non-goals.
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 8d5a3200739fa002102f3a8b84e512468009f2f261462119ec592af4520115d6
sources:
  - id: domain-schema
    resource: ../src/schema/domain.ts
  - id: program
    resource: ../src/program.ts
  - id: action-yml
    resource: ../action.yml
  - id: runtime-installation-toolchain
    resource: ../src/steps/install-bats.ts
  - id: turbo-server-entry
    resource: ../src/turbo-server.ts
  - id: turbo-cache-step
    resource: ../src/steps/turbo-cache.ts
---

# silk-runtime-action

## Purpose

This repository is a JavaScript runtime setup GitHub Action, driven entirely by the
consuming repository's own root `package.json`. It reads `devEngines.packageManager` and
`devEngines.runtime` — absolute versions only, no semver ranges — and from that one
manifest installs Node.js, Bun and/or Deno from official sources, provisions the pinned
package manager, restores or seeds a dependency cache, and optionally installs the Biome
CLI, a BATS shell-testing toolchain with kcov coverage, and an embedded Turborepo
remote-cache server.[^domain-schema] It is built on Effect v4 over the first-party
`@effected/*` suite, which implements the GitHub Actions runner protocol natively, so the
action ships with zero `@actions/*` dependencies.[^program]

## Boundaries

The action owns detection, installation and cache management for the toolchain a
`devEngines` manifest names, and the export of environment and outputs a consuming
workflow's later steps read. It does not own what those later steps do with the
tools — it provisions and exports; it never runs `bats`, `kcov` or `biome` itself, the same
posture across all three optional toolchains.[^runtime-installation-toolchain] The embedded
Turborepo remote-cache server is the one exception that runs continuously rather than
provisioning-and-exiting, and even that server is a detached, self-contained HTTP process
this action spawns and reaps — never a build participant, and never itself invoking
`turbo`.[^turbo-server-entry]

Configuration is exclusively `package.json`'s `devEngines`; there are no runtime or
package-manager version inputs, so `package.json` and workflow YAML cannot drift apart from
each other.[^domain-schema] The remaining action inputs are optional knobs — cache
behaviour, BATS/kcov/turbo opt-in-or-out, additional lockfile globs — auto-detected when
omitted.[^action-yml]

## Non-goals

- **No semver ranges.** Every version this action installs is an absolute version; a range
  is a decode failure.[^domain-schema]
- **No corepack.** Package-manager provisioning goes through `PackageManagerInstaller`
  directly — no `corepack enable`, no `corepack prepare --activate`, no corepack bootstrap
  of any kind.
- **No version inputs.** `devEngines` is the only source of truth; a top-level corepack
  `packageManager` field in `package.json` is ignored by the decode.[^domain-schema]
- **The action never runs the tooling it installs.** It provisions and exports BATS, kcov
  and Biome; the consuming workflow's own steps invoke them.[^runtime-installation-toolchain]
- **No Vercel account required for Turborepo caching.** The embedded remote-cache server
  gives a consumer cross-job artifact sharing over storage the runner already has (GitHub
  Actions cache or S3); passthrough to a real Vercel account is supported but never
  required.[^turbo-cache-step]

[^domain-schema]: ../src/schema/domain.ts
[^program]: ../src/program.ts
[^action-yml]: ../action.yml
[^runtime-installation-toolchain]: ../src/steps/install-bats.ts, ../src/steps/install-kcov.ts, ../src/steps/install-biome.ts
[^turbo-server-entry]: ../src/turbo-server.ts
[^turbo-cache-step]: ../src/steps/turbo-cache.ts
