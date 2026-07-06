---
status: current
module: silk-runtime-action
category: meta
created: 2026-03-21
updated: 2026-07-05
last-synced: 2026-07-05
completeness: 100
related: []
dependencies: []
---

# Design documentation index

Navigation index for all design documentation in the silk-runtime-action project.

## Architecture

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [architecture.md](./architecture.md) | current | 92% | Entry topology, module map, `MainLive`/`PostLive` composition |
| [effect-service-model.md](./effect-service-model.md) | current | 92% | Service tags, `Schema.TaggedError`, `Step.*` namespace, Config API |
| [runtime-installation.md](./runtime-installation.md) | current | 92% | `RuntimeInstaller` `Context.Tag` class, descriptors, PM setup, Biome |

## Performance

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [caching-strategy.md](./caching-strategy.md) | current | 92% | Cache keys, `Glob`-based lockfile detection/hashing, cross-phase state |

## Integration

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [build-and-distribution.md](./build-and-distribution.md) | current | 88% | `github-action-builder` config, cyclonedx `ignore` list, three-entry dist |
| [turbo-remote-cache.md](./turbo-remote-cache.md) | current | 90% | Embedded turbo remote cache: activation tree, detached server, codec, teardown |

## Testing

| Document | Status | Completeness | Description |
| --- | --- | --- | --- |
| [testing-strategy.md](./testing-strategy.md) | current | 90% | Library Test layers, hand-rolled mocks for failure injection, fixture tests |

## Statistics

- **Total documents:** 7
- **Current:** 7
- **Average completeness:** 91%
- **Last updated:** 2026-07-05
