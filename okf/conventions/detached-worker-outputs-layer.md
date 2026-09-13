---
type: Convention
title: A detached worker never gets the real ActionOutputs layer
description: The detached turbo-server process must compose ActionOutputs.layerDetached, never the real ActionOutputs.layer, because masking on a detached process's stdout leaks rather than protects.
tags: [security]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: daab88b150eefb60f6294d22d548a5567268558fabc0ea9d2efe5952000c68b9
sources:
  - id: server-config-platform-layer
    resource: ../../src/turbo-cache/server-config.ts
  - id: turbo-server-entry
    resource: ../../src/turbo-server.ts
---

# A detached worker never gets the real `ActionOutputs` layer

**Rule: a detached worker process never composes the real `ActionOutputs` layer. It
composes `ActionOutputs.layerDetached`.**

## Why the real layer is a leak, not merely the wrong layer

Masking a secret in a GitHub Actions job means writing `::add-mask::<plaintext>` to
**stdout** — a workflow command the runner's own log processor parses out of a *step's*
console output as that step runs, so the plaintext never reaches the rendered log.

The embedded turbo-cache server (`../../src/turbo-server.ts`) is not a step. It is a
detached child process, spawned by `startTurboCache` and reaped later by `post`. Its stdout
is redirected to a plain file in the temp directory, which no runner log processor ever
reads. When the S3 backend declassifies its signing key through `Secret.forSigning` — which
masks first, then returns the plaintext for use — the mask instruction lands in that
unread file exactly as if it had never been emitted, and the **plaintext secret is what
lands beside it, in a file whose path `post` itself prints.** The masking mechanism
inverts: in a step it protects a secret, and on a detached process's stdout it does the
opposite of nothing — it writes the secret to a location a mask can never reach.

This action shipped that exact bug for one round before the fix landed.

## The fix and what it improves on

`../../src/turbo-cache/server-config.ts`'s `platform` layer composes
`ActionOutputs.layerDetached` rather than the real `ActionOutputs.layer`:

```ts
const platform = (() => {
  const fileSystem = NodeFileSystem.layer;
  const environment = ActionEnvironment.layer.pipe(Layer.provide(fileSystem));
  return Layer.mergeAll(NodeHttpClient.layerUndici, environment, ActionOutputs.layerDetached);
})();
```

`ActionOutputs.layerDetached` replaced an interim hand-built double this repository wrote
for the same fix, and improves on it in two ways worth keeping in mind whenever a new
detached process is considered:

- **Its `R` is `never`.** A worker composing it *structurally cannot* end up writing a
  runner file — there is no service dependency through which it could reach one, so the
  leak class this convention exists to close is closed by the type system, not by
  discipline at each call site.
- **The members that would configure the parent job's later steps fail typed**, with
  `reason: "detached"`, rather than throwing an unstubbed-member defect the way a
  hand-rolled double's omitted members would. A worker that mistakenly calls `addPath` or
  `exportVariable` gets a typed, loggable failure describing exactly why that call was
  wrong in this process, not a crash with no context.

The regression test that pins the `::add-mask::` behavior survived this swap unchanged —
the fix changed which layer the worker composes, not the contract the masking behavior is
tested against.

## The detached worker's own runtime

`src/turbo-server.ts` runs entirely outside `Action.run` and `ActionRuntime.layer`. It
builds its own layer stack in `server-config.ts` — `NodeFileSystem`,
`NodeHttpClient.layerUndici`, `ActionEnvironment.layer`, `ActionOutputs.layerDetached` — and
drives the request handler through a `ManagedRuntime` built directly over a plain
`node:http` server (`turbo-server.ts:19-20,46`), rather than inheriting anything from the
process that spawned it. Composing that stack is the one place `ActionOutputs.layerDetached`
belongs; every other layer in this action's `MainLive` / `PostLive` runs inside `Action.run`
and gets the real `ActionOutputs` because it *is* a step in a step's log.
