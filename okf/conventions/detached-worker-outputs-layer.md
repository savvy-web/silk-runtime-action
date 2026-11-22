---
type: Convention
title: A detached worker never gets the real ActionOutputs layer
description: A detached process must never compose the real ActionOutputs.layer, because a workflow command written to a detached process's stdout, a mask included, leaks rather than protects. The turbo-server worker composes no ActionOutputs at all; a worker that needs the service takes ActionOutputs.layerDetached.
tags: [security]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-11-22T05:18:42Z
sources:
  - id: server-config-platform-layer
    resource: ../../src/turbo-cache/server-config.ts
  - id: turbo-server-entry
    resource: ../../src/turbo-server.ts
integrity:
  generated:
    body: c0768db568baa695
---

# A detached worker never gets the real `ActionOutputs` layer

**Rule: never compose the real `ActionOutputs.layer` into a detached worker process. Give
the worker no `ActionOutputs` at all when nothing it runs needs one. When something it runs
does require the service, compose `ActionOutputs.layerDetached`.**

## Why the real layer is a leak, not merely the wrong layer

Masking a secret in a GitHub Actions job means writing `::add-mask::<plaintext>` to
**stdout** — a workflow command the runner's own log processor parses out of a *step's*
console output as that step runs, so the plaintext never reaches the rendered log.

The embedded turbo-cache server (`../../src/turbo-server.ts`) is not a step. It is a
detached child process, spawned by `startTurboCache` and reaped later by `post`. Its stdout
is redirected to a plain file in the temp directory, which no runner log processor ever
reads, and which `post` reads back and prints. Any `Secret.*` call made in that process
through the real layer writes its mask instruction, plaintext argument and all, into that
file. The masking mechanism inverts: in a step it protects a secret, and on a detached
process's stdout it writes the secret to a location a mask can never
reach.[^server-config-platform-layer]

## What the worker composes today

Nothing. `../../src/turbo-cache/server-config.ts`'s `platform` layer is the HTTP client and
`ActionEnvironment`, and the GitHub Actions cache store needs no more than that:

```ts
const platform = Layer.mergeAll(
  NodeHttpClient.layerUndici,
  ActionEnvironment.layer.pipe(Layer.provide(NodeFileSystem.layer)),
);
```

With no `ActionOutputs` in the worker's context, a call that would write a workflow command
does not type-check there. Keep it that way: before adding a dependency to the worker,
check whether it requires `ActionOutputs`, and prefer one that does not.

## When a worker does need the service

Compose `ActionOutputs.layerDetached`, never a hand-built double and never the real layer.
It is the kit's layer for exactly this process shape:

- **Its `R` is `never`.** A worker composing it *structurally cannot* end up writing a
  runner file — there is no service dependency through which it could reach one, so the
  leak class this convention exists to close is closed by the type system, not by
  discipline at each call site.
- **The members that would configure the parent job's later steps fail typed**, with
  `reason: "detached"`, rather than throwing an unstubbed-member defect the way a
  hand-rolled double's omitted members would. A worker that mistakenly calls `addPath` or
  `exportVariable` gets a typed, loggable failure describing exactly why that call was
  wrong in this process, not a crash with no context.

## The detached worker's own runtime

`src/turbo-server.ts` runs entirely outside `Action.run` and `ActionRuntime.layer`. It
builds its own layer stack in `server-config.ts` — `NodeFileSystem`,
`NodeHttpClient.layerUndici`, `ActionEnvironment.layer` — and drives the request handler
through a `ManagedRuntime` built directly over a plain `node:http` server
(`turbo-server.ts:20,47`), rather than inheriting anything from the process that spawned
it.[^turbo-server-entry] Every layer in this action's `MainLive` / `PostLive` runs inside
`Action.run` and gets the real `ActionOutputs` because it *is* a step in a step's log. That
includes sign-in to a hosted cache, which masks the cache token in `main`, where a mask
works.

[^server-config-platform-layer]: `../../src/turbo-cache/server-config.ts`
[^turbo-server-entry]: `../../src/turbo-server.ts`
