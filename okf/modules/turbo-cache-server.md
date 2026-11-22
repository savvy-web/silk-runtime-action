---
type: Module
title: turbo-cache-server
description: How the action gives turbo a remote cache — the activation table, sign-in to a hosted cache, and the embedded server, a detached worker bundle spawned by main and reaped by post.
status: draft
kind: action
resource: ../../src/turbo-cache
generated:
  by: okfit/claude-code
  at: 2026-11-22T05:18:42Z
sources:
  - id: activation
    resource: ../../src/turbo-cache/activation.ts
  - id: sign-in
    resource: ../../src/turbo-cache/sign-in.ts
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
integrity:
  generated:
    body: cf6f18ab0618e2c3
---

# turbo-cache-server

When `turbo.json` is detected the action gives turbo a remote cache. With `turbo-api` set
it signs the job in to a hosted cache with its GitHub OIDC token; otherwise, and whenever
that sign-in fails, it starts a detached local HTTP server implementing Turbo's
`/v8/artifacts` contract over a `BlobStore` on the GitHub Actions cache, so a consumer's
later `turbo run` steps read and write a shared cache with no Vercel account and no stored
secret.[^activation][^sign-in] The hosted path is on the unreleased branch
`feat/hosted-turbo-cache` as of 2026-11-22, and its two integration jobs have not run yet.

`kind: action` is the nearest enum value this bundle's vocabulary offers
for what is really a separately spawned program with its own runtime — the third of the
build's three bundles alongside `main` and `post`. `resource` names the pure decision
modules; the worker's own entry is `src/turbo-server.ts` and the step that spawns and wires
it is `src/steps/turbo-cache.ts`.[^turbo-server][^turbo-cache-step]

## Module map

| Module | Path | Responsibility |
| --- | --- | --- |
| Activation | `src/turbo-cache/activation.ts` | `resolveTurboCache` — the pure four-rule table; `hasPartialPassthroughCredentials` |
| Sign-in | `src/turbo-cache/sign-in.ts` | `signIn` — mint an OIDC token, trade it at `/auth/github`, mask the answer; `SignInError`; `SIGN_IN_TIMEOUT` |
| Metadata | `src/turbo-cache/meta.ts` | `TurboArtifactMeta` (envelope metadata schema, `meta.ts:29`) and `clampDurationMs` (`meta.ts:52`) |
| Handler | `src/turbo-cache/handler.ts` | `makeTurboHandler` (`handler.ts:168`) — routes, auth, keys, over `BlobStore` |
| Server config | `src/turbo-cache/server-config.ts` | `TURBO_SERVER_ENV`, `readServerConfig`, `serverBlobStoreLayer`, `isAuthShapedFailure` |
| Step | `src/steps/turbo-cache.ts` | `startTurboCache` — mask, resolve, sign in or fall back, export, spawn, persist, probe |
| Worker entry | `src/turbo-server.ts` | HTTP plumbing, shutdown, listen-error handling. Imported by nothing |
| State | `src/state.ts` | `TurboServerState` (`pid`, `port`, `backend`, `logFile`) |
| Teardown | `src/post.ts` | `DetachedProcess.reap`, first and unconditional |

There is no `codec.ts`, no `lifecycle.ts` and no `apply.ts` — the kit's `BlobEnvelope`
replaced the hand-rolled frame, and `DetachedProcess` replaced the spawn/probe/kill trio.

## Activation table

Four sequential first-match rules, evaluated in `resolveTurboCache`
(`src/turbo-cache/activation.ts:57-68`):

| # | Condition | Resolution |
| --- | --- | --- |
| 1 | `turbo.json` absent, **or** `turbo-cache: off` | `off` |
| 2 | `turbo-api` set | `hosted` (sign in; the embedded server when sign-in fails) |
| 3 | `turbo-token` **and** `turbo-team` both set | `passthrough` (external Vercel) |
| 4 | otherwise | `embedded` (GitHub Actions cache) |

Order **is** the behaviour. Rule 1 is first so that `off` is absolute: a shared workflow
turns the cache off for a fork's code, and nothing else a caller passes may mint a token or
send a request after that. Rule 2 precedes rule 3 because a workflow that names a hosted
service means it, whatever Vercel credentials an organization also publishes. `hosted`
carries the `turbo-api` input verbatim; whether it is a usable https URL is sign-in's
question, because the answer to a bad one is a warning and the embedded server, and the
table has no logger and no fallback to give.

Because `ActionInput` treats unsupplied and empty as the same case, `Option.isSome` here is
exactly `!== ""`, and the table needs no empty-string handling of its own.

`"remote"` is deliberately **absent** from `TurboCacheResolution`
(`src/turbo-cache/activation.ts:20-24`). It is the *output* vocabulary for passthrough
(`action.yml`'s `turbo-cache-backend` enum), and the rename happens where outputs are
written — the table names what was decided, not what is reported.

**Partial passthrough credentials** (exactly one of token/team) still fall through to the
embedded server, but now emit a warning (`src/steps/turbo-cache.ts:492-497`). The predicate
`hasPartialPassthroughCredentials` (`src/turbo-cache/activation.ts:80-81`) is pure so the
table stays pure; the step logs the warning after the `off` and `hosted` returns, where its
text is true. A hosted run never gets it: it named a service, so half a Vercel credential is
not what it meant and missed.

## Resolution → effects

| Resolution | Exported environment | `turbo-cache-backend` | `turbo-cache-port` | `post` reaps |
| --- | --- | --- | --- | --- |
| off | none | `none` | empty | no |
| passthrough | `TURBO_TOKEN`, `TURBO_TEAM` | `remote` | empty | no |
| embedded, ready | `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM` | `github` | bound port | yes |
| embedded, not ready | none | `none` | empty | **yes** |
| hosted, signed in | `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM=silk` | `hosted` | empty | no |
| hosted, not signed in | as the two embedded rows | as embedded | as embedded | as embedded |

A hosted run that signed in has no server, no port and no state: `post` has nothing to reap.
`TURBO_API` is the service's URL rebuilt from the input's origin and path, `TURBO_TOKEN` is
the cache token the service issued, and `TURBO_TEAM` is the fixed word `silk`, because the
service ignores the team and turbo refuses to use a remote cache without one
(`HOSTED_TEAM`, `src/steps/turbo-cache.ts:354`). The job summary names the service by host,
`hosted (<host>)`. A hosted run that could not sign in is, from the first spawn on, an
embedded run, and the only trace of the attempt is one warning naming why.

Passthrough exports no `TURBO_API` on purpose: turbo's own default is Vercel's endpoint,
and naming it here would pin a URL this action does not own
(`src/steps/turbo-cache.ts:498-511`).

The `embedded, not ready` row is the interesting one. `StartedTurboCache.state` is `Some`
whenever a child was **spawned**, including when it never became ready
(`src/steps/turbo-cache.ts:98-107`) — `backend` and `port` report what turbo can use,
while `state` reports what `post` has to clean up, and the degraded case is exactly where
the two answers differ.

## Sign-in

`signIn` (`src/turbo-cache/sign-in.ts`) reads `turbo-api` as an https URL or not at all,
with no exception for loopback, mints an OIDC token whose audience is the URL's origin,
sends it as the bearer of `POST <api>/auth/github`, and decodes `{ token, expiresAt }`. The
whole of it is bounded by `SIGN_IN_TIMEOUT`, ten seconds.[^sign-in]

Every failure is a `SignInError` with one of six reasons, and the step answers each with one
warning and the embedded server (`signInOrWarn`, `src/steps/turbo-cache.ts:375-387`):

| Reason | What happened | `detail` |
| --- | --- | --- |
| `notHttps` | The input is not a parseable `https:` URL; nothing was minted or sent | none |
| `oidc` | The runner issued no token | the issuer's reason; `unavailable` is a job without `id-token: write` |
| `refused` | The service answered outside 2xx | the status code |
| `timeout` | Sign-in took longer than ten seconds in total | none |
| `malformed` | A 2xx answer that is not `{ token, expiresAt }` | none |
| `transport` | The request never got an answer | none |

The error has no `cause` and the warning prints nothing but the reason and the detail; see
[turbo-secret-handling](../decisions/turbo-secret-handling.md). What this mode cannot do is
in [hosted-cache-reach](../limitations/hosted-cache-reach.md).

## Access log

The worker writes one line per artifact request to its log file (`accessLine`,
`src/turbo-cache/access-log.ts`): method, task hash, status, an outcome word, the
artifact's size and the elapsed time. The readiness probe and the telemetry sink are left
out. `post` reads the file back after the reap and prints it as a
`Turbo remote cache activity` step whose result line is `tallyAccessLog`'s totals, with the
log folded beneath it; the writer and the reader live in one module so the outcome words
cannot drift. The step is the only place
the detached worker's output is ever visible on a hosted runner, and it is emitted for a
server that never became ready as well. The bearer token is never part of a line.

## Lifecycle

```text
main — program.ts "Start turbo remote cache" group (LAST, or just before the install when its scripts will run)
  maskSuppliedSecrets(inputs)            # unconditional, BEFORE the table
  resolveTurboCache(...)
    off          -> DISABLED
    hosted       -> signInOrWarn(api)                 # cannot fail
                      Some -> export TURBO_API / TURBO_TOKEN (via Secret.forRunnerFile)
                              / TURBO_TEAM=silk       # no server, no state
                      None -> one warning, then the embedded branch below
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
(`src/steps/turbo-cache.ts:287-298`), so a child that hangs half-started is still
reapable: the window in which a leaked process could survive the job is the width of one
`ActionState.save` rather than the whole six-second readiness budget. A save failure
degrades to a warning naming the un-reapable pid.

## Worker configuration

Config reaches the worker through the **environment and nothing else**
(`src/turbo-cache/server-config.ts:6-25`): it is spawned detached with no channel back to
the action, and a command line would put the token in the process table.
`TURBO_SERVER_ENV` is a shared constant so the two halves of the handoff cannot drift, and
keeps the `TURBOGHA_` prefix so an operator reading a process list sees what they always
have. Full field-by-field detail — the `TURBOGHA_*` table and the env-merge order — lives
in the
[turbo-worker-environment](../interfaces/turbo-worker-environment.md) interface concept;
this module names only that the handoff is environment-only and that
`DetachedProcess.spawn` merges it **over** the parent's environment, which is what carries
`ACTIONS_RUNTIME_TOKEN` through to the GitHub backend without this step ever reading it.

The port is **fixed** (`DEFAULT_TURBO_SERVER_PORT = 41_230`,
`src/turbo-cache/server-config.ts:37`) rather than negotiated — see
[turbo-cache-backends](../decisions/turbo-cache-backends.md) and
[one-embedded-server-per-runner](../limitations/one-embedded-server-per-runner.md).

## Shutdown

```ts
// src/turbo-server.ts:134-147
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
`src/turbo-server.ts:30`) is what keeps "waits for what is in flight" from becoming
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
// src/turbo-server.ts:116-123
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
(`src/turbo-cache/server-config.ts:94-97`) is load-bearing rather than tidy: `listen`
throws **synchronously** on a bad port, so the `error` listener above never fires for that
case and the process would die with a stack trace instead of the one line it exists to
print.

## Request buffering

The worker buffers each whole request body with **no size cap**
(`src/turbo-server.ts:67-111`): turbo sends a complete artifact per request, and a cap
invented here would fail a large monorepo's build rather than slow it down.

## Resolving the worker bundle

```ts
// src/steps/turbo-cache.ts:159
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

- [turbo-cache-backends](../decisions/turbo-cache-backends.md)
- [turbo-secret-handling](../decisions/turbo-secret-handling.md)
- [detached-worker-outputs-layer](../conventions/detached-worker-outputs-layer.md)
- [actions-runtime-token-lifetime](../limitations/actions-runtime-token-lifetime.md)
- [hosted-cache-reach](../limitations/hosted-cache-reach.md)
- [one-embedded-server-per-runner](../limitations/one-embedded-server-per-runner.md)
- [turbo-artifacts-protocol](../interfaces/turbo-artifacts-protocol.md)
- [turbo-worker-environment](../interfaces/turbo-worker-environment.md)

[^activation]: ../../src/turbo-cache/activation.ts
[^sign-in]: ../../src/turbo-cache/sign-in.ts
[^turbo-server]: ../../src/turbo-server.ts
[^turbo-cache-step]: ../../src/steps/turbo-cache.ts
