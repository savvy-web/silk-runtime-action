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
sources:
  - id: server-config
    resource: ../../src/turbo-cache/server-config.ts
  - id: turbo-cache-step
    resource: ../../src/steps/turbo-cache.ts
integrity:
  generated:
    body: 0d345232e9aeeccb
---

# Turbo worker environment — the main-to-worker handoff contract

The detached turbo cache server (`src/turbo-server.ts`) is spawned with no channel back to the
main process — no stdin, no IPC — so **every** configuration value it needs arrives through its
environment, and nothing else.[^server-config] A command line was rejected as an alternative
because it would put the bearer token in the process table, readable by anything that can list
processes on the runner.

`TURBO_SERVER_ENV` (`server-config.ts:20-25`) is a single shared constant naming every
variable, imported by both the step that assembles the spawn environment and the worker that
reads it back — a shared name table is what keeps the two halves of the handoff from drifting
independently. The `TURBOGHA_` prefix is kept from the legacy implementation so an operator
reading a runner's process list sees the same thing they always have.

This contract covers the embedded server only. A run that signed in to a hosted cache
spawns no worker and writes none of these variables.

## The variable table

| Variable | Meaning |
| --- | --- |
| `TURBOGHA_PORT` | Listen port; a value outside `1…65535` falls back to `DEFAULT_TURBO_SERVER_PORT` (`41230`) |
| `TURBOGHA_PREFIX` | Key namespace |
| `TURBOGHA_TOKEN` | Bearer credential — **required**; no token means no server |
| `TURBOGHA_BACKEND` | Written as `github`, and **not read** |

(`server-config.ts:20-25`)

The step writes all four on every spawn (`spawnEnvironment`,
`src/steps/turbo-cache.ts:219-228`).[^turbo-cache-step] The worker reads an unset variable
and an empty one as the same case (`read`, `server-config.ts:61`), so an empty
`TURBOGHA_PREFIX` is simply no namespace.

## `TURBOGHA_BACKEND` is written and not read

The embedded server has one store, the GitHub Actions cache, so `readServerConfig` never
looks at `TURBOGHA_BACKEND`: whatever the variable says, `TurboServerConfig.backend` is the
literal `github` (`server-config.ts:89-102`). The step still writes it, for an operator
reading a runner's process list, and the worker still names the backend in its startup line
and in the line that reports a store failure. A value other than `github` therefore selects
nothing and reports nothing.[^server-config]

## Fail closed on a missing token

`readServerConfig` **fails** — rather than booting with authentication disabled — when
`TURBOGHA_TOKEN` is absent (`server-config.ts:90-93`). The historical behavior read an
absent token as an empty one, which the handler's `authorized` check treats as "authentication
disabled" (see [turbo-artifacts-protocol](./turbo-artifacts-protocol.md)) — so a spawn that
somehow lost its environment would leave an **open** cache server listening on the runner. The
check lives in the worker rather than in the handler on purpose: the handler's permissive empty-
token branch is what a handler unit test needs, and the step that spawns the worker always
supplies a token, so a missing one at the worker means something upstream is wrong, and exiting
says so rather than serving unauthenticated.

## Port range check

A port that is not a whole number in `1..65535` falls back to `DEFAULT_TURBO_SERVER_PORT`
(`server-config.ts:94-97`). This check is load-bearing, not defensive padding: Node's
`listen` throws **synchronously** on a bad port, so the worker's `error` event listener never
fires for that case — without the range check the process would die with an unhandled stack
trace instead of printing the one diagnostic line it exists to print.

## Environment merge over the parent

`DetachedProcess.spawn` merges the assembled `TURBOGHA_*` environment **over** the parent
process's environment, not in place of it (`server-config.ts:6-19` note on the config table's
purpose; the merge itself is the spawn call in `src/steps/turbo-cache.ts`). This is what
carries `ACTIONS_RUNTIME_TOKEN` through to the GitHub backend without the spawning step ever
reading that variable itself — the worker's `ActionEnvironment` layer picks it up from the
inherited environment at its own construction time. See
[actions-runtime-token-lifetime](../limitations/actions-runtime-token-lifetime.md) for the
consequence of capturing that token once, at spawn time.

## Fixed port

The port is **fixed** (`41230`) rather than negotiated (`server-config.ts:27-37`). Turbo
reaches the server through the exported `TURBO_API` (see
[action-contract](./action-contract.md)), so a negotiated port would technically work — but it
would also mean the action and the worker could disagree about the port whenever the handoff
between them failed, and nothing on a runner competes for this one port. See
[one-embedded-server-per-runner](../limitations/one-embedded-server-per-runner.md) for the
limitation this trades for.

[^server-config]: server-config
[^turbo-cache-step]: turbo-cache-step
