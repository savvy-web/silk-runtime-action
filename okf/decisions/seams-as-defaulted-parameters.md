---
title: Seams as defaulted parameters, not services
type: Decision
status: draft
description: Untestable statics (DetachedProcess spawn/awaitReady/reap, process.platform/process.arch reads) are injected as defaulted function parameters, never wrapped in a repository-local service.
tags: [architecture, testing, dx]
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 7c6ccb981f83ce86650dcc3a7927c5ab5261e6df8b2d55d3cd3dc60b9649b7a5
sources:
  - id: turbo-cache-step
    resource: ../../src/steps/turbo-cache.ts
  - id: post
    resource: ../../src/post.ts
  - id: install-runtimes
    resource: ../../src/steps/install-runtimes.ts
  - id: install-biome
    resource: ../../src/steps/install-biome.ts
  - id: install-dependencies
    resource: ../../src/steps/install-dependencies.ts
---

# Seams as defaulted parameters, not services

## Context

Three operations in this action cannot run for real inside a unit test:
`DetachedProcess.spawn` and `awaitReady` in `startTurboCache` — `spawn` starts
a process that outlives the test run, and `awaitReady` polls for up to six
seconds — and `DetachedProcess.reap` in `post`, which sends a real `SIGTERM`
to whatever process owns a pid a fixture made up. All three are **statics on
a class**, not services, because a detached child has no scope to hang a
service off in the first place. A fourth family of untestable operation is
smaller but the same shape: three steps read `process.platform` / `process.arch`
directly to decide a download URL or a shell strategy, and a `process` read
inside a function body is exactly as unswappable in a test as a raw static
call.

## Decision

Each of these is injected as a **defaulted parameter**, never wrapped in a
repository-local service:

```ts
// StartTurboCacheArgs.detached?: DetachedProcessOps — defaults to DetachedProcess.ops
export const makePost = (ops: DetachedProcessOps = DetachedProcess.ops) => /* … */;
```

A repository-local service wrapper would have to appear in every consumer's
layer composition and in `PostLive`, purely to make three functions
overridable. Parameter injection keeps `R` unchanged, lets production code
call the kit's own statics with no caller ever passing one explicitly, and
confines the whole seam to the one call site that needs it.

As of `@effected/github-actions` 0.7.0 this is **the kit's own seam** rather
than two hand-rolled ones (effected#240): `StartTurboCacheArgs.detached`[^turbo-cache-step]
and `makePost`'s `ops` parameter[^post] both take a `DetachedProcessOps`, replacing a local
two-member interface in `turbo-cache.ts` and a separate `Reap` function type
in `post.ts` that existed only because the two phases call different
operations. The kit's interface carries all three members (`spawn`,
`awaitReady`, `reap`), and a test builds its double with
`DetachedProcess.makeTestOps({ … })`: **members it does not stub die naming
themselves** rather than silently falling through to the real static.

That inverts the hazard the old local interfaces carried. Because those had
to be satisfied in full, the only way to leave an operation untested was to
hand over the real implementation — silently, and most dangerously for
`reap`, which signals a pid read out of a text state file. Now omission is an
assertion: `post`'s test doubles stub `reap` alone, and the suite fails
outright the moment that phase starts spawning anything.

The same defaulted-parameter pattern covers the three `process` reads that
would otherwise be untestable:

```ts
export const currentHost = (): Host => ({ platform: process.platform, arch: process.arch });
export const installRuntimes = (config: RuntimeConfig, host: Host = currentHost()) => /* … */;
```

[^install-runtimes]. `installBiome(version, host =
currentHost())`[^install-biome] takes the identical default, and
`installDependencies(pm, enabled, prepends, options)` takes an
`options.platform?: string` seam defaulting to `process.platform` at the call
site (`src/steps/install-dependencies.ts:228,307`)[^install-dependencies].
`currentHost` is the **only** place `install-runtimes.ts` touches `process`;
no caller passes any of these parameters in production, and their only
purpose is letting a Linux test suite exercise the Windows layout, or a
platform a runtime publishes no build for.

## Alternatives rejected

- **A repository-local `Context.Service` wrapping `DetachedProcess`.** Would
  put a new service into `MainLive`/`PostLive` and every future consumer's
  layer composition solely to make three static methods swappable — cost
  borne everywhere for a seam needed in exactly two call sites.
- **A `Host`/platform service instead of a defaulted parameter.** Same shape
  of cost for a narrower need: three functions read `process.platform` /
  `process.arch`, and a service would require providing it through every
  layer that reaches them even in production, where the default already does
  the job with zero ceremony.
- **Monkey-patching `process.platform` in tests.** Works only when nothing
  else in the same test file or worker needs the real value simultaneously,
  and leaves the production code with an implicit, untyped dependency on
  global mutable state instead of an explicit parameter.

## Consequences

- The one recorded cost: `program.test.ts` cannot reach the embedded turbo
  path at all — that would require a real spawn — so its turbo case is pinned
  to `turbo-cache: off`, and the outputs fold for the turbo case is tested
  separately through the exported pure `turboCacheOutputs` function instead.
- A future kit release that adds a member to `DetachedProcessOps` is safe by
  construction: a test double that does not stub the new member dies naming
  itself the moment production code calls it, rather than silently degrading
  to the real static inside a test process.
- Every seam of this shape is discoverable by grepping for a defaulted
  parameter rather than for a service registration, which is a different
  reading habit than the rest of the codebase's Effect-service-heavy style —
  worth remembering when auditing what is and is not swappable in a test.

[^turbo-cache-step]: ../../src/steps/turbo-cache.ts
[^post]: ../../src/post.ts
[^install-runtimes]: ../../src/steps/install-runtimes.ts
[^install-biome]: ../../src/steps/install-biome.ts
[^install-dependencies]: ../../src/steps/install-dependencies.ts
