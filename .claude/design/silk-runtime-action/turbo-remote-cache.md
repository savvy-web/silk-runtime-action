---
status: current
module: silk-runtime-action
category: integration
created: 2026-06-23
updated: 2026-08-02
last-synced: 2026-08-02
completeness: 95
related:
  - ./architecture.md
  - ./caching-strategy.md
  - ./effect-service-model.md
  - ./build-and-distribution.md
  - ./testing-strategy.md
dependencies: []
---

# Turbo remote cache

Embedded Turborepo remote-cache server. When `turbo.json` is detected the action starts a detached local HTTP server implementing Turbo's `/v8/artifacts` contract over a generic `BlobStore` (GitHub Actions cache or S3/SigV4), so Turbo shares task-output artifacts across jobs and runs without a Vercel account.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Rationale](#rationale)
4. [Implementation details](#implementation-details)
5. [Known limitations](#known-limitations)
6. [Related documentation](#related-documentation)

---

## Overview

Turbo speaks an HTTP remote-cache protocol. Rather than require a Vercel account, the action stands that protocol up locally and persists artifacts to storage the runner already has. Turbo is pointed at `http://127.0.0.1:<port>` through `TURBO_API` / `TURBO_TOKEN` / `TURBO_TEAM`, so the consumer's later `turbo run` steps transparently read and write the embedded cache.

The whole subsystem is an **enhancement that never fails the job**: every failure degrades to a warning and leaves Turbo running with no remote cache. The local `.turbo/cache` file layer still applies — see [caching strategy](./caching-strategy.md#turbos-local-artifact-cache).

**Key features:**

- A pure activation table (`resolveTurboCache`): off, passthrough, embedded-s3, embedded-github.
- A detached worker (`src/turbo-server.ts`, the third bundle) spawned by main and reaped by post.
- Artifact framing owned by the kit's `BlobEnvelope`; this action owns only the metadata's *meaning*.
- A fresh random bearer credential per run.
- Graceful `SIGTERM` shutdown with a deadline, and an `EADDRINUSE` message instead of an unhandled exception.
- `ActionOutputs.layerDetached` in the worker — a secret-leak fix, not a tidiness one.

**When to load this doc:**

- Changing activation, backend selection, the handler routes or the key layout.
- Debugging why the embedded cache degraded, or why post did not reap the server.
- Touching anything the worker reads out of its environment.

---

## Current state

### Module map

| Module | Path | Responsibility |
| --- | --- | --- |
| Activation | `src/turbo-cache/activation.ts` | `resolveTurboCache` — the pure four-rule table; `hasPartialPassthroughCredentials` |
| Metadata | `src/turbo-cache/meta.ts` | `TurboArtifactMeta` (envelope metadata schema) and `clampDurationMs` |
| Handler | `src/turbo-cache/handler.ts` | `makeTurboHandler` — routes, auth, keys, over `BlobStore` |
| Server config | `src/turbo-cache/server-config.ts` | `TURBO_SERVER_ENV`, `readServerConfig`, `serverBlobStoreLayer`, `isAuthShapedFailure` |
| Step | `src/steps/turbo-cache.ts` | `startTurboCache` — mask, resolve, export, spawn, persist, probe |
| Worker entry | `src/turbo-server.ts` | HTTP plumbing, shutdown, listen-error handling. Imported by nothing |
| State | `src/state.ts` | `TurboServerState` (pid, port, backend, logFile) |
| Teardown | `src/post.ts` | `DetachedProcess.reap`, first and unconditional |

There is no `codec.ts`, no `lifecycle.ts` and no `apply.ts` — the kit's `BlobEnvelope` replaced the hand-rolled frame, and `DetachedProcess` replaced the spawn/probe/kill trio.

### Activation table

Four sequential first-match rules, evaluated in `resolveTurboCache`:

| # | Condition | Resolution |
| --- | --- | --- |
| 1 | `turbo.json` absent, **or** `turbo-cache: off` | `off` |
| 2 | `turbo-token` **and** `turbo-team` both set | `passthrough` (external Vercel) |
| 3 | `turbo-s3-bucket` set | `embedded` / `s3` |
| 4 | otherwise | `embedded` / `github` |

Order **is** the behaviour: passthrough beats S3 when both are configured, and rule 3 probes the **bucket alone** — S3 credentials without a bucket resolve to the GitHub backend rather than to a misconfigured S3 one.

Because `ActionInput` treats unsupplied and empty as the same case, `Option.isSome` here is exactly v1's `!== ""`, and the table needs no empty-string handling of its own.

`"remote"` is deliberately **absent** from `TurboCacheResolution`. It is the *output* vocabulary for passthrough (`action.yml`'s `turbo-cache-backend` enum), and the rename happens where outputs are written — the table names what was decided, not what is reported.

**Partial passthrough credentials** (exactly one of token/team) still fall through to the embedded server, matching v1, but now emit a warning. v1 said nothing at all, so the run silently started an embedded server instead of talking to Vercel — indistinguishable in the log from a workflow that configured no passthrough. The predicate is pure so the table stays pure; the step logs the warning, after the `off` return, where its text is true.

### Resolution → effects

| Resolution | Exported environment | `turbo-cache-backend` | `turbo-cache-port` | `post` reaps |
| --- | --- | --- | --- | --- |
| off | none | `none` | empty | no |
| passthrough | `TURBO_TOKEN`, `TURBO_TEAM` | `remote` | empty | no |
| embedded, ready | `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM` | `github` / `s3` | bound port | yes |
| embedded, not ready | none | `none` | empty | **yes** |

Passthrough exports no `TURBO_API` on purpose: turbo's own default is Vercel's endpoint, and naming it here would pin a URL this action does not own.

The last row is the interesting one. `StartedTurboCache.state` is `Some` whenever a child was **spawned**, including when it never became ready — `backend` and `port` report what turbo can use, while `state` reports what `post` has to clean up, and the degraded case is exactly where the two answers differ.

### Server lifecycle

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
                      DetachedProcess.httpProbe(.../v8/artifacts/status))
                      ready     -> export TURBO_API / TURBO_TOKEN / TURBO_TEAM
                      exhausted -> logError, continue WITHOUT a remote cache

post — post.ts, first and unconditional, before any branch that can return early
  getOptional(turboServer, TurboServerState)
    Some -> reap(pid)   # false ("already gone") is the NORMAL ending
    None -> debug line
```

The state save sits **between** the spawn and the readiness wait, so a child that hangs half-started is still reapable: the window in which a leaked process could survive the job is the width of one `ActionState.save` rather than the whole six-second readiness budget. A save failure degrades to a warning naming the un-reapable pid.

### Handler contract

Routes, in order:

| Path | Methods | Answer |
| --- | --- | --- |
| `/v8/artifacts/status` | any | `200 {"status":"enabled"}` — **open, never authenticated** |
| `/v8/artifacts/events` | any | `200 []`, authenticated |
| `/v8/artifacts/:hash` | `PUT` | `202` |
| | `HEAD` | `200` / `404` |
| | `GET` | `200` + body / `404` |
| | other | `405` |
| anything else | any | `404` |

`/status` stays open because it is the readiness probe the spawning step polls before it has anything to authenticate with. `/events` is turbo-client traffic and **is** authenticated, where v1 left it open. Authentication happens **after** the route match, so an unroutable path is a 404 rather than a 401 — v1's order, kept, because it tells a misconfigured client which of the two things is wrong.

The bearer prefix is optional and case-insensitive (`/^Bearer\s+/i`), so a client sending the bare token is accepted. An **empty** `expectedToken` authorizes everything; that permissive branch is what a handler test needs, and `readServerConfig` is what makes it unreachable in production (see below).

A `GET` answers 404 both for a miss **and** for a blob whose envelope will not decode into `TurboArtifactMeta` — a pre-envelope blob, a newer revision, a truncated frame. Corrupt is a miss: turbo rebuilds, where a decoded-anyway artifact would be served as if it were real. Every other failure collapses to a bare 500, because there is nothing turbo does with a message.

Query strings are stripped before routing (`?teamId=…&slug=…` rides on every request) and no route reads a parameter.

### Blob keys and metadata

Keys are `${prefix}${hash}`, with a `/` inserted when a non-empty prefix does not already end in one. That separator is new: v1 concatenated, so prefix `p` wrote `phash…` and two namespaces whose prefixes were substrings of one another shared entries.

There is **no `v2/` version segment any more**. The kit's `BlobEnvelope` carries the format revision in-band and reports a mismatch as a typed `BlobEnvelopeError`, which the handler turns into a miss; stale entries age out through the backend's own eviction.

```ts
export class TurboArtifactMeta extends Schema.Class<TurboArtifactMeta>("TurboArtifactMeta")({
  tag: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
}) {}
```

`durationMs` **must** round-trip: turbo computes `timeSaved` from the `x-artifact-duration` it gets back on a remote hit. It is clamped at the handler boundary to a whole number in `0…4294967295` — v1's `uint32` frame range, kept even though JSON would carry anything, because the clamp is what stops a nonsensical header from becoming a `timeSaved` a user reads. `Math.trunc(x) || 0` is v1's `NaN` guard verbatim.

An **empty** tag is stored as an empty string and dropped on the way out by the handler's truthiness check rather than echoed back empty — v1's behaviour.

The encoded form has to be plain JSON for the same reason cross-phase state does: the envelope writes metadata as JSON between its header and the body, so `Schema.NullOr` rather than `Schema.Option`. See [caching strategy](./caching-strategy.md#cross-phase-state-protocol).

### Worker configuration

Config reaches the worker through the **environment and nothing else**: it is spawned detached with no channel back to the action, and a command line would put the token in the process table. `TURBO_SERVER_ENV` is a shared constant so the two halves of the handoff cannot drift, and keeps v1's `TURBOGHA_` prefix so an operator reading a process list sees what they always have.

| Variable | Meaning |
| --- | --- |
| `TURBOGHA_PORT` | Listen port; a value outside `1…65535` falls back to the default |
| `TURBOGHA_PREFIX` | Key namespace |
| `TURBOGHA_TOKEN` | Bearer credential — **required**, no token means no server |
| `TURBOGHA_BACKEND` | `s3` selects S3; anything else is the GitHub Actions cache |
| `TURBOGHA_S3_*` | bucket, region, endpoint, access key id, secret access key, session token, prefix |

Optional settings are **omitted** rather than written empty; the worker reads unset and empty as the same case, and an omitted variable is clearer in a process listing. The three optional S3 fields are spread in only when non-empty — an empty endpoint would point the signer at nothing rather than at AWS, and an empty prefix would namespace every key under a leading separator.

`DetachedProcess.spawn` merges this environment **over** the parent's, which is what carries `ACTIONS_RUNTIME_TOKEN` through to the GitHub backend without this step ever reading it.

The port is **fixed** (`41230`) rather than negotiated. Turbo reaches the server through the exported `TURBO_API`, so negotiation would work — but it would also mean the action and the server disagreeing about the port whenever the handoff failed, and nothing on a runner competes for this one. The missing half was added instead: a listen that fails says so and exits (see below).

### Secret handling

Three things happen, all before anything is spawned:

1. **Masking is unconditional and runs before the activation table.** A secret a workflow supplied is worth redacting whether or not the resolution uses it: a run setting `turbo-s3-secret-access-key` alongside passthrough credentials resolves to Vercel and never touches S3, and would otherwise carry an unmasked key through a job that logs its environment.
2. **`turbo-s3-access-key-id` is masked too**, which v1 did not do. It is the least sensitive of the four and pairing it with the secret it authenticates alongside costs nothing.
3. **Masking and declassification both go through `Secret.*`, never `Redacted.value`.** `Secret.mask` registers a value with the log filter and returns nothing — that is the mask-only call, and this repo's call site is why the member exists. `Secret.forSigning` masks first and *then* returns plaintext, for a value that is genuinely about to be used. `Secret.forChildEnv(record)` masks the whole set before returning any of it, and is the one sanctioned way a `Redacted` becomes a child's environment variable. `Secret.forRunnerFile` covers the passthrough token on its way to `exportVariable`.

**`Secret.adopt` is deliberately not used, and it will keep looking like it should be.** The kit ships it as the far side of a handoff — re-wrapping a plaintext environment variable — which is exactly the shape of `server-config.ts`'s `Redacted.make(read(env, …))` calls in the detached worker. It is the wrong fit twice over, and both reasons are invisible from the signature. First, `adopt` is a `Config`, so it assumes an effectful reader; `readServerConfig` is deliberately pure, takes the environment as a *parameter*, and is tested by passing a plain record with no runtime — adopting it would make the cache server's boot path effectful and take that suite with it. Second, `adopt`'s contract is that a missing **or empty** value fails as a `ConfigError` naming the variable, which reverses the ruling directly above: an empty credential is passed through so the S3 backend can report its own misconfiguration with the bucket and the failed request's status, which beats anything synthesized here. Raised with the kit and accepted upstream; the residual ask — a `Result`-shaped primitive over `string | undefined` — was logged as a data point, not built.

The embedded credential is a **fresh `randomUUID` per run**, replacing v1's constant compiled into the source. It is simultaneously the server's `expectedToken` and the `TURBO_TOKEN`/`TURBO_TEAM` turbo authenticates with, so both sides come from one value and a leaked build no longer discloses every runner's cache credential.

---

## Rationale

### Embedded server over a Vercel account

Most consumers run Turbo in CI without a Vercel Remote Cache. The embedded server gives them cross-job and cross-run artifact sharing using storage the runner already has, with zero external accounts. Passthrough still defers to Vercel when real credentials are supplied.

### Generic `BlobStore` backend

Turbo's protocol needs only put/get/has against opaque keys. Modelling that as a `BlobStore` service keeps the handler backend-agnostic: the same `makeTurboHandler` runs over `GitHubCacheBlobStore.layer` or `BlobStore.layerS3(config)`, and nothing above the layer knows which one it got. Adding a backend is a layer swap in `serverBlobStoreLayer`, not a handler change.

### `BlobEnvelope` instead of a hand-rolled frame

v1 packed `[4B tagLen][4B durationMs][tag][body]` by hand and namespaced keys with `v2/` because the frame had no in-band version. The envelope owns framing and revisioning; this action owns only what the metadata *means*. That deleted a codec module, a version constant and a class of mis-slicing bug, and turned an unreadable blob into a typed error the handler can classify as a miss.

### Detached process, not an in-process server

The main phase has to return so the workflow can proceed to the consumer's `turbo run` steps. A server bound to the main process would either block the step or die when it exits. The child is detached with stdout and stderr redirected to a deterministic log file rather than discarded, so a startup failure is diagnosable while the step still does not hang.

### The log path is derived from the port

`serverLogPath(port)` = `<tmpdir>/turbogha-<port>.log`, derived rather than randomized, so three separate places name the same file without passing it between them: the spawn, the failed-readiness error, and `post`'s teardown debug line. A run whose server misbehaved is diagnosed by reading it.

### Readiness gates the export

Pointing turbo at a dead server would make every cache call a connection error. The probe returns **`false` rather than failing** for a refused connection or a non-2xx answer — those are "not up yet" and "listening but not serving", both of which the retry loop should keep waiting on — which leaves the kit's `awaitReady` with only its own exhaustion to fail with, and that is what the caller degrades on.

### Starting last

`startTurboCache` is the final step. Nothing earlier consumes the turbo environment, and a later start shortens the window in which a detached child holds the runner's short-lived `ACTIONS_RUNTIME_TOKEN`. This is a deliberate deviation from v1 (which started it before the cache restore), ruled neutral-to-better.

### Non-fatal, twice over

`startTurboCache` catches its typed channel **and** defects, answering `DISABLED`; the handler catches everything to a 500 rather than crashing the server; the worker exits cleanly on a config or listen failure. A misconfigured bucket never fails a build that did not need a cache.

---

## Implementation details

### The detached worker must not get the real `ActionOutputs` layer

This is a **leak fix**, and the action shipped the bug for exactly one round.

The S3 backend declassifies its signing key through `Secret.forSigning`, which masks first — and masking is `::add-mask::<plaintext>` written to stdout, a workflow command the runner parses out of a *step's* log. This process is not a step: it is detached, and its stdout is a file in the temp directory that no runner reads. The real layer therefore writes the S3 secret **in plaintext** into a file `post` prints the path of. Masking inverts into a leak.

`ActionOutputs.layerDetached` is the fix, and improves on the interim hand-built double in two ways worth naming: its `R` is `never`, so a worker composing it *structurally cannot* write a runner file, and the members that configure the parent job's later steps fail typed with `reason: "detached"` rather than throwing an unstubbed-member defect. The regression test for the add-mask behaviour survived the swap unchanged.

**Rule: a detached worker never gets the real `ActionOutputs` layer.**

### Fail closed on a missing token

`readServerConfig` **fails** rather than booting degraded when `TURBOGHA_TOKEN` is absent. v1 read an absent token as an empty one, which the handler treats as "authentication disabled" — so a spawn that lost its environment left an **open** cache server listening on the runner. The check lives in the worker rather than the handler on purpose: the handler's permissive branch is what a test needs, and the step always supplies a token, so a missing one means something is wrong and exiting says so.

### Listen failures

v1 left `server.on("error")` unhandled, so a port collision killed the process with an unhandled exception into a log nobody reads, and the action waited out its full readiness budget before degrading. The worker now prints one line — naming `EADDRINUSE` specifically ("another cache server is running on this runner") — and exits.

The port **range check** in `readServerConfig` is load-bearing rather than tidy: `listen` throws **synchronously** on a bad port, so the `error` listener never fires for that case and the process would die with a stack trace instead of the one line it exists to print.

### Shutdown

v1 had no shutdown path at all, so `post`'s `SIGTERM` killed the process mid-request and lost whichever artifact turbo was writing. The worker now:

```ts
process.on("SIGTERM", () => {
  setTimeout(() => process.exit(0), SHUTDOWN_DEADLINE_MS).unref();   // 2s
  server.close(() => void runtime.dispose().then(() => process.exit(0), () => process.exit(0)));
});
```

`close` stops accepting and waits for what is in flight; disposing the runtime releases the backend's client. The **deadline** is what keeps "waits for what is in flight" from becoming "outlives the job": `close` never calls back while a request hangs, and `post` does not wait after signalling. `unref` keeps the timer from holding the process open on the normal path, where the callback wins the race.

On the `post` side there is **no wait and no `SIGKILL` escalation**. The signal is the whole of it: the runner reclaims the machine moments later, and a post phase that blocked on a child's exit would trade a bounded leak for an unbounded hang. A reap returning `false` — the child is already gone — is the *normal* ending, not a failure.

### Request buffering

The worker buffers each whole request body with **no size cap**, kept from v1 deliberately: turbo sends a complete artifact per request, and a cap invented here would fail a large monorepo's build rather than slow it down.

### Resolving the worker bundle

`defaultServerEntry()` = `join(dirname(fileURLToPath(import.meta.url)), "turbo-server.js")`. The build emits `dist/main.js` and `dist/turbo-server.js` side by side and this module is bundled into the former, so the sibling resolution holds **only in the built artifact**. Run from source it points at a non-existent file beside `src/steps/`, which is why every test supplies `StartTurboCacheArgs.serverEntry` rather than exercising it. See [build and distribution](./build-and-distribution.md).

---

## Known limitations

### `ACTIONS_RUNTIME_TOKEN` lifetime (GitHub backend only)

The GitHub Actions cache backend captures `ACTIONS_RUNTIME_TOKEN` **at server spawn time**. That token is a short-lived JWT issued by the Actions backend, and there is no refresh channel into a detached process. On a very long job, late cache writes from Turborepo can come back `401 Unauthorized` while everything before them succeeded.

The limitation stands, but it is now **diagnosable**: `isAuthShapedFailure` classifies a `BlobStoreError` with status 401 or `reason: "refused"`, and the worker logs a distinct line —

> the Actions cache refused a request — `ACTIONS_RUNTIME_TOKEN` has most likely expired, so cache writes from here on are lost

— so a run that quietly stopped caching says why. Without it the only trace is turbo reporting misses.

The **S3 backend is unaffected**: it uses its own long-lived credentials rather than the runner's token.

An unreadable envelope never reaches this classifier — that is a miss, not a backend problem, and reporting it would make the warning fire on a stale cache entry.

### Fixed port

One embedded server per runner. A second concurrent job on the same runner gets the `EADDRINUSE` line and a cacheless run.

### `Turbo: enabled|disabled` is detection-sourced

The closing log group's turbo line reports **detection**, not the cache outcome; the panel row carries the cache truth. This asymmetry with the Biome line (which reports the install) is deliberate: biome's line names an install the run performed, turbo's names a detection.

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) — pipeline placement, entry topology, cross-phase teardown.
- [Caching strategy](./caching-strategy.md) — the complementary `.turbo/cache` file layer and the plain-JSON encoding rule.
- [Effect service model](./effect-service-model.md) — `BlobStore`, the worker's own `ManagedRuntime`, the `DetachedProcess` seam.
- [Build and distribution](./build-and-distribution.md) — the third bundle entry.
- [Testing strategy](./testing-strategy.md) — the five-job e2e workflow, including real S3.

**Source files:**

- `src/turbo-cache/` — activation, meta, handler, server-config.
- `src/steps/turbo-cache.ts` — the step.
- `src/turbo-server.ts` — the detached entry.
- `src/state.ts` — `TurboServerState`; `src/post.ts` — the reap.
