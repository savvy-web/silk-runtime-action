---
title: The pinned package manager leads the child PATH, with no ambient exception
description: Why PackageManagerInstaller replaces corepack entirely, why installPathPrepends puts the manager ahead of every runtime, and why the npm ambient short-circuit was closed.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 9a1ee9e5d1c5fe1bb870b117532bd15b41dcd2b8dfc1a9136e4a22b2799b94da
sources:
  - id: setup-package-manager
    resource: ../../src/steps/setup-package-manager.ts
  - id: program
    resource: ../../src/program.ts
  - id: program-test
    resource: ../../__test__/unit/program.test.ts
tags:
  - architecture
  - compat
  - dx
---

# The pinned package manager leads the child PATH, with no ambient exception

## Context

`devEngines.packageManager` names an exact manager and version. The install child that runs
`npm ci` / `pnpm install` / etc. has to run *that* manager, not whatever the runner image
happens to already have on `PATH`, and its lifecycle scripts have to be able to find the
runtimes this action just installed.[^setup-package-manager]

## Decision

`setupPackageManager` is a complete no-op for `bun` and `deno` — each is its own package
manager, and naming it here means the runtime install already put it on `PATH`. For every
other manager, the pin string is assembled from `devEngines` and handed to
`PackageManagerPin.parse`, which owns the `<name>@<version>[+<integrity>]` grammar: a
`devEngines` version may carry an integrity tail (`10.20.0+sha512.…`), and the first `+`
always begins integrity, so the split is the pin's to make, never this step's.
`requireIntegrity` stays **off**, because in-the-wild pins routinely carry no hash and the
installer already warns when one does not.[^setup-package-manager]

`install` runs with `allowAmbient: false`. The reported `package-manager` /
`package-manager-version` outputs are a pure **echo of the request**, never a probe's
answer; `binDir` is the one field that is not an echo — it is where this run actually put
the command, feeding the dependency install downstream.[^setup-package-manager]

**`installPathPrepends`** (`program.ts`) builds the ordered, de-duplicated directory list the
dependency install's child process searches: the manager's bin directory first
(`onInstallPath` fills it in from the matching runtime when the manager *is* one of the
installed runtimes, such as bun or deno), then every installed runtime, de-duplicated
first-seen through a `Set`.[^program] The runtimes are not optional garnish: the install is
not a leaf, and a `postinstall` script running `deno install` or `bun install` resolves that
binary off the `PATH` it inherited from the install child. Prepending only the manager's
directory produced `deno: not found` on every runner in a multi-runtime workspace, a real
cross-OS failure rather than a hypothetical.[^program] The manager is still spawned by
**bare name**, with its directory prepended, rather than by absolute path — children inherit
`PATH`, not the absolute path their parent was invoked with.

**The npm exception, now closed (issue #220).** A prior ruling had `PackageManagerInstaller`
probe the runner's ambient npm with `npm --version` and, on an exact match, short-circuit
without caching — reporting no `binDir`, so it contributed nothing to the PATH list while
node's own bin directory led, carrying the npm *bundled with* the pinned node. That was
defended as "the npm belonging to the node you pinned," but it held only on a probe **hit**.
On a **miss**, the installer tool-cached the pin, its `binDir` led, and the pinned npm ran.
So which npm executed was a function of the runner image's npm version — the pin honoured on
a miss and quietly dropped on a hit — while `package-manager-version` reported the pin either
way. For an action whose premise is "absolute versions only, so builds are reproducible,"
that is the wrong non-determinism to keep.[^setup-package-manager]

`setupPackageManager` now passes `allowAmbient: false`, so no manager reaches
`installPathPrepends` without a `binDir`, and the head of the list is always the pinned
manager — uniform across all five managers: **the manager you pinned leads**.[^setup-package-manager][^program]
Suppressing the probe makes npm behave like every other tool here — node, bun, deno, pnpm,
and yarn were already installed to their exact pin, npm was the lone short-circuit — and
costs one small tarball on runs where the runner's npm happened to match.[^setup-package-manager]

The gap this closed had no fixture: nothing asserted *which* npm executes, and the
integration matrix structurally cannot catch it (its fixture versions coincide). The
coverage is a unit fixture, `program.test.ts`'s *runs the pinned npm, not the one bundled
with the pinned node*, whose `PackageManagerInstaller` double reproduces the installer's own
ambient branch: drop the option and the double answers `ambient`, the pinned npm falls out
of the list, and the case fails on the real symptom.[^program-test]

## Alternatives rejected

- **Keeping the ambient npm short-circuit.** It made "which npm actually executes" a
  function of the runner image rather than of `devEngines`, directly contradicting the
  action's absolute-versions-for-reproducibility premise.
- **Reasoning about the npm case as "the npm belonging to the pinned node."** That framing
  only ever held on the probe-hit branch; a probe miss ran the tool-cached pin instead, so
  the rule the code implemented was not the rule that was stated.
- **Prepending only the manager's own directory to the child PATH.** A package manager's
  install is not a leaf — lifecycle scripts spawn further tools — and this produced a real
  `deno: not found` failure on a multi-runtime workspace.
- **The whole corepack apparatus** a legacy implementation carried: `corepack enable`,
  `corepack prepare --activate`, `sudo npm install -g`, `~/.npm` chown, a tmpdir cwd to dodge
  `pnpm-workspace.yaml` hangs, a Node-25 corepack bootstrap, and stale-shim retry. All of it
  is gone; `PackageManagerInstaller` owns provisioning instead.

## Consequences

Every manager, including npm, now costs one small tarball download on a runner whose ambient
version happened to already match the pin — a deliberate, small, and bounded trade for
determinism. Any future package-manager provisioning path must preserve `allowAmbient:
false`; reintroducing an ambient short-circuit anywhere reopens the same
runner-image-dependent non-determinism issue #220 closed. `installPathPrepends`'s ordering
(manager first, then runtimes, de-duplicated first-seen) is now load-bearing for every
lifecycle script a consuming repository's install runs, not just for the manager binary
itself.

[^setup-package-manager]: setup-package-manager
[^program]: program
[^program-test]: program-test
