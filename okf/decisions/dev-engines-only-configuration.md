---
title: devEngines-only configuration, no version inputs
type: Decision
status: draft
description: Why runtime and package-manager versions come only from package.json devEngines, and why the action's outputs echo the request rather than probe the result.
tags: [architecture, dx, compat]
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 18475db43fce83acf9115e7673d6f1f0aaade6eeb6069e8f29a1378d79c2d292
sources:
  - id: schema-domain
    resource: ../../src/schema/domain.ts
  - id: setup-package-manager
    resource: ../../src/steps/setup-package-manager.ts
---

# devEngines-only configuration, no version inputs

## Context

A GitHub Action that sets up runtimes and a package manager needs to learn
their versions from somewhere. The obvious alternatives are action inputs
(`with: node-version: …` in the workflow YAML) or a corepack-style
`packageManager` field at the manifest's top level. Either source can drift
from the other, and from whatever the repository's own tooling actually
targets, if more than one is honored at once.

## Decision

`package.json`'s `devEngines.packageManager` (name + absolute version) and
`devEngines.runtime` (one object or a non-empty array, each an absolute
version) are the **only** source of truth. There are no runtime or
package-manager version *inputs* on the action at all — `action.yml` declares
none — so `package.json` and the calling workflow cannot disagree about which
version is in play. A top-level corepack `packageManager` pin is read and
discarded: `Schema.decodeUnknownEffect` only extracts the `devEngines` shape
it declares, so an unrelated manifest key is dropped along with everything
else the schema does not name[^schema-domain]. Versions must be absolute —
`^`, `~`, `>`, `<`, `=`, `*`, `x`/`X` are all rejected by the `SemVer`-backed
schema — because the whole action's premise is reproducible builds, and a
semver range resolves to a different concrete version on every run.

The outputs that report the package manager follow the same principle in
reverse: `package-manager` and `package-manager-version` are a pure **echo of
the request**, never a probe's answer. `setupPackageManager` builds its result
from `{ name: spec.name, version: spec.version }` taken straight off the
parsed `devEngines` spec, before anything is installed[^setup-package-manager].
The one field that is *not* an echo is `binDir`: it reports where this run
actually put the executable — `Option.some(installed.binDir)` on a tool-cache
install, `Option.none()` otherwise — because that is genuinely new
information the dependency-install step downstream needs, not a restatement
of what the caller already knows it asked for.

Two v1 deviations are recorded here because they are easy to mistake for
oversights. The `Install <pm>` group title names the manager rather than
describing the mechanism; legacy's title said "via corepack", which was
already a lie for bun and deno before corepack was removed from this action
entirely. The failure message for a provisioning failure drops legacy's
redundant `Package manager setup failed:` middle clause and its stderr tail —
the wrapped error already carries that context once, and repeating it added
nothing a reader needed.

## Alternatives rejected

- **Version inputs on the action (`node-version`, `pnpm-version`, …).** Two
  places to keep in sync — the workflow YAML and `package.json` — with no
  mechanism to catch drift between them. Every consuming repository would also
  need input wiring duplicated across every workflow that calls the action.
- **Probing the installed manager and reporting what actually ran.** Rejected
  for the outputs specifically: a probe answers "what happens to be first on
  `PATH`", which on a runner with a preinstalled manager is a different
  question from "what did `devEngines` ask for", and the outputs are
  documented as the configuration, not a discovery result.
- **Honoring the top-level corepack `packageManager` field as a fallback.**
  Would reintroduce exactly the two-source drift `devEngines`-only
  configuration exists to close, for a field this action's schema already has
  no reason to read.

## Consequences

- A consuming repository has exactly one place to change a runtime or
  package-manager version, and the action cannot silently diverge from it.
- Nothing about this action's configuration surface changes when corepack's
  own `packageManager` field changes shape or is deprecated upstream, since
  the action never reads it.
- `package-manager-version`'s value is trustworthy as "what was asked for" but
  cannot be read as "what actually executed" — for that, a consumer needs
  `binDir` or the action's own successful completion as evidence the pinned
  version really installed.

[^schema-domain]: ../../src/schema/domain.ts
[^setup-package-manager]: ../../src/steps/setup-package-manager.ts
