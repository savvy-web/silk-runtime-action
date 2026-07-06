---
status: current
module: silk-runtime-action
category: integration
created: 2026-06-23
updated: 2026-07-05
last-synced: 2026-07-05
completeness: 90
related:
  - ./architecture.md
  - ./caching-strategy.md
  - ./effect-service-model.md
  - ./build-and-distribution.md
  - ./testing-strategy.md
dependencies: []
---

# Turbo remote cache

Embedded Turborepo remote-cache server. When `turbo.json` is detected the action starts a detached local HTTP server that implements Turbo's `/v8/artifacts` remote-cache contract, backed by a generic `BlobStore` (GitHub Actions cache or S3/SigV4). This lets Turbo share task-output artifacts across jobs and runs without an external Vercel Remote Cache.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Rationale](#rationale)
4. [Implementation details](#implementation-details)
5. [Related documentation](#related-documentation)

---

## Overview

Turbo speaks an HTTP remote-cache protocol (`/v8/artifacts/...`). Rather than require a Vercel account, the action can stand up that protocol locally and persist artifacts to whatever blob storage the runner already has access to. Turbo is pointed at `http://127.0.0.1:<port>` via the `TURBO_API`/`TURBO_TOKEN`/`TURBO_TEAM` environment variables, so the consumer's later `turbo run` steps transparently read and write the embedded cache.

The whole subsystem is an **enhancement that never fails the job**: every failure path degrades to a warning and leaves Turbo running with no remote cache (local file cache still applies — see [caching strategy](./caching-strategy.md)).

**Key features:**

- Activation decision tree (`resolveTurboCache`): off, passthrough (external Vercel creds), embedded-github or embedded-s3.
- Detached HTTP server (`src/turbo-server.ts`, a third bundle) spawned by main, reaped by post.
- Generic `BlobStore` backend abstraction (GitHub Actions cache or S3/SigV4).
- Artifact byte framing that round-trips Turbo's `x-artifact-duration` so remote hits report accurate `timeSaved`.
- Secrets read `Redacted` and registered with the runner log mask via `setSecret`.

**When to load this doc:**

- Modifying turbo cache activation, the server lifecycle or the artifact codec.
- Adding a backend or changing the blob key layout.
- Debugging why the embedded cache degraded or why post did not reap the server.

---

## Current state

### Module map

| Module | Path | Responsibility |
| --- | --- | --- |
| Activation | `src/services/turbo-cache/activation.ts` | `resolveTurboCache` — pure decision tree over inputs |
| Codec | `src/services/turbo-cache/codec.ts` | `encodeArtifact`/`decodeArtifact` — artifact byte framing |
| Handler | `src/services/turbo-cache/handler.ts` | `makeTurboHandler` — `/v8/artifacts` contract over `BlobStore` |
| Lifecycle | `src/services/turbo-cache/lifecycle.ts` | `buildSpawnSpec`, `spawnTurboServer`, `waitForServer`, `killProcess`, `serverLogPath` |
| Apply | `src/services/turbo-cache/apply.ts` | `applyTurboCache` — orchestrates spawn → save state → probe → export-or-degrade |
| Server entry | `src/turbo-server.ts` | Detached process entry; wires `BlobStore` backend to the handler over `http` |
| State | `src/state.ts` | `TurboServerState` (pid, port, backend) for cross-phase teardown |

### Activation decision tree

`resolveTurboCache` (in `activation.ts`) maps inputs to one of four resolutions, in priority order:

| Resolution | Condition |
| --- | --- |
| `off` | `turbo.json` absent, or `turbo-cache=off` |
| `passthrough` | both `turbo-token` and `turbo-team` are set (defer to external Vercel Remote Cache) |
| `embedded` / `s3` | an S3 bucket is configured (`turbo-s3-bucket`) |
| `embedded` / `github` | otherwise (default when Turbo is detected) |

### Server lifecycle

```text
main (program.ts "Turbo remote cache" step)
  resolveTurboCache(inputs) -> resolution
  applyTurboCache(resolution, deps):
    off         -> return { backend: "none" }
    passthrough -> exportVariable TURBO_TOKEN/TURBO_TEAM -> { backend: "remote" }
    embedded    -> buildSpawnSpec -> spawnTurboServer (detached, unref'd)
                -> ActionState.save(turboServerState { pid, port, backend })  [BEFORE probe]
                -> waitForServer(port)  (poll /v8/artifacts/status)
                     up:   exportVariable TURBO_API/TURBO_TOKEN/TURBO_TEAM
                     down: logError + return { backend: "none" }  (degrade)

post (post.ts) — runs unconditionally, before any cache early-return
  ActionState.getOptional(turboServerState)
    Some -> killProcess(pid)  (SIGTERM, swallow "already gone")
```

The state save happens **before** the readiness probe so post can always reap the pid even if the server never became ready. This cross-phase spawn/reap is the load-bearing contract of this subsystem: main and post run in separate processes, so the pid must survive in `ActionState`.

### Blob key layout

Artifacts are stored under `${prefix}${ARTIFACT_KEY_VERSION}/${hash}` (currently `${prefix}v2/${hash}`). `ARTIFACT_KEY_VERSION` (in `handler.ts`) is bumped whenever the codec frame layout changes, so blobs written under an older frame are never decoded under a new layout; orphaned old-format blobs are left for backend eviction.

### Outputs and env

- Outputs: `turbo-cache-backend` (`github` | `s3` | `remote` | `none`), `turbo-cache-port` (port or empty).
- Exported env for Turbo: `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM` (embedded uses a dummy credential `silk-runtime-action`; passthrough uses the real Vercel token/team).

---

## Rationale

### Embedded server over a Vercel account

Most consumers run Turbo in CI without a Vercel Remote Cache. The embedded server gives them cross-job and cross-run artifact sharing using storage the runner already has (the GitHub Actions cache, or a self-hosted S3 bucket) with zero external accounts. Passthrough mode still defers to Vercel when real credentials are supplied.

### Generic `BlobStore` backend

Turbo's protocol only needs put/get/has against opaque keys. Modeling that as a `BlobStore` service (from `@savvy-web/github-action-effects`) keeps the handler backend-agnostic: the same `makeTurboHandler` runs over `GitHubBlobStoreLive` or `S3BlobStoreLive`. Adding a backend is a layer swap in the server entry, not a handler change.

### Detached process, not in-process server

The action's main phase must return so the workflow can proceed to the consumer's `turbo run` steps. A server bound to the main process would either block the step or die when it exits. The server is spawned `detached` and `unref`'d, with stdout/stderr redirected to a deterministic log file (`serverLogPath`) rather than `"ignore"` so a startup failure is diagnosable while the Actions step still does not hang.

### Readiness probe gates the export

`waitForServer` polls `/v8/artifacts/status` before main exports `TURBO_API`. Pointing Turbo at a dead server would make every cache call fail noisily; gating on readiness means the action either wires a working cache or degrades cleanly to none.

### Duration round-trip in the codec

Turbo sends `x-artifact-duration` (artifact generation time) on PUT and expects it back on GET to compute `timeSaved` on a remote hit. The codec frames it alongside the tag and body (`[tag-len][duration-ms][tag][body]`) so a remote hit reports the same `timeSaved` a local hit would. Without it, Turbo would report zero time saved on every remote restore.

### Non-fatal degradation

Turbo cache is strictly additive. `applyTurboCache` and the surrounding `program.ts` step both `catchAll` to a `{ backend: "none" }` warning, and the handler itself catches all errors to a 500 rather than crashing the server. A misconfigured bucket or an unreachable cache never fails the consumer's build.

### Secrets handled as `Redacted`

S3 secret/session and the turbo token are read via `Config.redacted`, registered with the runner's log mask through `setSecret`, and only unwrapped (`Redacted.value`) at the transport boundary (the spawn env). This keeps secrets out of accidental log lines in the main process.

---

## Implementation details

### Handler contract

See `src/services/turbo-cache/handler.ts`. `makeTurboHandler({ prefix, expectedToken })` returns an `Effect` over `BlobStore` that handles `/v8/artifacts/status` (enabled), `/v8/artifacts/events` (empty), and `PUT`/`GET`/`HEAD /v8/artifacts/:hash`. Bearer-token auth is enforced when `expectedToken` is non-empty.

### Codec framing

See `src/services/turbo-cache/codec.ts`. Frame layout: 4-byte big-endian tag length, 4-byte big-endian duration (ms, clamped to uint32), tag UTF-8 bytes, then the artifact body. A null tag is length 0.

### Spawn spec and backend wiring

`buildSpawnSpec` (in `lifecycle.ts`) carries all config to the child through `TURBOGHA_*` env vars (port, prefix, token, backend and the S3 fields). The detached entry `src/turbo-server.ts` reads those env vars, builds the matching `BlobStore` layer (`GitHubBlobStoreLive` or `S3BlobStoreLive`, each provided `NodeHttpClient.layer`), and drives the handler through a `ManagedRuntime` from a plain `node:http` server.

### Bundling

`src/turbo-server.ts` is a third bundle entry declared as `entries.workers` in `action.config.ts`, producing `dist/turbo-server.js`. Main resolves the entry path relative to its own bundle (`import.meta.url`). See [build and distribution](./build-and-distribution.md).

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) — pipeline placement of the turbo step, entry topology, cross-phase teardown.
- [Caching strategy](./caching-strategy.md) — the complementary `.turbo/cache` local file-cache layer.
- [Effect service model](./effect-service-model.md) — `BlobStore` service, `ManagedRuntime` in the detached entry, `Redacted` secrets.
- [Build and distribution](./build-and-distribution.md) — the third bundle entry.

**Source files:**

- `src/services/turbo-cache/` — activation, codec, handler, lifecycle, apply.
- `src/turbo-server.ts` — detached server entry.
- `src/state.ts` — `TurboServerState`.
