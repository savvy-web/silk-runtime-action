---
title: Turbo worker environment — the main-to-worker handoff contract
description: The TURBOGHA_* environment variables the detached turbo cache server reads, and how they are assembled and consumed.
status: draft
type: Interface
kind: runtime
resource: ../../src/turbo-cache/server-config.ts
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 0d345232e9aeeccbcbf59ed3ac9dc276da943a5200b96ece932c17902bc69bb8
sources:
  - id: server-config
    resource: ../../src/turbo-cache/server-config.ts
---

# Turbo worker environment — the main-to-worker handoff contract

The detached turbo cache server (`src/turbo-server.ts`) is spawned with no channel back to the
main process — no stdin, no IPC — so **every** configuration value it needs arrives through its
environment, and nothing else.[^server-config] A command line was rejected as an alternative
because it would put the bearer token in the process table, readable by anything that can list
processes on the runner.

`TURBO_SERVER_ENV` (`server-config.ts:20-32`) is a single shared constant naming every
variable, imported by both the step that assembles the spawn environment and the worker that
reads it back — a shared name table is what keeps the two halves of the handoff from drifting
independently. The `TURBOGHA_` prefix is kept from the legacy implementation so an operator
reading a runner's process list sees the same thing they always have.

## The variable table

| Variable | Meaning |
| --- | --- |
| `TURBOGHA_PORT` | Listen port; a value outside `1…65535` falls back to `DEFAULT_TURBO_SERVER_PORT` (`41230`) |
| `TURBOGHA_PREFIX` | Key namespace |
| `TURBOGHA_TOKEN` | Bearer credential — **required**; no token means no server |
| `TURBOGHA_BACKEND` | `s3` selects the S3 backend; anything else is the GitHub Actions cache |
| `TURBOGHA_S3_BUCKET` / `_REGION` / `_ENDPOINT` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_SESSION_TOKEN` / `_PREFIX` | S3 backend settings |

(`server-config.ts:20-32`)

## Optional settings are omitted, not written empty

The three optional S3 fields — `endpoint`, `sessionToken`, `prefix` — are spread into
`s3ConfigFrom`'s result only when non-empty (`server-config.ts:77-90`). This is not a style
choice: an empty `endpoint` would point the signer at nothing rather than at AWS, and an empty
`prefix` would namespace every key under a leading separator. The worker reads an unset
variable and an empty one as the same case (`read`, `server-config.ts:60`), so writing an
empty string instead of omitting the key would change nothing about correctness but would make
the process's environment harder to read at a glance — an omitted variable states its own
absence in a process listing, where an empty one invites the question of whether it was meant
to be something.

## Fail closed on a missing token

`readServerConfig` **fails** — rather than booting with authentication disabled — when
`TURBOGHA_TOKEN` is absent (`server-config.ts:117-121`). The historical behavior read an
absent token as an empty one, which the handler's `authorized` check treats as "authentication
disabled" (see [turbo-artifacts-protocol](./turbo-artifacts-protocol.md)) — so a spawn that
somehow lost its environment would leave an **open** cache server listening on the runner. The
check lives in the worker rather than in the handler on purpose: the handler's permissive empty-
token branch is what a handler unit test needs, and the step that spawns the worker always
supplies a token, so a missing one at the worker means something upstream is wrong, and exiting
says so rather than serving unauthenticated.

## Port range check

A port that is not a whole number in `1..65535` falls back to `DEFAULT_TURBO_SERVER_PORT`
(`server-config.ts:122-124`). This check is load-bearing, not defensive padding: Node's
`listen` throws **synchronously** on a bad port, so the worker's `error` event listener never
fires for that case — without the range check the process would die with an unhandled stack
trace instead of printing the one diagnostic line it exists to print.

## Environment merge over the parent

`DetachedProcess.spawn` merges the assembled `TURBOGHA_*` environment **over** the parent
process's environment, not in place of it (`server-config.ts:9-19` note on the config table's
purpose; the merge itself is the spawn call in `src/steps/turbo-cache.ts`). This is what
carries `ACTIONS_RUNTIME_TOKEN` through to the GitHub backend without the spawning step ever
reading that variable itself — the worker's `ActionEnvironment` layer picks it up from the
inherited environment at its own construction time. See
[actions-runtime-token-lifetime](../limitations/actions-runtime-token-lifetime.md) for the
consequence of capturing that token once, at spawn time.

## Fixed port

The port is **fixed** (`41230`) rather than negotiated (`server-config.ts:34-44`). Turbo
reaches the server through the exported `TURBO_API` (see
[action-contract](./action-contract.md)), so a negotiated port would technically work — but it
would also mean the action and the worker could disagree about the port whenever the handoff
between them failed, and nothing on a runner competes for this one port. See
[one-embedded-server-per-runner](../limitations/one-embedded-server-per-runner.md) for the
limitation this trades for.

[^server-config]: server-config
