---
type: Limitation
title: One embedded Turbo cache server per runner
description: The embedded Turbo remote-cache server listens on a fixed port, so a second concurrent job on the same runner cannot start its own server and runs without a remote cache instead.
status: draft
bounds: ../modules/turbo-cache-server.md
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: a8830aef7eeca580b4f16a2ac540ff54dc1656b9777992bd2fe9738ea0d4e7a4
sources:
  - id: server-config
    resource: ../../src/turbo-cache/server-config.ts
  - id: turbo-server
    resource: ../../src/turbo-server.ts
tags:
  - ci
---

# One embedded Turbo cache server per runner

## Trigger

The embedded Turbo remote-cache server always listens on the same fixed port,
`DEFAULT_TURBO_SERVER_PORT = 41_230`, rather than negotiating a free one.[^server-config] A
second job that starts an embedded server on the same runner — self-hosted runners reused
across concurrent jobs are the case that matters, since GitHub-hosted runners are one job
each — tries to bind the same port the first job's server already holds.

## Symptom

The second server's `listen` call fails with `EADDRINUSE`. The worker's error handler names
this case specifically and prints one line before exiting, rather than dying with an
unhandled exception or waiting out its readiness budget in silence:[^turbo-server]

```text
port 41230 is already in use — another cache server is running on this runner
```

The job that lost the race continues with Turbo running and no remote cache: the embedded
server never becomes ready, so the step that starts it degrades to a warning and exports no
`TURBO_API`. The build is not failed by this — it is simply cacheless for that run.

## Why this is acceptable

Turbo reaches the server through the exported `TURBO_API` environment variable, so a
negotiated port would work mechanically — but it would also mean the action and the server
could disagree about which port was actually bound whenever the handoff between them failed,
trading one small, loud, diagnosable failure mode (a fixed port occasionally colliding) for a
larger, quieter one (a negotiated port silently mismatched). GitHub-hosted runners never
experience this at all, since each job gets its own machine; only self-hosted runners running
more than one job at a time are exposed, and for that case a named `EADDRINUSE` line beats a
coordination protocol built to serve it.

## What a fix would take

Port negotiation between the spawning step and the detached worker, plus a way to carry the
negotiated port back into the step before it exports `TURBO_API` — a real design change to
the handoff, not a parameter tweak, and one that has not been made because the runners this
action targets do not run concurrent jobs against the same fixed port today.

[^server-config]: server-config
[^turbo-server]: turbo-server
