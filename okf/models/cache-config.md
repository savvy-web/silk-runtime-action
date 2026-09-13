---
title: Cache config — key formats, ladders, lockfile patterns, and archived paths
description: The pure decisions every cache key and archived path set derives from, and what breaks when one is wrong.
status: draft
type: DataModel
resource: ../../src/steps/cache-config.ts
tags:
  - caching
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 923636e5c9e90a2d1ce75de668be28a7e7b144b7e24ca5b0449fbcf6f64bc02d
sources:
  - id: cache-config
    resource: ../../src/steps/cache-config.ts
  - id: kcov-descriptor
    resource: ../../src/descriptors/kcov.ts
  - id: restore-cache
    resource: ../../src/steps/restore-cache.ts
---

# Cache config — key formats, ladders, lockfile patterns, and archived paths

`src/steps/cache-config.ts` is the pure half of dependency caching:[^cache-config] every
decision that is not a runner call — which package managers are active, which lockfiles feed
a key, which directories are archived, how a key's segments are laid out — lives here as a total,
host-argument-driven function. Splitting it out of `restore-cache.ts` is what lets a test pin
the Windows store paths, the arch segment, and the ladder policy without a runner, a
filesystem, or a mocked `process`.

## Cache key format

```text
{platform}-{arch}-{versionHash}-{branchHash}-{lockfileHash}
```

Assembled by `keySegments` (`cache-config.ts:440-464`).

| Segment | Source |
| --- | --- |
| `platform` | `process.platform` |
| `arch` | `process.arch` — new versus the legacy key; without it an arm64 and an x64 macOS runner shared a key and restored each other's tool-cache directories |
| `versionHash` | 8-hex digest of the cache-bust (if any), then the install-policy token, then each tool as `name:version` sorted by name, then `packageManager.name:version` |
| `branchHash` | 8-hex digest of the branch, or of the literal `"null"` when there is none |
| `lockfileHash` | `CacheKey.hashFiles` result, first 8 hex, or the literal `"empty"` (`EMPTY_LOCKFILE_SEGMENT`, `cache-config.ts:360`) when nothing matched |

### The install-policy token

`installSegment` (`cache-config.ts:416-417`) folds `install-deps` and `ignore-scripts` into one
token in the version digest: `deps:scripts`, `deps:no-scripts`, or `no-deps`. This exists
because the archive is a picture of the workspace **after** the install, so two runs whose
installs did different things must not share a key. Before this token existed, a job passing
`install-deps: false` archived an empty `node_modules` and an empty store under exactly the
key a full-install job on the same commit would use; every later run then reported an
**exact hit**, skipped its own save, and installed from the network anyway — a cache that
reports a hit while caching nothing, with nothing able to repair it because the poisoned entry
kept winning every restore. This was observed in the wild (`spencerbeggs/effected`) as an
"exact hit" restore immediately followed by pnpm's `reused 0, downloaded 939`. A skipped
install collapses to `no-deps` whatever `ignore-scripts` says, because there is no install for
that flag to have changed.

## Store cache key format

```text
store-{platform}-{arch}-{managerHash}-{lockfileHash}
```

Assembled by `storeKeySegments` (`cache-config.ts:508-526`). The `store` literal leads so the
two key spaces cannot overlap. What is **absent** is the point: no branch segment (a store
from another branch is as good as this one's), no runtime or Biome version (a package tarball
is the same tarball whichever node unpacks it). `managerHash` is versioned because the store
layout is — pnpm keeps a `v10`/`v11` subdirectory beneath the archived path, and a major bump
writes a new one. The lockfile digest stays on the primary key for a different reason than it
serves in the workspace key: a store is append-only, so an older one is never *wrong*, only
short. Dropping the digest from the one restore rung (`STORE_RESTORE_DEPTHS = [4]`,
`cache-config.ts:539`) is what makes the entry **top up** — a changed lockfile misses the
primary, hits the rung, restores the previous store, lets the install add what is new, and
archives the union under the new digest.

## Restore ladders

```ts
export const RESTORE_DEPTHS = [4, 3] as const;
```

(`cache-config.ts:562`)

| Depth | Pattern | Matches |
| --- | --- | --- |
| primary | `{plat}-{arch}-{ver}-{branch}-{lock}` | Exact |
| 4 | `{plat}-{arch}-{ver}-{branch}-` | Same branch, any lockfile content |
| 3 | `{plat}-{arch}-{ver}-` | Any branch, same tool versions |

Two rungs, not the default every-prefix ladder `CacheKey` derives — the default's remaining
rungs (`linux-x64-`, `linux-`) drop the *version* digest, and a cache built for a different
Node would restore against them. `withoutRestoreKeys()` — zero rungs, distinct from
**absence** (which selects the default ladder) — removes the ladder entirely on a busted run,
so a cache-bust fixture proves an **exact** hit rather than being satisfiable by any fallback
rung.

`STORE_RESTORE_DEPTHS = [4]` (`cache-config.ts:539`) is a single rung, one level shallower:
depth 3 would drop the manager version and restore a store laid out for a different pnpm
major, which is not a store an install should trust.

## Lockfile patterns

Every built-in name is anchored at the **workspace root**; nothing is globbed at any depth
(`lockfilePatterns`, `cache-config.ts:153-167`).

| Manager | Patterns |
| --- | --- |
| npm | `package-lock.json`, `npm-shrinkwrap.json` |
| pnpm | `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.pnpmfile.cjs` |
| yarn | `yarn.lock`, `.pnp.cjs`, `.yarn/install-state.gz` |
| bun | `bun.lock`, `bun.lockb` |
| deno | `deno.lock` |

Root anchoring means every workspace package's dependency change reaches the key only through
the one root lockfile, never through a deeper copy — and a deeper match is reliably a test
fixture, not a real lockfile: this repository's own `__fixtures__/` carries five, and
`spencerbeggs/effected` carries forty-one under `packages/*/__test__/fixtures/`. Anchoring
costs a repository that keeps several independent projects side by side, each with its own
lockfile — `additional-lockfiles` is the escape hatch, appended **after** the built-in sort, in
the order written, so a workflow author reading `lockfiles` back out of the outputs sees their
own list exactly where they put it.

Exclusions guard the **caller's** patterns, not the built-ins (which cannot match them, being
root-anchored):

```ts
["!**/node_modules/**", "!**/.git/**", "!**/__fixtures__/**", "!**/__tests__/**", "!**/__test__/**"]
```

(`cache-config.ts:119-125`)

## Which package managers are active

A **runtime**, not the manifest, is what makes a manager active (`activePackageManagers`,
`cache-config.ts:45-51`): node brings the `devEngines` package manager, while bun and deno are
their own. A workspace declaring `packageManager: pnpm` with only a bun runtime caches bun's
store and not pnpm's, because pnpm never runs. The list is de-duplicated, first-seen order.

## Archived paths

**The workspace archive** — three groups, in a fixed order that is itself the contract
(`cachePaths`, `cache-config.ts:337-347`):

1. Built-ins, sorted (absolute paths alphabetically, then globs alphabetically): each active
   manager's workspace paths, then `<toolCacheBase>/<tool>/<version>` for every runtime and
   Biome.
2. `additional-cache-paths`, in the order written.
3. `**/.turbo/cache`, when turbo was detected.

The final list is de-duplicated, so a caller naming an already-present directory does not hand
`tar` the same tree twice. `node_modules` entries come from `WorkspaceDiscovery.listPackages()`
— one per workspace package, as `<relativePath>/node_modules`, root first — rather than a bare
`**/node_modules`, which matched every `node_modules` anywhere beneath the checkout, including
the ones inside `dist/` trees and test fixtures. A discovery failure or an empty answer
degrades to root-only with a warning.

**The store archive** is `storeCachePaths` alone (`cache-config.ts:240-250`) — each active
manager's default store directory, de-duplicated and sorted.

| Manager | Default store (POSIX / win32) | Workspace paths |
| --- | --- | --- |
| npm | `~/.npm` / `%LOCALAPPDATA%\npm-cache` | `<pkg>/node_modules` |
| pnpm | `~/.local/share/pnpm/store` / `…\pnpm\store` | `<pkg>/node_modules` |
| yarn | `~/.yarn/cache` and `~/.cache/yarn` / `…\Yarn\Cache` and `…\Yarn\Berry\cache` | `<pkg>/node_modules`, `.yarn/cache`, `.yarn/unplugged`, `.yarn/install-state.gz` |
| bun | `~/.bun/install/cache` / `…\bun\install\cache` | `<pkg>/node_modules` |
| deno | `~/.cache/deno` / `%LOCALAPPDATA%\deno` | none — deno never populates `node_modules` |

(`storePaths`, `cache-config.ts:207-226`)

yarn contributes **two** stores because Berry and Classic disagree about where the cache
lives, and the manager's major version is not known at this layer. Paths are joined with
`node:path`'s `posix` or `win32` module explicitly — the same as the host's own module in
production, but what lets a Linux test pin the Windows store layout (`pathFor`,
`cache-config.ts:178`). The tool-cache base is `RUNNER_TOOL_CACHE` when set, else
`/opt/hostedtoolcache` (`C:\hostedtoolcache` on win32) (`defaultToolCacheBase`,
`cache-config.ts:291-292`).

## Turbo's local artifact cache

```ts
export const TURBO_LOCAL_CACHE_PATHS = ["**/.turbo/cache"] as const;
```

(`cache-config.ts:128`)

Only this one path joins the archive when `turbo.json` is detected. `**/.turbo/runs`,
`.turbo/cookies`, and `.turbo/daemon` are deliberately excluded — a restored stale run summary
would break "latest run = current run" detection in tooling that parses `turbo --summarize`
output. This file-cache layer and the embedded turbo remote cache (see
[embedded-turbo-server](../decisions/embedded-turbo-server.md)) are **complementary, not
alternatives**: the remote cache is primary, and the file layer is a fast local restore on top
of it. Neither is a candidate for removal in favor of the other.

## Where each piece lives

| Concern | Location | Kind |
| --- | --- | --- |
| Active managers, patterns, store/workspace paths, key segments, ladder policy | `src/steps/cache-config.ts` | Pure, host-argument-driven |
| Workspace/tool-cache/branch resolution, discovery, hashing, restore, state save | `src/steps/restore-cache.ts` | Effectful |
| `CacheState`, `StoreCacheState`, `KcovCacheState`, `isExactHit`, `STATE_KEYS` | `src/state.ts` | Schema — see [cross-phase-state](./cross-phase-state.md) |
| kcov's key and ladder | `src/descriptors/kcov.ts` (`kcovCacheKey`) | Pure, image-as-argument |
| kcov's restore, probe, rebuild and state stash | `src/steps/install-kcov.ts` | Effectful |
| The saves | `src/post.ts` | Effectful |

## The kcov key ladder

```text
rung     kcov-<version>-<ImageOS>-<arch>-<bustDigest>
primary  <rung>-<ImageVersion>
```

Assembled by `kcovCacheKey` in `src/descriptors/kcov.ts` (`kcov.ts:141-160`) — a typed
`CacheKey` with `withRestoreDepths([5])`, on the same reasoning as the dependency key: the kit
owns the ladder, `ActionCache.restore` reads the rungs straight off the key, and the primary
and its fallbacks cannot drift apart.

| Situation | Behaviour |
| --- | --- |
| Image unchanged | Exact hit on the primary. Fast path, no save, no `apt`/`brew` |
| `ImageVersion` bumped (roughly weekly) | Primary misses, the rung restores the previous entry, the probe passes, `post` **re-saves** it under the new primary — warm, costs one ~7 MB upload |
| System libraries moved under one `ImageOS` | The probe fails, the step rebuilds, and `post` saves under the **new** primary — the next run exact-hits a binary that works |

`ImageOS` sits in the rung and `ImageVersion` in the primary, and the two placements are
complementary rather than in tension: an `ImageVersion`-only key would mean a weekly cold
rebuild, but with the `ImageOS` rung underneath it a version bump restores warm off the rung
and re-saves. This is what gives the ladder **self-healing**: entries are immutable and a save
to an already-taken key is a no-op success, so under a single key a tree whose system libraries
moved would be poisoned permanently — every run would restore it, fail the probe, rebuild, save
to the same taken key, and throw the good tree away, correct every time and permanently slow
for the ~2 years an LTS `ImageOS` lives. A failed **rung** restore heals, because the rebuild
lands under a fresh primary nothing holds yet. A failed **exact** restore does not heal — the
rebuild's key is the one it just restored from — but the ladder still **bounds** the poisoning
to one `ImageVersion` window (roughly a week) instead of the `ImageOS` lifetime.

The bust is a digest segment the **rung** retains, not a tail on the primary: a trailing bust
on the primary alone would leave the rung un-busted, so a busted run would miss its primary,
match an ordinary entry on the rung, and restore it — defeating the whole point of
`cache-bust`. `ImageOS` and `ImageVersion` are both arguments, and empty is treated as absent
rather than as a literal segment value — an `ImageOS=""` would key on a namespace nothing else
this runner writes ever matches, a cache that stays cold forever without ever looking wrong.

## What breaks if a piece is wrong

- Omitting the arch segment from the dependency key restores wrong-architecture binaries from
  a cache that reports a hit.
- Omitting the install-policy token from the version digest reproduces the poisoning
  incident above: an `install-deps: false` job's near-empty archive wins every subsequent
  restore permanently.
- Dropping the lockfile digest from the store's primary key (rather than only from its rung)
  would freeze the store the first time any lockfile changed, since every run after the first
  would then report an exact hit and skip its own save.
- Globbing `node_modules` at any depth rather than enumerating workspace packages archives
  directories no install produced and no restore uses, inflating the archive for no benefit.
- Dropping `.turbo/cache` from the archive (rather than the excluded `runs`/`cookies`/`daemon`)
  removes the fast local restore layer the embedded remote cache is meant to complement.

[^cache-config]: cache-config
