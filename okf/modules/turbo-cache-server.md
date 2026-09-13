---
type: Module
title: turbo-cache-server
description: The embedded Turborepo remote-cache server — a detached worker bundle spawned by main and reaped by post.
status: draft
kind: action
resource: ../../src/turbo-cache
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 402112dcb52977f34346a90016beb73e33b1684d14492f4dd883bb77d18d9a8d
sources:
  - id: activation
    resource: ../../src/turbo-cache/activation.ts
  - id: server-config
    resource: ../../src/turbo-cache/server-config.ts
  - id: handler
    resource: ../../src/turbo-cache/handler.ts
  - id: meta
    resource: ../../src/turbo-cache/meta.ts
  - id: turbo-cache-step
    resource: ../../src/steps/turbo-cache.ts
  - id: turbo-server
    resource: ../../src/turbo-server.ts
  - id: state
    resource: ../../src/state.ts
---

# turbo-cache-server

When `turbo.json` is detected the action starts a detached local HTTP server implementing
Turbo's `/v8/artifacts` contract over a generic `BlobStore` (GitHub Actions cache or
S3/SigV4), so a consumer's later `turbo run` steps read and write a shared cache with no
Vercel account. `kind: action` is the nearest enum value this bundle's vocabulary offers
for what is really a separately spawned program with its own runtime — the third of the
build's three bundles alongside `main` and `post`. `resource` names the pure decision
modules; the worker's own entry is `src/turbo-server.ts` and the step that spawns and wires
it is `src/steps/turbo-cache.ts`.[^turbo-server][^turbo-cache-step]

## Module map

| Module | Path | Responsibility |
| --- | --- | --- |
| Activation | `src/turbo-cache/activation.ts` | `resolveTurboCache` — the pure four-rule table; `hasPartialPassthroughCredentials` |
| Metadata | `src/turbo-cache/meta.ts` | `TurboArtifactMeta` (envelope metadata schema, `meta.ts:29`) and `clampDurationMs` (`meta.ts:52`) |
| Handler | `src/turbo-cache/handler.ts` | `makeTurboHandler` (`handler.ts:157`) — routes, auth, keys, over `BlobStore` |
| Server config | `src/turbo-cache/server-config.ts` | `TURBO_SERVER_ENV`, `readServerConfig`, `serverBlobStoreLayer`, `isAuthShapedFailure` |
| Step | `src/steps/turbo-cache.ts` | `startTurboCache` — mask, resolve, export, spawn, persist, probe |
| Worker entry | `src/turbo-server.ts` | HTTP plumbing, shutdown, listen-error handling. Imported by nothing |
| State | `src/state.ts` | `TurboServerState` (`pid`, `port`, `backend`, `logFile`) |
| Teardown | `src/post.ts` | `DetachedProcess.reap`, first and unconditional |

There is no `codec.ts`, no `lifecycle.ts` and no `apply.ts` — the kit's `BlobEnvelope`
replaced the hand-rolled frame, and `DetachedProcess` replaced the spawn/probe/kill trio.

## Activation table

Four sequential first-match rules, evaluated in `resolveTurboCache`
(`src/turbo-cache/activation.ts:70-95`):

| # | Condition | Resolution |
| --- | --- | --- |
| 1 | `turbo.json` absent, **or** `turbo-cache: off` | `off` |
| 2 | `turbo-token` **and** `turbo-team` both set | `passthrough` (external Vercel) |
| 3 | `turbo-s3-bucket` set | `embedded` / `s3` |
| 4 | otherwise | `embedded` / `github` |

Order **is** the behaviour: passthrough beats S3 when both are configured, and rule 3
probes the **bucket alone** — S3 credentials without a bucket resolve to the GitHub
backend rather than to a misconfigured S3 one.

Because `ActionInput` treats unsupplied and empty as the same case, `Option.isSome` here is
exactly `!== ""`, and the table needs no empty-string handling of its own.

`"remote"` is deliberately **absent** from `TurboCacheResolution`
(`src/turbo-cache/activation.ts:35-39`). It is the *output* vocabulary for passthrough
(`action.yml`'s `turbo-cache-backend` enum), and the rename happens where outputs are
written — the table names what was decided, not what is reported.

**Partial passthrough credentials** (exactly one of token/team) still fall through to the
embedded server, but now emit a warning (`src/steps/turbo-cache.ts:398-403`). The predicate
`hasPartialPassthroughCredentials` (`src/turbo-cache/activation.ts:107-108`) is pure so the
table stays pure; the step logs the warning, after the `off` return, where its text is
true.

## Resolution → effects

| Resolution | Exported environment | `turbo-cache-backend` | `turbo-cache-port` | `post` reaps |
| --- | --- | --- | --- | --- |
| off | none | `none` | empty | no |
| passthrough | `TURBO_TOKEN`, `TURBO_TEAM` | `remote` | empty | no |
| embedded, ready | `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM` | `github` / `s3` | bound port | yes |
| embedded, not ready | none | `none` | empty | **yes** |

Passthrough exports no `TURBO_API` on purpose: turbo's own default is Vercel's endpoint,
and naming it here would pin a URL this action does not own
(`src/steps/turbo-cache.ts:404-411`).

The last row is the interesting one. `StartedTurboCache.state` is `Some` whenever a child
was **spawned**, including when it never became ready
(`src/steps/turbo-cache.ts:85-100`) — `backend` and `port` report what turbo can use,
while `state` reports what `post` has to clean up, and the degraded case is exactly where
the two answers differ.

## Server lifecycle

```text
main — program.ts "Start turbo remote cache" group (LAST in the pipeline)
  maskSuppliedSecrets(inputs)            # unconditional, BEFORE the table
  resolveTurboCache(...)
    off          -> DISABLED
    passthrough  -> exportVariable TURBO_TOKEN (via Secret.forRunnerFile) / TURBO_TEAM
    embedded     -> credential = randomUUID()
                    spawnEnvironment(...)            # TURBOGHA_* only
                    DetachedProcess.spawn({ command: process.execPath,
                                            args: [serverEntry], logFile, env })
                    ActionState.save(turboServer, TurboServerState)   # BEFORE the probe
                    DetachedProcess.awaitReady(                        # via ops seam
                      readinessProbe(port))
                      ready     -> export TURBO_API / TURBO_TOKEN / TURBO_TEAM
                      exhausted -> logError, continue WITHOUT a remote cache

post — post.ts, first and unconditional, before any branch that can return early
  getOptional(turboServer, TurboServerState)
    Some -> reap(pid)   # false ("already gone") is the NORMAL ending
    None -> debug line
```

The state save sits **between** the spawn and the readiness wait
(`src/steps/turbo-cache.ts:296-311`), so a child that hangs half-started is still
reapable: the window in which a leaked process could survive the job is the width of one
`ActionState.save` rather than the whole six-second readiness budget. A save failure
degrades to a warning naming the un-reapable pid.

## Worker configuration

Config reaches the worker through the **environment and nothing else**
(`src/turbo-cache/server-config.ts:6-32`): it is spawned detached with no channel back to
the action, and a command line would put the token in the process table.
`TURBO_SERVER_ENV` is a shared constant so the two halves of the handoff cannot drift, and
keeps the `TURBOGHA_` prefix so an operator reading a process list sees what they always
have. Full field-by-field detail — the `TURBOGHA_*` table, the omit-not-empty rule, and the
env-merge order — lives in the
[turbo-worker-environment](../interfaces/turbo-worker-environment.md) interface concept;
this module names only that the handoff is environment-only and that
`DetachedProcess.spawn` merges it **over** the parent's environment, which is what carries
`ACTIONS_RUNTIME_TOKEN` through to the GitHub backend without this step ever reading it.

The port is **fixed** (`DEFAULT_TURBO_SERVER_PORT = 41_230`,
`src/turbo-cache/server-config.ts:44`) rather than negotiated — see
[embedded-turbo-server](../decisions/embedded-turbo-server.md) and
[one-embedded-server-per-runner](../limitations/one-embedded-server-per-runner.md).

## Shutdown

```ts
// src/turbo-server.ts:128-141
process.on("SIGTERM", () => {
  setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();   // 2s
  server.close(() => {
    void runtime.dispose().then(
      () => process.exit(0),
      () => process.exit(0),
    );
  });
  server.closeIdleConnections();
});
```

`close` stops accepting and waits for what is in flight; disposing the runtime releases the
backend's client. The **deadline** (`SHUTDOWN_DEADLINE_MS = 2_000`,
`src/turbo-server.ts:29`) is what keeps "waits for what is in flight" from becoming
"outlives the job": `close` never calls back while a request hangs, and `post` does not
wait after signalling. `unref` keeps the timer from holding the process open on the normal
path, where the callback wins the race.

On the `post` side there is **no wait and no `SIGKILL` escalation**
(`src/post.ts:255-275`). The signal is the whole of it: the runner reclaims the machine
moments later, and a post phase that blocked on a child's exit would trade a bounded leak
for an unbounded hang. A reap returning `false` — the child is already gone — is the
**normal** ending, not a failure.

## Listen failures

```ts
// src/turbo-server.ts:110-117
server.on("error", (error: NodeJS.ErrnoException) => {
  say(
    error.code === "EADDRINUSE"
      ? `port ${config.port} is already in use — another cache server is running on this runner`
      : `cannot listen on 127.0.0.1:${config.port}: ${error.message}`,
  );
  process.exit(1);
});
```

The **port range check** in `readServerConfig`
(`src/turbo-cache/server-config.ts:104-112`) is load-bearing rather than tidy: `listen`
throws **synchronously** on a bad port, so the `error` listener above never fires for that
case and the process would die with a stack trace instead of the one line it exists to
print.

## Request buffering

The worker buffers each whole request body with **no size cap**
(`src/turbo-server.ts:66-105`): turbo sends a complete artifact per request, and a cap
invented here would fail a large monorepo's build rather than slow it down.

## Resolving the worker bundle

```ts
// src/steps/turbo-cache.ts:127
export const defaultServerEntry = (): string => join(dirname(fileURLToPath(import.meta.url)), "turbo-server.js");
```

The build emits `dist/main.js` and `dist/turbo-server.js` side by side and this module is
bundled into the former, so the sibling resolution holds **only in the built artifact**.
Run from source it points at a non-existent file beside `src/steps/`, which is why every
test supplies `StartTurboCacheArgs.serverEntry` rather than exercising it
(`src/steps/turbo-cache.ts:68-69`).

## "Turbo: enabled|disabled" is detection-sourced

The closing log group's turbo line reports **detection**, not the cache outcome; the panel
row carries the cache truth. This asymmetry with the Biome line (which reports the
install) is deliberate: Biome's line names an install the run performed, turbo's names a
detection.

## Related concepts

- [embedded-turbo-server](../decisions/embedded-turbo-server.md)
- [turbo-secret-handling](../decisions/turbo-secret-handling.md)
- [detached-worker-outputs-layer](../conventions/detached-worker-outputs-layer.md)
- [actions-runtime-token-lifetime](../limitations/actions-runtime-token-lifetime.md)
- [one-embedded-server-per-runner](../limitations/one-embedded-server-per-runner.md)
- [turbo-artifacts-protocol](../interfaces/turbo-artifacts-protocol.md)
- [turbo-worker-environment](../interfaces/turbo-worker-environment.md)

[^turbo-server]: ../../src/turbo-server.ts
[^turbo-cache-step]: ../../src/steps/turbo-cache.ts
