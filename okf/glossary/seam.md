---
type: Glossary
title: Seam
description: In this repository, a seam is a defaulted parameter that stands in for a kit static or a process read, never a repository-local service — a narrower sense than the wider ecosystem's usage.
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 338b6ecf5d678c76e2f022f74d24506c01807e49b4e719430b80f5904e5bc262
sources:
  - id: turbo-cache-step
    resource: ../../src/steps/turbo-cache.ts
  - id: post
    resource: ../../src/post.ts
  - id: install-runtimes
    resource: ../../src/steps/install-runtimes.ts
tags:
  - dx
  - testing
---

# Seam

In this repository, "seam" names one specific pattern: a function parameter that **defaults**
to the real kit static or the real `process` read it stands in for, so a test can substitute
something else without a service, a layer, or a mock in the middle. It is a narrow,
deliberately chosen sense of the word, not a synonym for "any place behavior could be
substituted."

## Examples

- `StartTurboCacheArgs.detached` and `makePost(ops: DetachedProcessOps = DetachedProcess.ops)`
  default to the kit's own `DetachedProcess` statics (`spawn`, `awaitReady`, `reap`), which a
  unit test must never perform for real — `spawn` starts a process that outlives the test
  run, `awaitReady` polls for six seconds, and `reap` sends a real `SIGTERM` to whatever
  process owns a pid a fixture made up.[^turbo-cache-step][^post]
- `installRuntimes(config, host: Host = currentHost())`, `installBiome(version, host =
  currentHost())`, and `installDependencies(pm, enabled, prepends, platform =
  process.platform)` each default a `host`/`platform` parameter to the one real `process`
  read the module performs, so a Linux test can exercise the Windows layout without
  monkey-patching `process` itself.[^install-runtimes]

A production caller passes nothing and gets the real static or the real `process` read every
time; only a test ever supplies the parameter, and doing so is visible at the call site rather
than hidden behind an injected service.

## Why a defaulted parameter and not a service

A repository-local service wrapper around three functions would have to be threaded through
every consumer's layer composition and into `PostLive`, just to make those three functions
overridable in a test. A defaulted parameter needs none of that: `R` stays unchanged,
production code paths run the kit's statics with no caller ever passing one, and a test
substitutes a double (`DetachedProcess.makeTestOps({ … })`) that fails loudly, naming the
member, the moment it is asked to do something the test never stubbed.

## Where the ecosystem differs

The word "seam" is best known from Michael Feathers' *Working Effectively with Legacy Code*,
where it means any point in a program where behavior can be substituted without editing that
point — object seams, link seams, preprocessor seams, and so on: a broad category covering
essentially every substitution mechanism a language and build system offer. This repository's
usage is a specific instance of that broader idea, narrowed to exactly one mechanism: a
defaulted parameter over a kit static or a `process` read. A reader arriving from the wider
Feathers sense and looking for "the service layer's seams" or "the DI container's seams" will
not find either — there is no repository-local service to substitute into, by design. The
decision behind this choice lives at
[seams as defaulted parameters](../decisions/seams-as-defaulted-parameters.md).

[^turbo-cache-step]: turbo-cache-step
[^post]: post
[^install-runtimes]: install-runtimes
