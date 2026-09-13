---
title: "spencerbeggs/vitest-bats"
description: The consumer of the BATS and kcov toolchains this action provisions — what it reads, how it discovers helper libraries without reading the variable this action exports for them, and why bats detection needs two independent signals.
type: Consumer
status: draft
repository: spencerbeggs/vitest-bats
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: f65e49a4088a23552b8a6bb3956d832c61c2cd9d60d1b67205529ff4a6b66ad1
sources:
  - id: install-bats
    resource: ../../src/steps/install-bats.ts
  - id: install-kcov
    resource: ../../src/steps/install-kcov.ts
  - id: detect-bats
    resource: ../../src/steps/detect-bats.ts
tags:
  - testing
  - compat
---

# spencerbeggs/vitest-bats

`spencerbeggs/vitest-bats` is the primary consumer of the BATS and kcov toolchains this
action provisions: it reads `BATS_LIB_PATH`, `BATS_PATH`, and `KCOV_PATH` from the
environment this action exports, and its own discovery behavior for BATS helper libraries is
what dictates where this action installs them.[^install-bats][^install-kcov]

## Surfaces exercised

- **`BATS_PATH`** — the `bats` binary's resolved path, exported beside `BATS_LIB_PATH` for
  the same reason `KCOV_PATH` is exported beside `PATH`: a consumer that spawns the binary
  directly should not have to re-derive where the tool install put it.[^install-bats]
- **`KCOV_PATH`** — the kcov binary's resolved path, exported for the same
  spawn-it-directly reason as `BATS_PATH`.[^install-kcov]
- **`BATS_LIB_PATH`** is exported by this action, but `vitest-bats` **never reads it**. Its
  own `detectBatsLibraryPath` instead scans a fixed list of candidate directories —
  `$XDG_CONFIG_HOME/<lib>`, `~/.config/<lib>`, `$XDG_DATA_HOME/<lib>`, `~/.local/share/<lib>`,
  `/opt/homebrew/lib/…`, `/usr/local/lib/…`, `/usr/lib/…` — which is why this action installs
  the four helper libraries under `$HOME/.local/share` specifically: that path satisfies both
  `vitest-bats`'s scan *and* `bats_load_library`'s own relative-path resolution, from one
  location, with no `sudo` required.[^install-bats]
- **`jq`** — `vitest-bats` needs it on `PATH` to record a mock; this action only probes for
  it (never installs it) and logs a warning rather than failing when it is absent, since
  `jq` is preinstalled on GitHub-hosted runners and its absence is a self-hosted-runner
  configuration gap rather than something this action can fix.[^install-bats]
- **kcov, marked `required: !onMacOS`** — `vitest-bats` treats kcov as required everywhere
  except macOS, matching this action's own posture that kcov collects nothing on macOS.
- **`.bats` files generated at run time, none committed** — `vitest-bats` writes its test
  files during its own run rather than checking any in, which is exactly why
  `detect-bats`'s manifest probe (a `vitest-bats` dependency in the root `package.json`)
  exists as a second detection path: a repository using `vitest-bats` has no `*.bats` file
  for the bounded glob to find until its own test run has already started.[^detect-bats]

## Where the edge sits

This action provisions the toolchain and exports its locations; `vitest-bats` runs the
tests. The edge is the exported-variable contract above — this action never invokes `bats`
or `kcov` itself, and `vitest-bats` never installs either binary itself.

## Open questions

- Whether `vitest-bats`'s fixed library-scan list will ever include a path this action does
  not install to, which would silently break library discovery for a consumer on a platform
  this action has not been asked to support yet.
- Whether the `!onMacOS` kcov requirement in `vitest-bats` and this action's own
  macOS-collects-nothing posture stay in agreement if either side's platform matrix changes
  independently of the other.

See also [`../decisions/bats-libraries-in-home-local-share.md`](../decisions/bats-libraries-in-home-local-share.md)
and [`../decisions/two-bats-detection-signals.md`](../decisions/two-bats-detection-signals.md)
for the decisions this consumer's behavior directly produced.

[^install-bats]: install-bats
[^install-kcov]: install-kcov
[^detect-bats]: detect-bats
