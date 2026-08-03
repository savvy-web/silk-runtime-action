---
status: current
module: silk-runtime-action
category: performance
created: 2026-03-21
updated: 2026-08-02
last-synced: 2026-08-02
completeness: 95
related:
  - ./architecture.md
  - ./effect-service-model.md
  - ./turbo-remote-cache.md
dependencies: []
---

# Caching strategy

Dependency and tool caching: the typed `CacheKey`, the restore ladder, lockfile discovery, the archived path set, and the cross-phase state protocol.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Cross-phase state protocol](#cross-phase-state-protocol)
4. [Rationale](#rationale)
5. [Implementation details](#implementation-details)
6. [Related documentation](#related-documentation)

---

## Overview

The action caches dependency stores, workspace `node_modules`, the tool-cache directories of everything it installed, and (when turbo is detected) turbo's local artifact cache — all under one key derived from the platform, the architecture, the tool versions, the branch and the lockfile contents.

Every restore this action makes goes through a **typed `CacheKey`** from `@effected/github-actions`, which carries its own restore-key policy so the primary key and its fallbacks cannot drift apart.

**Key features:**

- Key: `{platform}-{arch}-{versionHash}-{branchHash}-{lockfileHash}`, arch included (legacy had none).
- Discovery and hashing through `CacheKey.matchingFiles` / `CacheKey.hashFiles`, bounded by `GITHUB_WORKSPACE`.
- A two-rung restore ladder (`withRestoreDepths([4, 3])`), and an explicitly **empty** ladder for a busted run.
- Every decision that is not a runner call is a pure function in `steps/cache-config.ts`.
- Cross-phase state whose encoded form is plain JSON, by rule.
- `**/.turbo/cache` joins the archive when turbo is detected — a complement to the embedded remote cache, not a replacement.

**When to load this doc:**

- Debugging an unexpected cache miss or a key that looks wrong.
- Adding a package manager, a store path or a lockfile pattern.
- Changing anything that crosses the main → post boundary.

---

## Current state

### Cache key format

```text
{platform}-{arch}-{versionHash}-{branchHash}-{lockfileHash}
```

Example: `linux-x64-abc12345-def67890-ghi11223`.

| Segment | Source |
| --- | --- |
| `platform` | `process.platform` — `linux` / `darwin` / `win32` |
| `arch` | `process.arch` — `x64` / `arm64` / … |
| `versionHash` | SHA-256, first 8 hex, of the cache-bust (if any) then each tool as `name:version` **sorted by name**, then `packageManager.name:version` |
| `branchHash` | SHA-256, first 8 hex, of the branch — or of the literal `"null"` when there is none |
| `lockfileHash` | `CacheKey.hashFiles(lockfiles)`, first 8 hex — or the literal `"empty"` when nothing matched |

"Tools" means every `devEngines` runtime plus Biome when a version was resolved. Biome rides along because it is versioned, tool-cached, and a version change has to invalidate the archive holding the old one.

The **arch segment is new**. Without it an arm64 and an x64 macOS runner share a key and restore each other's tool-cache directories — binaries for the wrong architecture, from a cache that reports a hit.

The **cache bust goes into the version digest** rather than into a segment of its own, so a busted run keeps the same key layout while matching nothing an unbusted run wrote.

A **branchless run** — a tag, a detached HEAD — hashes the literal `"null"` rather than `""`, so all of them share one key instead of each getting the digest of the empty string by accident.

### Branch resolution

`GITHUB_HEAD_REF` first, then `GITHUB_REF` with a `refs/heads/` prefix stripped, else `""`. Head-ref-first matters on pull requests, where `GITHUB_REF` names the synthetic merge ref (`refs/pull/12/merge`): keying on it would give every PR a private cache nothing else ever restores.

### Restore ladder

```ts
export const RESTORE_DEPTHS = [4, 3] as const;

const key = busted ? segments.withoutRestoreKeys() : segments.withRestoreDepths(RESTORE_DEPTHS);
```

| Depth | Pattern | Matches |
| --- | --- | --- |
| primary | `{plat}-{arch}-{ver}-{branch}-{lock}` | Exact |
| 4 | `{plat}-{arch}-{ver}-{branch}-` | Same branch, any lockfile content |
| 3 | `{plat}-{arch}-{ver}-` | Any branch, same tool versions |

Two rungs, **not** the default every-prefix ladder `CacheKey` derives. The default's remaining rungs (`linux-x64-`, `linux-`) drop the *version* digest, and a cache built for a different Node would restore against them. Carrying the policy on the key means `ActionCache.restore` reads the rungs back off it, so the primary and its fallbacks cannot drift apart. Legacy stopped at the same two depths.

A **cache bust removes the ladder entirely** via `withoutRestoreKeys()` — zero rungs, which is distinct from *absence* (absence selects the default ladder). The fixtures pair a create run with a restore run under one busted key to prove an **exact** hit, and any fallback rung would satisfy the restore without proving anything.

### Lockfile patterns

| Manager | Patterns |
| --- | --- |
| npm | `**/package-lock.json`, `**/npm-shrinkwrap.json` |
| pnpm | `**/pnpm-lock.yaml`, `**/pnpm-workspace.yaml`, `**/.pnpmfile.cjs` |
| yarn | `**/yarn.lock`, `**/.pnp.cjs`, `**/.yarn/install-state.gz` |
| bun | `**/bun.lock`, `**/bun.lockb` |
| deno | `**/deno.lock` |

Two of pnpm's three are not lockfiles at all — `pnpm-workspace.yaml` and `.pnpmfile.cjs` change what an install resolves to just as a lockfile does, so they belong in the key. They land in the `lockfiles` output as a consequence.

yarn's `.yarn/install-state.gz` is both an input to the key **and** a file the cache archives, so a saved cache invalidates the key that saved it. Carried over deliberately: the fixtures pin yarn PnP files as lockfiles, and the self-invalidation costs a rebuild rather than correctness.

Exclusions apply to every pattern set:

```ts
["!**/node_modules/**", "!**/.git/**", "!**/__fixtures__/**", "!**/__tests__/**", "!**/__test__/**"]
```

A lockfile only means something at the repository root or in a real workspace package. Inside `node_modules` it belongs to a dependency; inside a fixture tree it is a deliberate fake — this repository's own `__fixtures__/` carries five.

The caller's `additional-lockfiles` are appended **after** the built-in sort, in the order written, so a workflow author reading them back out of the `lockfiles` output sees their own list where they put it.

### Which package managers are active

A **runtime**, not the manifest, is what makes a manager active: node brings the `devEngines` package manager, while bun and deno are their own. A workspace declaring `packageManager: pnpm` with only a bun runtime caches bun's store and not pnpm's — pnpm never runs. The list is de-duplicated, first-seen order.

### Archived paths

Three groups, and the order is the contract:

1. **Built-ins, sorted** (absolute paths alphabetically, then globs alphabetically):
   - each active manager's default store directory,
   - each active manager's workspace paths,
   - `<toolCacheBase>/<tool>/<version>` for every runtime and Biome.
2. **`additional-cache-paths`**, in the order written.
3. **`**/.turbo/cache`**, when turbo was detected.

The final list is de-duplicated, because a caller naming `**/node_modules` would otherwise hand `tar` the same tree twice. Legacy concatenated the same three groups and lost both the sort and the de-duplication.

| Manager | Default store (POSIX / win32) | Workspace paths |
| --- | --- | --- |
| npm | `~/.npm` / `%LOCALAPPDATA%\npm-cache` | `**/node_modules` |
| pnpm | `~/.local/share/pnpm/store` / `…\pnpm\store` | `**/node_modules` |
| yarn | `~/.yarn/cache` **and** `~/.cache/yarn` / `…\Yarn\Cache` and `…\Yarn\Berry\cache` | `**/node_modules`, `**/.yarn/cache`, `**/.yarn/unplugged`, `**/.yarn/install-state.gz` |
| bun | `~/.bun/install/cache` / `…\bun\install\cache` | `**/node_modules` |
| deno | `~/.cache/deno` / `%LOCALAPPDATA%\deno` | none — deno resolves from its own store and never populates `node_modules` |

yarn contributes two stores because Berry and Classic disagree about where the cache lives and the manager's major version is not known here. The tool-cache base is `RUNNER_TOOL_CACHE` when set, else `/opt/hostedtoolcache` (`C:\hostedtoolcache` on win32).

Paths are joined with `posix` or `win32` explicitly rather than the host's `node:path`, which is the same thing in production but is what lets a Linux test pin the Windows store layout.

### Turbo's local artifact cache

When `turbo.json` is detected, `**/.turbo/cache` — and only that — joins the archive. `**/.turbo/runs` (run summaries), `.turbo/cookies` and `.turbo/daemon` are deliberately excluded: a restored stale run summary would break "latest run = current run" detection by tooling that parses `turbo --summarize` output, and the other two are ephemeral.

This file-cache layer and the embedded remote cache are **complementary, not alternatives**. The remote cache is the primary — turbo writes artifacts to it through the HTTP API — and the file layer is a fast local restore on top. Do not propose dropping either.

### Non-fatal by construction

Every degradation goes through one helper, so "the restore never fails the action" is a mechanism rather than a rule each call site remembers:

```ts
const absorb = (effect, reason, message, fallback) =>
  effect.pipe(Effect.catch((cause) =>
    Effect.logWarning(new CacheError({ reason, message: message(cause), cause }).message).pipe(Effect.as(fallback))));
```

Discovery failures fall back to `[]`, hashing failures to `Option.none()` (so the segment becomes `"empty"`), restore failures to `Option.none()` (a miss), and a state-save failure to a warning. The declared `CacheError` is the shape a failure is *logged as*; the step answers with a miss-shaped `CacheState` and lets the installs proceed.

**Recorded deviation:** state is persisted even after a failed restore, so the post phase still saves what this run installed. Legacy left the next run cold too.

---

## Cross-phase state protocol

GitHub Actions runs `main` and `post` as separate processes. State crosses as **text**: `save` appends `key<<DELIM` heredoc blocks to the `GITHUB_STATE` file, and the runner republishes each as a `STATE_<key>` environment variable that `get` reads back.

> **Rule: every field's *encoded* form must be plain JSON.** `ActionState` uses a JSON text protocol — `JSON.stringify(encoded)` out, `JSON.parse` in.

This is not theoretical. `CacheState.restoredKey` was originally `Schema.Option(Schema.String)`, whose **encoded** form is an `Option` *instance*. Stringifying it goes through `Option.toJSON` and produces `{"_id":"Option","_tag":"Some",…}`, which no longer decodes — `"Expected Option"`. Main reported a successful save and post could not read it. The fix is one line: `Schema.OptionFromNullOr(Schema.String)`, which encodes to `string | null`.

Two corollaries:

- **In-memory test doubles are strictly more permissive than the runner.** A `Map`-backed double hands the encoded object straight back and round-trips schemas that JSON cannot. Never trust one alone for a state schema — `__test__/unit/state.test.ts` uses the **real** `ActionState.layer` against a temp `GITHUB_STATE` file and republishes it the way the runner does. That is the harness pattern for any future state schema.
- **The same constraint applies to `BlobEnvelope` metadata.** The envelope writes metadata as JSON between its header and the body, so `turbo-cache/meta.ts` spells its tag `Schema.NullOr(Schema.String)` for exactly this reason.

### The two state values

```ts
export const STATE_KEYS = { cache: "silk-runtime-cache", turboServer: "silk-runtime-turbo-server" } as const;

export class CacheState extends Schema.Class<CacheState>("CacheState")({
  paths: Schema.Array(Schema.String),
  primaryKey: Schema.String,
  restoredKey: Schema.OptionFromNullOr(Schema.String),
  lockfiles: Schema.Array(Schema.String),
}) {}

export class TurboServerState extends Schema.Class<TurboServerState>("TurboServerState")({
  pid: ProcessId,
  port: Schema.Number,
  backend: Schema.Literals(["github", "s3"]),
  logFile: Schema.String,
}) {}
```

`restoredKey` distinguishes all three outcomes in one field: `None` is a miss, `Some(primaryKey)` is an exact hit, `Some(other)` is a partial restore from a fallback rung. The comparison lives once, beside the state:

```ts
export const isExactHit = (state: CacheState): boolean =>
  Option.isSome(state.restoredKey) && state.restoredKey.value === state.primaryKey;
```

Both phases turn on it — `post` saves unless it is `true`, and `main` publishes `cache-hit` from it — and the panel's cache cell derives from it too, so there is exactly one definition of "exact".

`lockfiles` rides along because it is the restore step's answer to the `lockfiles` output and this is the value the step already returns; `post` has no use for it. `pid` is `ProcessId` rather than a bare number because a truncated state file, an absent key or `Number("")` all decode to `0`, and `ProcessId` refuses that value rather than letting it reach `DetachedProcess.reap`.

`STATE_KEYS` values are internal, **not** parity surface, and free to change.

### Post-phase save

```text
getOptional(cache, CacheState)
  None                     -> "nothing to save"
  isExactHit               -> skip (the archive is already what this run would write; entries are immutable)
  paths.length === 0       -> skip
  otherwise                -> ActionCache.save(paths, primaryKey)   [primary, not the matched key]
```

Saving on a **partial** restore as well as a miss, and always under the *primary* key, is the point: a partial restore left the archive short of what this run installed, so the key this run asked for is the one that has to end up populated.

**Known cost, carried deliberately:** `post` runs even when `main` failed, so an install that died halfway can seal a half-populated `node_modules` under the primary key. Fixing it needs `main` to leave a completed marker, which is a hardening pass of its own.

---

## Rationale

### Typed `CacheKey` over string assembly

Restore keys and the primary key are one value, so they cannot drift. The kit derives the ladder from the key's segments, `ActionCache.restore` reads the policy off the key, and the three policies the action needs (default depths, two rungs, no rungs) are all expressible. Before `withoutRestoreKeys` existed, "this key or nothing" forced the cache-bust branch off the typed key and back onto a bare string; that bypass is gone.

### `"empty"` rather than an empty segment

Legacy left the lockfile segment empty, producing a key ending in `-`. The kit's `Segment` is `/^[^,\n\r]+$/` and refuses an empty string outright, so the no-lockfile case needs a name. `"empty"` is the spelling upstream's own `hashMatching` example uses. Nothing depends on the old shape — a cache key is not parity surface, and the fixtures only need two runs of the same version to agree.

### Store paths as a defaults table

Legacy shelled the manager for its configured store (`npm config get cache`, `pnpm store path`, …) and fell back to a table on any failure — about fifty lines of subprocess for a value that, on a GitHub runner with a freshly installed manager, is always the default. Dropped with the detection: no fixture ever asserted a detected store path, and the step now needs no spawner at all.

### One archive for everything

Runtime tool-cache directories are archived alongside dependency stores rather than in a second cache. A runtime bump therefore invalidates the dependency cache, which is a real cost — but the alternative is two caches that can disagree about what was installed. Legacy's design, kept.

### 8-character digests

Full SHA-256 is 64 hex; 8 hex gives ~4.3 × 10⁹ values. For a single repository's cache the collision probability is negligible, and short segments keep the key readable in a log.

### Branch in the key

A feature branch with modified dependencies should not restore a stale archive from `main`. Depth 3 still reaches across branches when no branch-specific entry exists.

---

## Implementation details

### Where each piece lives

| Concern | Location | Kind |
| --- | --- | --- |
| Active managers, patterns, store/workspace paths, key segments, ladder policy | `src/steps/cache-config.ts` | Pure, host-argument-driven |
| Workspace/tool-cache/branch resolution, discovery, hashing, restore, state save | `src/steps/restore-cache.ts` | Effectful |
| `CacheState`, `TurboServerState`, `isExactHit`, `STATE_KEYS` | `src/state.ts` | Schema |
| The save | `src/post.ts` | Effectful |

Splitting the pure half out is what lets a test pin the Windows store paths, the arch segment and the ladder policy without a runner, a filesystem or a mocked `process`.

### Discovery and hashing

```ts
const lockfiles = yield* absorb(CacheKey.matchingFiles({ workspace, patterns }), "key", …, []);
const lockfileHash = yield* absorb(CacheKey.hashFiles(lockfiles), "key", …, Option.none<string>());
```

The workspace comes from `ActionEnvironment.github`'s context, falling back to `process.cwd()` outside a runner; nothing outside it is walked or hashed.

**Upstream note:** `CacheKey.matchingFiles` applies `!` exclusions as a **post-filter** over a full recursive `readDirectory`, so `!**/node_modules/**` no longer prunes traversal. The output is identical; the cost is a cold walk on large trees.

Detection precedes the restore in `program.ts` because both the resolved Biome version and turbo's presence feed the key and the path set. See [architecture](./architecture.md#pipeline-steps-srcprogramts).

### Debug logging

At `ACTIONS_STEP_DEBUG=true` the step logs the primary key, the restore ladder (or `(none — exact match only)`), the resolved path set with its count, the lockfile list with its count, and the cache bust — the last **whether or not one is set**, because a run that restored nothing is exactly the run where "was a bust in play?" is the first question, and its absence has to be an answer rather than a missing line.

### The cache verdict line

`cacheLine` in `restore-cache.ts` is the one formatter for the tristate prose: `exact hit (N lockfiles)`, `partial hit (…)`, `miss (…)`, singular `1 lockfile` included, carried over verbatim from v1. The count belongs on the line because a miss with no lockfiles is a different problem from a miss with three: the first says the patterns matched nothing, the second says the dependencies changed. The job-summary panel renders the same three states from the same `CacheState` (`cacheCell` in `summary/format.ts`), so the log and the panel cannot disagree.

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) — pipeline order, the cross-phase state diagram.
- [Turbo remote cache](./turbo-remote-cache.md) — the embedded remote cache the `.turbo/cache` layer complements, and the second consumer of the plain-JSON state rule.
- [Effect service model](./effect-service-model.md) — the `absorb` posture and the error taxonomy.
- [Testing strategy](./testing-strategy.md) — the real-`ActionState` round-trip harness and the create/restore fixture pairs.

**Source files:**

- `src/steps/cache-config.ts` — every pure cache decision.
- `src/steps/restore-cache.ts` — key computation, restore, state save.
- `src/state.ts` — `CacheState`, `TurboServerState`, `isExactHit`, `STATE_KEYS`.
- `src/post.ts` — the save.
