---
title: BATS helper libraries go to $HOME/.local/share, the one location two consumers agree on
description: Why bats-core needs no install step, why the four helper libraries land under $HOME/.local/share rather than the tool cache or /usr/lib, and why jq is only ever probed.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: fb62372727033faf6c4118c0222ff2d8d0aafbaa59df5ba82cfe56c3eca7a9e3
sources:
  - id: install-bats
    resource: ../../src/steps/install-bats.ts
  - id: bats-descriptor
    resource: ../../src/descriptors/bats.ts
tags:
  - compat
  - dx
  - caching
---

# BATS helper libraries go to $HOME/.local/share, the one location two consumers agree on

## Context

`installBats` provisions bats-core plus four helper libraries — `bats-support`,
`bats-assert`, `bats-file`, and `bats-mock` — and the action **provisions and exports; it
never runs bats.** That mirrors the Biome and Turbo posture: the consumer's own workflow
steps invoke the tooling.[^install-bats] Two different consumers then have to find those
libraries by two different mechanisms.

## Decision

**bats-core needs no install step.** In the release tarball, `bin/bats` is a regular 755
file — not a symlink into `libexec` — that locates its own `libexec/bats-core` relative to
`$0` via `readlink -f`. Extracting the tarball and putting `<root>/bin` on `PATH` is the
entire install, which is why this action needs neither `install.sh` nor git, unlike the
equivalent devcontainer feature script.[^bats-descriptor] bats-core therefore goes into the
**tool cache**, following the same download → extract → strip-wrapper → `cacheDir` →
`addPath` shape the runtime installs use.[^install-bats]

**The four helper libraries go to `$HOME/.local/share`, and only that location works**, not
the tool cache and not `/usr/lib` or `/usr/local/lib` (the paths the obvious prior art —
`bats-core/bats-action` and a devcontainer feature script — use). The location is dictated
by having **two consumers that discover libraries differently**: `bats_load_library <name>`
resolves `<entry>/<name>/load.bash` for each entry in `BATS_LIB_PATH`, while `vitest-bats`
**never reads `BATS_LIB_PATH`** — its `detectBatsLibraryPath` scans a fixed directory list
in order (`$XDG_CONFIG_HOME/<lib>`, `~/.config/<lib>`, `$XDG_DATA_HOME/<lib>`,
`~/.local/share/<lib>`, `/opt/homebrew/lib/…`, `/usr/local/lib/…`, `/usr/lib/…`).
`$HOME/.local/share/<lib>/` is the single location on both lists: the scan finds it, and
exporting `BATS_LIB_PATH=$HOME/.local/share` makes `bats_load_library` find it too. It is
also under `$HOME`, so nothing needs `sudo` — which is what lets the whole bats install work
on a self-hosted runner where kcov's build cannot (see
[kcov-built-from-source](./kcov-built-from-source.md)).[^install-bats]

`bats-mock` ships a **flat layout** — `stub.bash`, `binstub`, and *sometimes* `load.bash` —
rather than the bats-core org's `load.bash`-beside-`src/` shape. When `load.bash` is absent,
`installLibrary` synthesizes one: a one-line `source` of the sibling `stub.bash`, carried
over from a devcontainer script, without which `bats_load_library bats-mock` does not work
at all. `binstub` keeps its executable bit; it is spawned, not sourced.[^install-bats]
`bats-mock` is also spelled out in `descriptors/bats.ts` rather than derived from its name —
it comes from `jasonkarns/bats-mock`, not the `bats-core` org, so deriving its URL uniformly
would point at a `bats-core/bats-mock` repository that does not exist.[^bats-descriptor]

`home` is a parameter (defaulting to `process.env.HOME ?? homedir()`) for the same reason
the runtime install steps take a `Host`: it is what lets a test exercise the layout without
depending on `$HOME` being set on the machine running the suite. The resolved library root
is checked **absolute before anything is installed under it** — with `$HOME` unset (a
container entrypoint, `env -i`, a self-hosted runner service account),
`path.join("", ".local", "share")` is the *relative* path `.local/share`, and a run that did
not check would install libraries into the checkout and export
`BATS_LIB_PATH=.local/share`, breaking every `bats_load_library` call in the consuming
repository with nothing in the log pointing at the cause. The absolute check fails loudly,
before any files move, saying which variable is missing.[^install-bats]

`jq` is **probed and warned about, never installed**. It is preinstalled on GitHub-hosted
runners and `vitest-bats` needs it to record a mock; a self-hosted runner missing it fails
loudly in the log now (`Run.succeeds` collapses a spawn failure to `false`) instead of
mysteriously later, when `vitest-bats` actually tries to record a mock.[^install-bats]

## Alternatives rejected

- **The tool cache, matching bats-core itself.** `vitest-bats`'s fixed scan list never
  includes the tool cache, so nothing outside `bats_load_library` (which does read
  `BATS_LIB_PATH`) could find the libraries there.
- **`/usr/lib` or `/usr/local/lib`, matching `bats-core/bats-action` and the devcontainer
  script.** Both need `sudo`, which defeats the point of a location that works without it —
  and is exactly the privilege kcov's build sometimes lacks on a self-hosted runner.
- **Installing `jq`** when the probe fails. `jq` is a system tool already present on
  GitHub-hosted runners; installing it would mean shelling out to a system package manager
  for a dependency this action does not otherwise need to manage, for a runner class where
  it is already there.
- **Requiring `$HOME` to be set and failing without a check**, or silently proceeding with a
  relative path. The action instead detects the empty-`$HOME` case explicitly and fails with
  a message naming the missing variable, rather than installing silently into the checkout.

## Consequences

Any future BATS-ecosystem consumer this action wants to support has to be checked against
both discovery mechanisms — `BATS_LIB_PATH` and `vitest-bats`'s fixed scan list — before a
library placement decision is made; a consumer that reads neither would need a third
location or a documented exception. The synthesized `bats-mock` loader is a literal string
with a standing build constraint of its own — see
[kit-test-layers-and-real-volume](./kit-test-layers-and-real-volume.md) for its round-trip
concerns and the build-and-distribution material on the minifier hazard it must survive
verbatim.

[^install-bats]: install-bats
[^bats-descriptor]: bats-descriptor
