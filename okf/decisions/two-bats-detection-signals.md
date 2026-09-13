---
title: Two BATS detection signals, neither a fallback for the other
description: Why bats auto-detection checks both a manifest probe and a bounded glob walk, and why kcov auto follows the bats decision.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 8e095d0660f301a3ce3ef99c4d25cddd9555541be3bd6f95b6f2cb4c9f2bb835
sources:
  - id: detect-bats
    resource: ../../src/steps/detect-bats.ts
  - id: install-kcov
    resource: ../../src/steps/install-kcov.ts
tags:
  - architecture
  - compat
  - dx
---

# Two BATS detection signals, neither a fallback for the other

## Context

`bats: auto` has to decide, from repository content alone, whether a consuming workflow
wants the BATS shell-testing toolchain installed. Two different kinds of BATS consumer exist
in the wild, and they leave different traces on disk.[^detect-bats]

## Decision

`resolveBats` checks **two independent signals**, and both are load-bearing rather than a
primary-plus-fallback pair: whether the root `package.json` depends on `vitest-bats` in any
of its four dependency sets (`dependencies`, `devDependencies`, `optionalDependencies`,
`peerDependencies`), and whether any `*.bats` file exists within four levels of the working
directory.[^detect-bats]

- `vitest-bats` **generates its `.bats` files at run time and commits none**, so for that
  consumer the glob signal never fires — the manifest probe is the only one that can see it.
- A repository with committed `.bats` files and no `vitest-bats` dependency — plain
  bats-core usage, the common case — is the exact mirror: the manifest probe sees nothing
  there.

Both paths have to work, and neither may be simplified away, because each is the *only*
signal for one real consumer shape.[^detect-bats]

The glob walk (`hasBatsFile`) is depth-bounded at four levels (`MAX_DEPTH`) and skips
`node_modules`, `.git`, `dist`, `coverage`, `.turbo`, and any dotted directory (`SKIP`, plus
a `startsWith(".")` check) — it runs on every job in every consuming repository, and the
signal it looks for lives near the top of a repository that genuinely has it. A vendored
`.bats` fixture inside a dependency is not this repository's intent to run bats.[^detect-bats]

Each candidate is `stat`ed (`isFile`) rather than matched on name alone: `readDirectory`
reports directories too, and a directory literally named `example.bats` would otherwise
provision the whole toolchain for a repository that contains no test file at all. A `stat`
that cannot be taken answers "not a file" — an entry this cannot read is not evidence of
anything.[^detect-bats]

`kcov: auto` follows the bats decision (`installKcov = modes.kcov !== "off"`, gated on
`installBats` first), and an explicit `kcov: on` still yields nothing when bats resolves to
off — `detectBats` returns `{ installBats: false, installKcov: false }` before `modes.kcov`
is even consulted. Coverage for a toolchain that runs no tests is never what the consumer
meant. The two inputs exist separately anyway, so a repository can take bats *without*
paying kcov's source build — see
[kcov-built-from-source](./kcov-built-from-source.md).[^detect-bats]

`installKcov` is further gated downstream on bats having actually *landed*, not merely on
the decision that asked for it, before `install-kcov` runs.[^install-kcov]

## Alternatives rejected

- **A single signal, whichever seemed more common.** Either alone blinds the action to one
  of its two real consumer shapes — the manifest probe alone misses every plain bats-core
  repository, and the glob alone misses `vitest-bats`'s generated-at-runtime files entirely.
- **Matching `*.bats` by name only, without a `stat`.** A directory named `example.bats`
  would install the toolchain for a repository with no test file, purely off a naming
  coincidence.
- **An unbounded or non-excluding walk.** This runs on every job in every consumer; a full
  recursive walk with no depth bound or skip list pays a needless cost on every large
  workspace and can find a vendored `.bats` fixture that was never this repository's intent.
- **Letting `kcov: on` install unconditionally.** A coverage tool with nothing to instrument
  produces a build cost and no benefit; gating it on the bats decision (and later, on bats
  having landed) keeps the two inputs meaningful together.

## Consequences

Adding a third BATS-consumer shape later needs a third signal in `resolveBats`, not a
rewrite of either existing one. The depth bound and skip list are a standing constraint on
any future glob-based detection this action adds elsewhere: they trade completeness for a
bounded cost on every job. A consumer that vendors `.bats` fixtures more than four directory
levels deep, or inside a skipped directory name, will not be auto-detected and must set
`bats: "on"` explicitly.

[^detect-bats]: detect-bats
[^install-kcov]: install-kcov
