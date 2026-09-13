---
title: "`addPath` looks like it updates `PATH`; it only reaches later steps"
description: Reading ActionOutputs.addPath as an immediate PATH mutation instead of a GITHUB_PATH append that later workflow steps pick up.
type: Gotcha
status: draft
stale_after: 2027-03-13T00:00:00Z
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: ea66eaabf6a3970dbe39f99cf53813376b85daf8a30ce93195514d9c8d7cfb75
resource: ../../src/steps/install-runtimes.ts
sources:
  - id: install-runtimes
    resource: ../../src/steps/install-runtimes.ts
tags:
  - compat
  - dx
---

# `addPath` looks like it updates `PATH`; it only reaches later steps

## What a reader sees

`installOne` calls `outputs.addPath(toolPath)` right after caching a runtime, then goes on
to run that same runtime's binary a few lines later to verify the install.[^install-runtimes]
The call reads like an ordinary `process.env.PATH` mutation, and the code right after it
spawns the freshly-installed binary — so it is easy to assume the two are connected: publish
to `PATH`, then find the binary on `PATH`.

## What that leads you to conclude

That `addPath` takes effect immediately, in this same process, and that a bare command name
(`node`, `deno`, `pnpm`, …) would resolve correctly right after the call — inside this step,
inside a later step of the same job, or in a child process this step spawns.

## What is actually true

`ActionOutputs.addPath` writes to `GITHUB_PATH`, and the runner only folds `GITHUB_PATH`'s
entries into `PATH` for **steps that run after the current one finishes** — never for the
rest of the current process, and never retroactively for a command already running. That is
why the verify probe a few lines later spawns the binary by its **absolute path**
(`path.join(toolPath, plan.binary)`), not by bare name — `addPath` has not taken effect yet,
so a bare name would resolve to whatever the runner image already has, not to what this step
just installed.[^install-runtimes]

Three real defects trace back to treating `addPath` as an immediate mutation:

- A **bare-name verify probe** on a runner whose ambient `PATH` was already broken (a
  mismatched or absent binary) reported success anyway, because it silently verified
  whatever the runner already had rather than the runtime this step had just installed —
  exactly the failure mode the comment beside the current absolute-path probe calls out by
  contrast.[^install-runtimes]
- A `deno: not found` failure surfaced from a `postinstall` lifecycle script: the dependency
  install's child process needs every installed runtime's directory on **its own** inherited
  `PATH`, not just `GITHUB_PATH` entries that have not applied yet, which is a separate
  problem `installPathPrepends` solves by building an explicit prepend list rather than
  relying on `addPath`'s later-step effect.
- The pinned package manager itself is spawned by **bare name**, with its directory
  explicitly prepended to the child's `PATH` — never invoked through whatever `addPath` may
  or may not have applied by that point in the same job.

The rule this leaves behind: `addPath` is for **other, later steps in the same job** (or a
consuming workflow's own subsequent steps) to pick up automatically. Anything this action
itself needs to run against a runtime it just installed — a verify probe, a dependency
install's child process, the package manager itself — has to go through an absolute path or
an explicit `PATH` prepend, never a bare name that assumes `addPath` already landed.

See [`path-publication-rules`](../conventions/path-publication-rules.md) for the convention
this gotcha motivates, and
[`pinned-package-manager-leads-path`](../decisions/pinned-package-manager-leads-path.md) for
how the dependency-install child's `PATH` is actually assembled.

[^install-runtimes]: install-runtimes
