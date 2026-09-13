---
type: Limitation
title: "ACTIONS_RUNTIME_TOKEN expires under a long-running embedded Turbo server"
description: The GitHub Actions cache backend for the embedded Turbo server captures a short-lived runtime token at spawn time, so a very long job can lose cache writes partway through with no refresh channel to recover them.
status: draft
bounds: ../modules/turbo-cache-server.md
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: ed02c032d8652e94520e645a760e6c7196fcafc7712a0a790738b4fca3627736
sources:
  - id: server-config
    resource: ../../src/turbo-cache/server-config.ts
  - id: turbo-server
    resource: ../../src/turbo-server.ts
tags:
  - caching
  - ci
---

# "ACTIONS_RUNTIME_TOKEN" expires under a long-running embedded Turbo server

## Trigger

The embedded Turbo remote-cache server's GitHub Actions backend authenticates its cache
reads and writes with `ACTIONS_RUNTIME_TOKEN`. `DetachedProcess.spawn` merges the worker's
environment over the parent's at spawn time, which is how `ACTIONS_RUNTIME_TOKEN` reaches the
GitHub backend without the spawning step ever reading it itself — and also the moment the
token's value is fixed for the life of the child process. That token is a short-lived JWT
issued by the Actions backend, and there is no channel into a detached process for a
refreshed one to arrive later.[^server-config]

## Symptom

On a very long job, cache writes from Turborepo that happen late enough come back `401
Unauthorized`, while everything earlier in the same run succeeded. `isAuthShapedFailure`
classifies exactly this shape — a `BlobStoreError` with `status === 401` or
`reason === "refused"` — and the worker logs a distinct line rather than leaving the run to
report a bare cache miss:[^server-config][^turbo-server]

```text
the Actions cache refused a request — ACTIONS_RUNTIME_TOKEN has most likely expired, so cache writes from here on are lost
```

Without that classifier the only trace is Turbo itself reporting misses it cannot explain. An
unreadable envelope never reaches the classifier at all — that is an ordinary cache miss, not
an auth failure, and folding it into the same warning would make the message fire on a stale
entry instead of an expired token.[^server-config]

The **S3 backend is unaffected**: it authenticates with its own long-lived credentials rather
than the runner's token, so nothing about this limitation applies to it.[^server-config]

## Why this is acceptable

The token's lifetime is set by the Actions backend, not by this action, and the vast majority
of jobs finish well inside it. Making the failure diagnosable — a named classifier and a log
line that says what happened and why — turns a silent cache-miss mystery into a one-line
explanation, which is the bar the rest of the embedded server's failure posture holds to: no
avoidable job failure, but no swallowed evidence either.

## What a fix would take

There is no refresh channel into a detached child today. A fix would need either a way to
push a renewed `ACTIONS_RUNTIME_TOKEN` into the running worker's environment after spawn, or
a redesign that re-spawns the worker (or reauthenticates in place) before the token expires —
both larger changes than the current detached-process model supports, and neither has been
attempted.

[^server-config]: server-config
[^turbo-server]: turbo-server
