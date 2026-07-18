---
status: current
module: silk-runtime-action
category: performance
created: 2026-03-21
updated: 2026-07-17
last-synced: 2026-07-17
completeness: 92
related:
  - ./architecture.md
  - ./effect-service-model.md
  - ./turbo-remote-cache.md
dependencies: []
---

# Caching strategy

Dependency and runtime caching: key generation, multi-package-manager support, lockfile detection via `Glob`, cache path resolution and cross-phase state.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Rationale](#rationale)
4. [Implementation details](#implementation-details)
5. [Related documentation](#related-documentation)

---

## Overview

The action provides automatic dependency caching across all supported package managers (npm, pnpm, yarn, bun, deno) and runtimes (Node.js, Bun, Deno). Cache keys are deterministic and derived from runtime versions, PM version, branch and lockfile contents. The V2 Twirp protocol is used via `ActionCache`; cross-phase state moves between main and post via `ActionState` + the `CacheState` schema in `src/state.ts`.

**Key features:**

- Lockfile detection via the library `Glob` service (`Glob.glob` with newline-separated patterns and `!`-prefix excludes).
- Lockfile hashing via `Glob.hashFiles` (library-provided hash-of-hashes, truncated to 8 hex chars).
- Dynamic cache path detection by querying installed package managers; platform fallbacks when detection fails.
- Tool cache inclusion for all installed runtimes (Node, Bun, Deno, Biome).
- Multi-PM deduplication for multi-runtime setups.
- Restore key fallback chain (branch-specific then version-only); disabled when `cache-bust` is set.
- User-extensible via `additional-lockfiles` and `additional-cache-paths` inputs (newline-separated only).

**When to load this doc:**

- Debugging cache key generation or unexpected misses.
- Adding support for a new package manager.
- Modifying lockfile or cache path resolution.

---

## Current state

### Cache key format

```text
{platform}-{versionHash}-{branchHash}-{lockfileHash}
```

Example: `linux-abc12345-def67890-ghi11223`.

| Component | Source | Length |
| --- | --- | --- |
| `platform` | `node:os` `platform()` | Literal (`linux` / `darwin` / `win32`) |
| `versionHash` | SHA256 of sorted runtime versions + PM `name:version` + optional `cache-bust` | 8 hex |
| `branchHash` | SHA256 of branch name (`GITHUB_HEAD_REF` for PR, else `GITHUB_REF` minus `refs/heads/`) | 8 hex |
| `lockfileHash` | `Glob.hashFiles(lockfiles)` truncated | 8 hex |

The `versionHash` and `branchHash` are still computed locally via `node:crypto` (see `src/services/cache.ts`). The `lockfileHash` now comes from `Glob.hashFiles`, which hashes each file individually and combines them. This is **different** from the previous concat-and-SHA256 approach. See [hash algorithm change](#hash-algorithm-change) below.

### Restore key fallback chain

| Priority | Pattern | Matches |
| --- | --- | --- |
| 1 (primary) | `{plat}-{versionHash}-{branchHash}-{lockfileHash}` | Exact |
| 2 (branch) | `{plat}-{versionHash}-{branchHash}-` | Same branch, any lockfile content |
| 3 (version) | `{plat}-{versionHash}-` | Any branch, same runtime versions |

When `cache-bust` is set, the restore keys list is empty (forces exact match for testing).

### Lockfile patterns by package manager

See `getLockfilePatterns` in `src/services/cache.ts` for the source of truth. Summary: per-PM globs (e.g., `**/pnpm-lock.yaml`, `**/yarn.lock`, `**/bun.lock`, `**/deno.lock`). User-provided `additional-lockfiles` are appended.

### Cache paths by package manager

Each active PM contributes:

1. The global cache directory (detected via `pm <command>` query, fallback to platform default).
2. PM-specific additional paths (`**/node_modules` for npm/pnpm/bun; Yarn PnP paths; empty for Deno).
3. Tool cache paths for installed runtimes (`{RUNNER_TOOL_CACHE}/{runtime}/{version}`).

Detection commands and fallbacks live in `src/services/cache.ts` (`detectCachePath` and `getDefaultCachePaths`).

### Cross-phase state

`CacheState` (in `src/state.ts`) is a `Schema.Class`:

```ts
class CacheState extends Schema.Class<CacheState>("CacheState")({
  key: Schema.String,
  paths: Schema.Array(Schema.String),
  restored: Schema.Boolean,
}) {}
```

`restored=true` means main got an exact hit and post should skip the save. Persisted under `STATE_KEYS.cacheState = "cache-state"`. `src/state.ts` also defines `TurboServerState` (under `STATE_KEYS.turboServerState`) carrying the embedded server's pid for post-phase teardown — see [turbo remote cache](./turbo-remote-cache.md).

This replaces the previous inline `CacheStateSchema` with a `hit: "exact" | "partial" | "none"` literal. The new shape collapses partial/none into a single `restored=false` because post only needs the binary save/skip decision.

---

## Rationale

### Library `Glob` instead of `fast-glob`

Lockfile resolution previously used `fast-glob` as a direct dependency. It now uses the library `Glob` service (`GlobLive`) for both file discovery (`Glob.glob`) and lockfile hashing (`Glob.hashFiles`). Benefits:

- One less direct dependency.
- Lockfile hashing is now consistent with how GitHub's own `hashFiles()` works (the library matches the runner's behavior).
- The service is mockable via `GlobTest` from `@savvy-web/github-action-effects/testing`.

### Hash algorithm change

Old behavior: read each lockfile, concatenate the contents, SHA256-hash the result, truncate to 8 hex.

New behavior: `Glob.hashFiles` hashes each file individually and combines the per-file hashes (matching `@actions/glob`'s `hashFiles`).

These produce **different** hex digests for the same set of files. The first deploy after this release will see cache misses on previously-existing keys; all subsequent runs are unaffected. This is documented and accepted.

### Why not `PackageManagerAdapter`

The library's `PackageManagerAdapter` reads `packageManager` from `package.json`, not `devEngines`. Since this action reads from `devEngines.packageManager` exclusively, using the adapter would create a detection mismatch. `cache.ts` does its own cache-path resolution and lockfile patterning.

### 8-character hash truncation

Full SHA256 is 64 hex; 8 hex gives ~4.3B possibilities. The birthday paradox puts 50% collision probability around 65k entries -- negligible for a single repository's cache.

### Branch in cache key

Including the branch prevents pollution between branches. A feature branch with modified dependencies should not restore a stale cache from `main`. The restore-key fallback chain still allows version-only matching when no branch-specific cache exists.

### Newline-only multi-value inputs

`additional-lockfiles` and `additional-cache-paths` now use `ActionInput.multiline` (newline-separated only). The previous `parseMultiValueInput` helper that accepted commas, bullets and JSON arrays has been deleted. Aligning with the library convention reduces edge cases in tests and matches the YAML-block style users actually write.

---

## Implementation details

### Active package manager detection

`program.getActivePackageManagers(runtimes, primaryPM)`:

- If a runtime is `node`, the primary PM (from `devEngines.packageManager`) is active.
- If a runtime is `bun`, `bun` is added.
- If a runtime is `deno`, `deno` is added.

For multi-runtime setups (e.g., Node + Deno) the cache paths from both PMs are merged and deduplicated.

### Cache path merging (`getCombinedCacheConfig`)

For each active PM, call `getCacheConfig(pm)` (runs the detection command, falls back to platform defaults). Union the cache-path and lockfile-pattern sets. Add tool cache paths for all runtimes (including Biome). Sort absolute paths before glob patterns. The program then appends `additional-cache-paths` and, when Turbo is detected, `**/.turbo/cache` via `turboLocalCachePaths` (see below).

### Turbo local cache layer

When `turbo.json` is detected, `turboLocalCachePaths` (in `src/program.ts`) adds `**/.turbo/cache` — Turbo's local task-output artifact cache — to the file-cached paths. This is a fast local-restore layer that complements the embedded remote cache (see [turbo remote cache](./turbo-remote-cache.md)). Only `.turbo/cache` is cached; `.turbo/runs` (run summaries), `.turbo/cookies` and `.turbo/daemon` are deliberately excluded. A restored stale `runs` summary would break "latest run = current run" detection by tools that parse `turbo --summarize` output; cookies and the daemon directory are ephemeral.

### Lockfile detection (`findLockFiles`)

`findLockFiles` builds a single newline-separated patterns string with `!`-prefix excludes (via `buildLockfileGlobPatterns` in `src/services/cache.ts`) and passes it to `Glob.glob`. Errors are caught and demoted to an empty list (cache restore continues without any lockfile contribution).

Beyond `node_modules` and `.git`, the excludes cover test and fixture trees — `**/__fixtures__/**`, `**/__tests__/**`, `**/__test__/**` — so a fixture lockfile (e.g. `__fixtures__/turbo-monorepo/pnpm-lock.yaml`) never pollutes the cache key. See `buildLockfileGlobPatterns` for the exact exclude list.

### Lockfile hashing (`hashFiles`)

```ts
const patternsStr = files.join("\n");
const result = yield* glob.hashFiles(patternsStr).pipe(Effect.catch(() => Effect.succeed(Option.none<string>())));
return Option.getOrElse(result, () => "").substring(0, 8);
```

`Glob.hashFiles` returns `Option<string>`. `None` (or a thrown error) yields an empty hash. Successful hashes are truncated to 8 hex chars.

### Cross-phase state flow

Main:

```ts
yield* state.save(STATE_KEYS.cacheState, new CacheState({ key, paths, restored: hit === "exact" }), CacheState);
```

Post (in `src/post.ts`):

```ts
const opt = yield* state.getOptional(STATE_KEYS.cacheState, CacheState);
if (Option.isNone(opt)) return;
if (opt.value.restored) return;          // exact hit; nothing to save
yield* Step.groupStep("Cache save", saveCache());
```

`saveCache` re-reads the state with `state.get` (not `getOptional`) inside `services/cache.ts` and calls `ActionCache.save(paths, key)`.

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) -- pipeline shape, cross-phase state diagram.
- [Turbo remote cache](./turbo-remote-cache.md) -- embedded remote cache that the `.turbo/cache` file layer complements.
- [Effect service model](./effect-service-model.md) -- `Context.Service` classes, `Schema.TaggedErrorClass`, layer composition.

**Source files:**

- `src/services/cache.ts` -- all cache logic.
- `src/state.ts` -- `CacheState` and `STATE_KEYS`.
- `src/program.ts` -- `getActivePackageManagers`, multi-value input plumbing.
