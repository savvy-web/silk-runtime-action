---
status: current
module: silk-runtime-action
category: meta
created: 2026-03-21
updated: 2026-08-02
last-synced: 2026-08-02
completeness: 100
related: []
dependencies: []
---

# Design documentation index

Navigation index for all design documentation in the silk-runtime-action project.

All seven documents were reconciled against the completed `@effected/*` Effect v4 rebuild on
2026-08-02. They describe the code as it stands on `dev`, not the legacy v1 implementation
(whose source is retained read-only at `docs/superpowers/reference/legacy-v1/`).

## Architecture

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [architecture.md](./architecture.md) | current | 95% | Entry topology, module map, pipeline order, `MainLive`/`PostLive`, error model, the two PATH joins |
| [effect-service-model.md](./effect-service-model.md) | current | 95% | The step-contract rule, `Data.TaggedError` taxonomy, `ActionInput` decoding, defaulted-parameter seams, log groups |
| [runtime-installation.md](./runtime-installation.md) | current | 95% | Pure descriptors, tool-cache layout, `PackageManagerInstaller`, Biome, and the `PATH` problem |

## Performance

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [caching-strategy.md](./caching-strategy.md) | current | 95% | Typed `CacheKey`, restore ladder, lockfile discovery, archived paths, the cross-phase state protocol |

## Integration

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [turbo-remote-cache.md](./turbo-remote-cache.md) | current | 95% | Activation table, detached worker, `BlobEnvelope` metadata, secrets, teardown, token-lifetime limitation |
| [build-and-distribution.md](./build-and-distribution.md) | current | 92% | Three-entry bundle, committed `dist/`, dependency topology, the dogfood link hazard |

## Testing

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [testing-strategy.md](./testing-strategy.md) | current | 95% | Kit test layers, the real-`ActionState` harness, `action.yml` parity guards, fixture and e2e matrices |

## Where a topic lives

| Looking for | Document |
| --- | --- |
| Pipeline step order, what is fatal | [architecture](./architecture.md) |
| Adding a step, or a new error type | [effect service model](./effect-service-model.md) |
| `addPath` semantics, Windows `.cmd`, lifecycle-script `PATH` | [runtime installation](./runtime-installation.md) |
| Cache key segments, restore rungs, `CacheState` encoding | [caching strategy](./caching-strategy.md) |
| Backend selection, `TURBOGHA_*`, `ACTIONS_RUNTIME_TOKEN` expiry | [turbo remote cache](./turbo-remote-cache.md) |
| Linking a first-party dependency, or why `dist/` is committed | [build and distribution](./build-and-distribution.md) |
| Which double to trust, `action.yml` guards, e2e matrices | [testing strategy](./testing-strategy.md) |

## Statistics

- **Total documents:** 7
- **Current:** 7
- **Average completeness:** 95%
- **Last synced:** 2026-08-02 (post-rebuild reconciliation)
