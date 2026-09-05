---
status: current
module: silk-runtime-action
category: meta
created: 2026-03-21
updated: 2026-09-04
last-synced: 2026-09-04
completeness: 100
related: []
dependencies: []
---

# Design documentation index

Navigation index for all design documentation in the silk-runtime-action project.

All seven documents were reconciled against the completed `@effected/*` Effect v4 rebuild on 2026-08-02. They describe the code as it stands on `dev`, not the legacy v1 implementation — whose source the repository does not carry: `docs/superpowers/` is gitignored local-only working state, so a clean checkout has none of it. The `oracle N` / `ruling N` / `quirk N` citations in `src/` are provenance labels for that vanished tree, and the prose beside each one is the authority (see `src/CLAUDE.md`).

Five of the seven were re-synced on **2026-08-20** for the BATS + kcov toolchain (the `bats` and `kcov` inputs, `detect-bats` / `install-bats` / `install-kcov`, the separate kcov cache entry and its third `post` branch). `effect-service-model.md` and `turbo-remote-cache.md` were untouched: the feature introduced no new services and does not touch the embedded cache server. Its originating spec lived under the same untracked `docs/superpowers/` tree and is likewise not in a clean checkout.

Three of the seven were re-synced on **2026-09-04** for the #348 reconciliation against the effected GitHub-action canon: `build-and-distribution.md` (catalog-resolved dependencies, the seven deleted never-imported packages, `branch-sync.yml` replacing `release-sync.yml`, and the `tsc` typecheck the doc had misdescribed), `architecture.md` (the `GITHUB_ACTIONS` guard now on both entries, and the `vitest.setup.ts` environment strip that keeps it honest) and `testing-strategy.md` (`@effected/memfs` as the filesystem, `assert.*` over `expect`, and the bugs the conversion surfaced).

## Architecture

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [architecture.md](./architecture.md) | current | 95% | Entry topology, module map, pipeline order, `MainLive`/`PostLive`, error model, the two PATH joins, the two BATS detection signals |
| [effect-service-model.md](./effect-service-model.md) | current | 95% | The step-contract rule, `Data.TaggedError` taxonomy, `ActionInput` decoding, defaulted-parameter seams, log groups |
| [runtime-installation.md](./runtime-installation.md) | current | 95% | Pure descriptors, tool-cache layout, `PackageManagerInstaller`, Biome, the BATS/kcov toolchain, and the `PATH` problem |

## Performance

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [caching-strategy.md](./caching-strategy.md) | current | 95% | Typed `CacheKey`, restore ladder, lockfile discovery, archived paths, the separate kcov entry and its verify probe, the cross-phase state protocol |

## Integration

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [turbo-remote-cache.md](./turbo-remote-cache.md) | current | 95% | Activation table, detached worker, `BlobEnvelope` metadata, secrets, teardown, token-lifetime limitation |
| [build-and-distribution.md](./build-and-distribution.md) | current | 92% | Three-entry bundle, committed `dist/`, dependency topology, the dogfood link hazard, `branch-sync.yml`, and why source-level verification is not verification |

## Testing

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [testing-strategy.md](./testing-strategy.md) | current | 95% | Kit test layers, the `@effected/memfs` volume, the real-`ActionState` harness, `action.yml` parity guards, fixture and e2e matrices |

## Where a topic lives

| Looking for | Document |
| --- | --- |
| Pipeline step order, what is fatal | [architecture](./architecture.md) |
| Adding a step, or a new error type | [effect service model](./effect-service-model.md) |
| `addPath` semantics, Windows `.cmd`, lifecycle-script `PATH` | [runtime installation](./runtime-installation.md) |
| Where the BATS libraries land, why kcov is built from source | [runtime installation](./runtime-installation.md) |
| Cache key segments, restore rungs, `CacheState` encoding | [caching strategy](./caching-strategy.md) |
| kcov's key ladder, the verify probe, `KcovCacheState` | [caching strategy](./caching-strategy.md) |
| Why a string must be checked against `dist/`, not source | [build and distribution](./build-and-distribution.md) |
| Backend selection, `TURBOGHA_*`, `ACTIONS_RUNTIME_TOKEN` expiry | [turbo remote cache](./turbo-remote-cache.md) |
| Linking a first-party dependency, or why `dist/` is committed | [build and distribution](./build-and-distribution.md) |
| Which double to trust, `action.yml` guards, e2e matrices | [testing strategy](./testing-strategy.md) |
| Seeding a filesystem, injecting an FS fault, recording probed paths | [testing strategy](./testing-strategy.md) |
| How `dev` and `main` are kept coherent, and the `v<major>` tag | [build and distribution](./build-and-distribution.md) |

## Statistics

- **Total documents:** 7
- **Current:** 7
- **Average completeness:** 95%
- **Last synced:** 2026-09-04 for `architecture.md`, `build-and-distribution.md` and `testing-strategy.md` (#348 canon reconciliation); 2026-08-20 for `caching-strategy.md` and `runtime-installation.md` (BATS + kcov toolchain); 2026-08-02 for `effect-service-model.md` and `turbo-remote-cache.md`, unaffected by either
