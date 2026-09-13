---
title: kcov is built from source because nothing usable is prebuilt
description: Why kcov is compiled on every platform, what that build costs, and why it is installed on macOS despite collecting nothing there.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: e72a13b6b20ac064d2d266e04b4412170399ad8e857a5666705274ab61751685
sources:
  - id: kcov-descriptor
    resource: ../../src/descriptors/kcov.ts
  - id: install-kcov
    resource: ../../src/steps/install-kcov.ts
tags:
  - compat
  - caching
  - performance
---

# kcov is built from source because nothing usable is prebuilt

## Context

kcov provides shell-script coverage for the BATS toolchain. Installing a prebuilt binary
the way runtimes and Biome are installed was tried first and ruled out — both the Linux and
macOS prebuilt paths were checked and found unusable, which is a conclusion, not a
preference.[^kcov-descriptor]

## Decision

**The prebuilt Linux binary is unusable on current runners.** kcov v42 is the last release
publishing a binary asset; v43 and later publish source only. That v42 ELF binary links
`libbfd-2.38-system.so` and `libopcodes-2.38-system.so` — binutils 2.38, i.e. Ubuntu 22.04.
`ubuntu-latest` is now 24.04 with binutils 2.42, so those sonames do not resolve. Downloading
kcov is not an option.[^kcov-descriptor]

**Homebrew is not a fast macOS path either.** kcov 43 publishes exactly one bottle,
`arm64_tahoe` (macOS 26). GitHub's `macos-latest` is macOS 15 (`arm64_sequoia`), where
`brew install kcov` compiles inside Homebrew anyway — slow, and opaque to any cache this
action controls.[^kcov-descriptor]

So the build happens here, into a prefix this action owns and caches:
`$RUNNER_TOOL_CACHE/kcov/43/<arch>`, tool-cache-shaped, with `<prefix>/bin` on `PATH`. That
prefix is the single unit of Actions caching — see
[separate-kcov-cache-entry](./separate-kcov-cache-entry.md) for the key, the ladder, and the
verify probe.[^kcov-descriptor]

**Build dependencies are installed only on a cache miss** — the whole point of the cache is
that a warm run needs neither `apt` nor Homebrew. On Linux: `sudo apt-get update`, then
`sudo apt-get install -y --no-install-recommends cmake g++ libdw-dev binutils-dev
libcurl4-openssl-dev zlib1g-dev pkg-config`. On macOS: `brew install dwarfutils openssl@3` —
`cmake` is deliberately absent from that list, being preinstalled on the runner
images.[^install-kcov] This is **the one place** the action shells out to a system package
manager, and the only place `sudo` matters. On a runner without it the dependency install
fails, the step fails typed with `build`, and the caller degrades to a warning: bats without
coverage, not a red build.[^install-kcov] `cmake` refuses an in-source build, so the object
tree (`buildDir`) is a sibling of the unpacked source rather than a directory inside
it.[^install-kcov]

`descriptors/kcov.ts`'s `kcov.plan` **refuses `win32` as a `Result` failure** rather than
skipping silently — kcov has no Windows build at all, and the caller renders the refusal
message as the warning that explains why `kcov-enabled` is `false`. The failure comes
**before the cache is consulted**, inside `installKcov`: there is no key that could be
right, and a restore attempt would spend a round trip only to say so.[^kcov-descriptor][^install-kcov]

**Known limitation, installed regardless: kcov collects nothing on macOS today.** SIP blocks
`ptrace`, so kcov produces no coverage on a macOS runner; `vitest-bats` states this in its
own README and marks kcov `required: !onMacOS`. kcov is installed on macOS anyway,
deliberately and forward-lookingly — the binary being present and on `PATH` means that if a
future macOS image lifts the restriction, consuming repositories start collecting coverage
with no change to this action. The cost is bounded by the cache: a cold macOS cache pays one
build, and every run after that pays a restore. See
[kcov-platform-coverage](../limitations/kcov-platform-coverage.md).

## Alternatives rejected

- **Shipping/using the v42 prebuilt Linux binary.** Its `DT_NEEDED` entries name binutils
  2.38 sonames that do not exist on the 24.04 runner image; the binary simply does not load.
- **Relying on Homebrew's bottle on macOS.** Homebrew publishes only an `arm64_tahoe` bottle
  against the GitHub-hosted `macos-latest` image's `arm64_sequoia`, so `brew install kcov`
  compiles from source inside Homebrew regardless — no faster than building directly, and
  opaque to this action's own cache.
- **Skipping kcov on macOS entirely, since SIP blocks `ptrace` there today.** That would
  require a future macOS image change to be paired with an action change before coverage
  could ever start working, rather than only an image change.
- **Installing build dependencies unconditionally, on every run.** The cache's entire value
  is a warm run needing neither `apt` nor Homebrew; installing them regardless would erase
  that benefit.

## Consequences

A version bump to kcov needs re-verification of both prebuilt paths before this decision
could ever be revisited — the conclusion holds only for the versions and runner images
checked here, and a later kcov release or runner image change could shift either finding.
The Linux dependency install is the one place in this action requiring `sudo`; a runner
lacking it degrades kcov to a warning rather than failing the job, which is a deliberate
trade this decision commits to keeping. Building on macOS despite collecting nothing there
is a standing cost (one build per cold cache) paid in exchange for zero-friction adoption if
Apple ever lifts the `ptrace` restriction.

[^kcov-descriptor]: kcov-descriptor
[^install-kcov]: install-kcov
