---
title: An embedded, detached Turbo remote-cache server over a Vercel account
description: Why the action stands up its own Turbo remote-cache HTTP server rather than requiring Vercel, why it runs detached at a fixed port, and the current-state choices that shape it.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: f0ec85ac37306d478ac86c7d41fa579b3574140d4d6c763df818512f11815685
sources:
  - id: activation
    resource: ../../src/turbo-cache/activation.ts
  - id: handler
    resource: ../../src/turbo-cache/handler.ts
  - id: server-config
    resource: ../../src/turbo-cache/server-config.ts
  - id: turbo-cache-step
    resource: ../../src/steps/turbo-cache.ts
  - id: turbo-server
    resource: ../../src/turbo-server.ts
  - id: state
    resource: ../../src/state.ts
  - id: post
    resource: ../../src/post.ts
tags:
  - architecture
  - caching
  - ci
---

# An embedded, detached Turbo remote-cache server over a Vercel account

## Context

Turbo speaks an HTTP remote-cache protocol (`/v8/artifacts/*`). Most consumers run Turbo in
CI without a Vercel Remote Cache account, and requiring one would exclude them from
cross-job and cross-run artifact sharing entirely.

## Decision

When `turbo.json` is detected and no Vercel passthrough credentials are supplied, the action
starts a **detached local HTTP server** implementing Turbo's artifact protocol over a
generic `BlobStore` (the GitHub Actions cache or S3/SigV4), and points Turbo at it through
`TURBO_API` / `TURBO_TOKEN` / `TURBO_TEAM`.[^turbo-cache-step] Passthrough still defers to a
real Vercel account when both `turbo-token` and `turbo-team` are supplied.[^activation]

**Generic `BlobStore` backend.** Turbo's protocol needs only put/get/has against opaque
keys, so the handler is written against a `BlobStore` service rather than a concrete backend.
The same `makeTurboHandler` runs over the GitHub Actions cache blob store or an S3 blob
store; adding a backend is a layer swap, not a handler change.[^handler][^server-config]

**`BlobEnvelope` over a hand-rolled frame.** An earlier implementation packed
`[4B tagLen][4B durationMs][tag][body]` by hand and namespaced keys with a `v2/` prefix
because the frame had no in-band version. The kit's envelope owns framing and revisioning
instead, deleting a codec module, a version constant, and a class of mis-slicing bug, and
turning an unreadable blob into a typed error the handler classifies as a miss rather than
serving corrupt data.[^handler]

**Detached process, not an in-process server.** The main phase has to return so the workflow
can proceed to the consumer's own `turbo run` steps; a server bound to the main process would
either block the step or die when the process exits. The child is spawned detached
(`src/turbo-server.ts`, the third bundle), with stdout and stderr redirected to a
deterministic log file rather than discarded, so a startup failure is diagnosable without the
step hanging on it.[^turbo-cache-step][^turbo-server]

**The log path is derived from the port**, `serverLogPath(port)` = a fixed template under the
system temp directory, rather than randomized — so the spawn, the failed-readiness error, and
`post`'s teardown debug line all name the same file without passing it between
them.[^turbo-cache-step]

**Readiness gates the export.** Pointing Turbo at a dead server would make every cache call a
connection error. The readiness probe returns `false` rather than failing for a refused
connection or a non-2xx answer — both "not up yet" and "listening but not serving" should
keep the retry loop waiting — leaving the kit's `awaitReady` helper with only its own
exhaustion to fail with, which is what the caller degrades on.[^turbo-cache-step]

**Non-fatal, twice over.** `startTurboCache` catches its own typed error channel and defects,
answering a disabled resolution; the handler catches everything to a `500` rather than
crashing the server; the worker exits cleanly on a config or listen failure. A misconfigured
bucket never fails a build that did not need a cache.[^turbo-cache-step][^turbo-server]

### Current-state choices

- **The port is fixed (`41230`) rather than negotiated.** Turbo reaches the server through the
  exported `TURBO_API`, so negotiation would work — but it would also mean the action and the
  server disagreeing about the port whenever the handoff failed, and nothing on a runner
  competes for this one port. The missing half was added instead: a listen that fails says so
  and exits.[^server-config][^turbo-server]
- **There is no `v2/` key segment any more.** The `BlobEnvelope` carries the format revision
  in-band and reports a mismatch as a typed error the handler turns into a miss; stale
  entries age out through the backend's own eviction.[^handler]
- **Blob keys use a `/` separator, inserted only when a non-empty prefix does not already end
  in one** (`artifactKey`). An earlier implementation concatenated the prefix onto the hash
  directly, so prefix `p` wrote `phash…` and two namespaces whose prefixes were substrings of
  one another could share entries.[^handler]
- **`"remote"` is deliberately absent from `TurboCacheResolution`.** It is the output
  vocabulary for passthrough (`action.yml`'s `turbo-cache-backend` enum), and the rename
  happens where outputs are written; the activation table names what was decided, not what is
  reported.[^activation]
- **Partial passthrough credentials — exactly one of token/team — still fall through to the
  embedded server, but now emit a warning.** An earlier implementation said nothing at all, so
  the run silently started an embedded server instead of talking to Vercel, indistinguishable
  in the log from a workflow that configured no passthrough at all.[^activation][^turbo-cache-step]
- **Passthrough exports no `TURBO_API`.** Turbo's own default is Vercel's endpoint, and naming
  one here would pin a URL this action does not own.
- **`/events` is authenticated where an earlier implementation left it open**, matching
  `/status`'s deliberate exception: `/status` stays open because it is the readiness probe the
  spawning step polls before it has anything to authenticate with, while `/events` is
  Turbo-client traffic. Authentication happens after the route match, so an unroutable path is
  a `404` rather than a `401` — telling a misconfigured client which of the two things is
  wrong.[^handler]
- **The state save sits between the spawn and the readiness wait**, not after it. A child that
  hangs half-started is still reapable: the window in which a leaked process could survive the
  job is the width of one `ActionState.save` rather than the whole readiness
  budget.[^turbo-cache-step]

`ActionEnvironment` (via `GitHubContext`), the cross-phase state protocol documented for the
dependency and kcov caches, and the pipeline's reap-first `post` ordering all apply here too:
`post`'s server reap runs first and unconditionally, ahead of every other branch that could
return early, so a failure in a later branch never costs the reap its turn.[^post][^state]

## Alternatives rejected

- **Requiring a Vercel Remote Cache account.** Excludes every consumer without one from
  cross-job artifact sharing entirely, which is most of them.
- **An in-process server on the main phase's own process.** Would either block the step from
  returning or die the moment the process exits.
- **A negotiated port.** Trades a fixed, always-reachable address for a coordination problem
  neither side of the handoff needs to solve, on a runner where nothing else competes for the
  port.
- **A hand-rolled artifact frame with an explicit version prefix.** Replaced by the kit's
  self-describing envelope, which turns a version mismatch into a typed miss instead of a
  hand-parsed byte layout.
- **Leaving `/events` open**, matching a passthrough-only mental model. Rejected because it is
  genuine Turbo-client traffic, unlike the readiness probe.

## Consequences

Every consumer of this action gets cross-job Turbo artifact sharing with zero external
accounts, at the cost of one detached child process per job that `post` must reap and one
fixed port that a second concurrent embedded server on the same runner cannot also bind.
Adding a storage backend is a `BlobStore` layer, not a protocol change.

[^activation]: activation
[^handler]: handler
[^server-config]: server-config
[^turbo-cache-step]: turbo-cache-step
[^turbo-server]: turbo-server
[^state]: state
[^post]: post
