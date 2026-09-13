---
title: A typed CacheKey carries the restore-ladder policy, never a bare string
description: Why the dependency cache key is assembled through the kit's typed CacheKey rather than string concatenation, and the reasoning behind each segment and the two-rung ladder.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 6af5ae179ca821983375a13423bd346a8b8efca95f3d6c2c84c52da053219334
sources:
  - id: cache-config
    resource: ../../src/steps/cache-config.ts
  - id: restore-cache
    resource: ../../src/steps/restore-cache.ts
tags:
  - caching
  - architecture
---

# A typed CacheKey carries the restore-ladder policy, never a bare string

## Context

Every restore this action makes needs a primary key and a set of fallback rungs that agree
with each other: if the ladder is derived separately from the primary key, the two can
drift, and `ActionCache.restore` has no way to notice. Before `CacheKey.withoutRestoreKeys`
existed upstream, "this key or nothing" — the shape the cache-bust case needs — had no
expression as a policy, and forced that one branch off the typed key and onto a bare
string.[^cache-config]

## Decision

The dependency cache key is built by `keySegments`, a pure function returning the ordered
segment tuple `platform-arch-versionHash-branchHash-lockfileHash`, handed straight to the
kit's typed `CacheKey`.[^cache-config] `ActionCache.restore` reads the ladder policy off the
key itself, so the primary and its fallbacks cannot disagree about what they mean.

Each segment is a specific choice, not an arbitrary one:

- **The lockfile segment is the literal `"empty"` when nothing matched**, never an empty
  string. The kit's `Segment` type rejects any comma, newline, or carriage return, and it
  refuses an empty string outright too, so the no-lockfile case needs a name; `"empty"` is
  the spelling the kit's own `hashMatching` example uses.[^cache-config]
- **Digests are truncated to 8 hex characters** via `CacheKey.digest(value, DIGEST_LENGTH)`.
  Full SHA-256 is 64 hex; 8 gives roughly 4.3 × 10⁹ values, which is negligible collision risk
  for a single repository's cache and keeps a key readable in a log.[^cache-config]
- **The arch segment is new** — legacy had none. Without it, an arm64 and an x64 runner on the
  same OS share a key and restore each other's tool-cache directories: binaries for the wrong
  architecture, from a cache that reports a hit.[^cache-config]
- **The install-policy token** (`deps:scripts`, `deps:no-scripts`, `no-deps`, derived from
  `install-deps` and `ignore-scripts`) rides in the same version digest as the tool versions,
  because the archive is a picture of the workspace *after* the install, and two runs whose
  installs did different things must not share a key.[^cache-config]
- **The cache bust rides in the version digest too**, rather than occupying a segment of its
  own, so a busted run keeps the same key layout while matching nothing an unbusted run
  wrote.[^cache-config]
- **A branchless run — a tag, a detached HEAD — hashes the literal `"null"`**, not the empty
  string, so every contextless run shares one key instead of each getting the digest of `""`
  by accident.[^cache-config][^restore-cache]

**Branch resolution** goes through the kit's `GitHubContext.branch`: `headRef` when the event
has one, otherwise `refName`. That fallback matters on a pull request, where `GITHUB_REF`
names the synthetic merge ref (`refs/pull/12/merge`) rather than the branch — keying on it
would give every pull request a private cache nothing else ever restores. The kit also
absorbs a trap in the raw variable: the runner writes `GITHUB_HEAD_REF` as the **empty
string** on non-PR events rather than omitting it, so a naive read would report it present
and key the whole repository under one empty branch.[^restore-cache]

**The restore ladder is two rungs, not the kit's default every-prefix ladder**:

```ts
export const RESTORE_DEPTHS = [4, 3] as const;
```

Depth 4 drops the lockfile digest (same branch, any lockfile content); depth 3 drops the
branch as well (any branch, same tool versions). The default ladder's remaining rungs
(`linux-x64-`, `linux-`) drop the *version* digest entirely, and a cache built for a
different Node would restore against them — which is why the policy is carried on the key
rather than left to derive automatically. Legacy stopped at the same two depths.[^cache-config]

A cache bust removes the ladder **entirely** via `key.withoutRestoreKeys()` — zero rungs,
which is a **policy**, distinct from *absence*: absence still selects the kit's default
every-prefix ladder. The fixtures pair a create run with a restore run under one busted key
specifically to prove an **exact** hit; any fallback rung would satisfy the restore without
proving anything.[^cache-config]

**Upstream note:** `CacheKey.matchingFiles`, called in `restoreCache` to discover lockfiles,
applies `!` exclusions as a post-filter over a full recursive `readDirectory` rather than
pruning traversal — the output is identical to a pruning implementation, but the cost is a
cold walk on a large tree.[^restore-cache]

## Alternatives rejected

- **String-assembled keys with a hand-rolled restore-key array.** This is what the branch's
  cache-bust case was forced back onto before `withoutRestoreKeys` existed, and it is exactly
  the "this key or nothing" bypass the typed `CacheKey` was adopted to close.[^cache-config]
- **An empty lockfile segment.** Legacy left it empty, producing a key ending in a bare `-`.
  The kit's `Segment` regex refuses that outright.[^cache-config]
- **The kit's default every-prefix restore ladder.** Its shorter rungs (`linux-x64-`,
  `linux-`) drop the version digest, which would let a run restore tool-cache directories
  built for a different runtime version.[^cache-config]
- **Hashing the empty string for a branchless run.** That would give every contextless run
  its own private digest of `""` instead of one shared bucket.[^cache-config]

## Consequences

A cache key and its restore ladder can never drift apart, because `ActionCache.restore`
reads both off one value. Adding a new key segment or changing the ladder depth is a change
in exactly one pure function (`keySegments` / `RESTORE_DEPTHS`), testable without a runner,
a filesystem, or a mocked `process`. The 8-character digest truncation and the `"null"` /
`"empty"` sentinel spellings are not parity surface — a cache key is free to change shape
between releases without breaking a consumer's workflow.

[^cache-config]: cache-config
[^restore-cache]: restore-cache
