---
status: current
module: silk-runtime-action
category: performance
created: 2026-03-21
updated: 2026-08-20
last-synced: 2026-08-20
completeness: 95
related:
  - ./architecture.md
  - ./effect-service-model.md
  - ./runtime-installation.md
  - ./turbo-remote-cache.md
dependencies: []
---

# Caching strategy

Dependency and tool caching: the typed `CacheKey`, the restore ladder, lockfile discovery, the archived path set, the separate kcov cache, and the cross-phase state protocol.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [The kcov cache](#the-kcov-cache)
4. [Cross-phase state protocol](#cross-phase-state-protocol)
5. [Rationale](#rationale)
6. [Implementation details](#implementation-details)
7. [Related documentation](#related-documentation)

---

## Overview

The action caches dependency stores, workspace `node_modules`, the tool-cache directories of everything it installed, and (when turbo is detected) turbo's local artifact cache — all under one key derived from the platform, the architecture, the tool versions, the branch and the lockfile contents.

There is a **second, deliberately separate** Actions cache entry: the kcov tree, keyed on the runner image and the pinned kcov version and on nothing a lockfile can touch. See [the kcov cache](#the-kcov-cache).

Every restore this action makes goes through a **typed `CacheKey`** from `@effected/github-actions`, which carries its own restore-key policy so the primary key and its fallbacks cannot drift apart.

**Key features:**

- Key: `{platform}-{arch}-{versionHash}-{branchHash}-{lockfileHash}`, arch included (legacy had none).
- Discovery and hashing through `CacheKey.matchingFiles` / `CacheKey.hashFiles`, bounded by `GITHUB_WORKSPACE`.
- A two-rung restore ladder (`withRestoreDepths([4, 3])`), and an explicitly **empty** ladder for a busted run.
- Every decision that is not a runner call is a pure function in `steps/cache-config.ts`.
- Cross-phase state whose encoded form is plain JSON, by rule.
- `**/.turbo/cache` joins the archive when turbo is detected — a complement to the embedded remote cache, not a replacement.
- kcov has its **own** entry, its own key ladder and its own cross-phase state, none of which touch the dependency cache.

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

## The kcov cache

kcov is **built from source on every platform** (there is no usable prebuilt — see [runtime installation](./runtime-installation.md#kcov-is-built-from-source-because-nothing-else-works)), which costs minutes. The Actions cache is what makes that acceptable, and it is a second entry rather than a share of the first.

### Why it is not folded into the dependency cache

The two are keyed on entirely different things. The dependency cache turns on lockfile hashes, the branch and the `devEngines` tool versions; the kcov entry turns on a pinned tool version plus the runner's `ImageOS` and architecture. Sharing one entry would tie a multi-minute build to the lockfiles and **discard it on every dependency bump** — and, in the other direction, would keep a stale kcov tree alive across an image change that a lockfile edit happens not to notice. Neither key is a proxy for the other, so neither can carry the other's payload.

bats-core and the four helper libraries are cached by **neither**. They are roughly 500 KB across five tarballs, about two seconds of download, and an Actions cache round trip costs about the same. Coupling them to kcov's entry would mean a kcov key change needlessly re-downloads bats, and a poisoned entry takes out both. One expensive artifact, one cache entry.

### The key ladder

```text
rung     kcov-<version>-<ImageOS>-<arch>-<bustDigest>
primary  <rung>-<ImageVersion>
```

Assembled by `kcovCacheKey` in `descriptors/kcov.ts` — a typed `CacheKey` with `withRestoreDepths([5])`, on the same reasoning as the dependency key: the kit owns the ladder, `ActionCache.restore` reads the rungs straight off the key, and the primary and its fallbacks cannot drift apart.

| Situation | Behaviour |
| --- | --- |
| Image unchanged | Exact hit on the primary. Fast path, no save, no `apt`/`brew`. |
| `ImageVersion` bumped (roughly weekly) | Primary misses, the rung restores the previous entry, the probe passes, `post` **re-saves** it under the new primary. Warm; costs one ~7 MB upload. |
| System libraries moved under one `ImageOS` | The probe fails, the step rebuilds, and `post` saves under the **new** primary. The next run exact-hits a binary that works. |

**`ImageOS` in the rung, `ImageVersion` in the primary — and the two decisions are complementary, not contradictory.** The first draft used the `ImageOS` prefix alone as a single key, reasoning that `ImageVersion` bumps weekly and would reduce the cache to near-uselessness. That reasoning was *incomplete rather than wrong*: as a **sole** key `ImageVersion` really would mean a weekly cold rebuild, but with an `ImageOS` rung underneath it a bump restores warm off the rung and re-saves. Anyone revisiting this will rediscover the weekly-bump objection; it is answered by the rung, not by dropping the primary.

What the ladder buys that a single key cannot have is **self-healing**, and the qualifier is exact:

> Cache entries are **immutable**, and `ActionCache.save` treats an already-taken key as success. Under a single key, a tree whose system libraries have moved is therefore poisoned *permanently*: every run restores it, fails the probe, rebuilds, saves to the same taken key, and throws the good tree away — correct every time and permanently slow, for the ~2 years an LTS `ImageOS` lives.

- A failed **rung** restore is healed: the rebuild lands under a primary nothing holds yet, and the next run exact-hits a working binary.
- A failed **exact** restore is *not* healed — the rebuild's key is the one it just restored from, so the save is a no-op. What the ladder buys there is a **bound**: the poisoning lasts until any primary component moves, in practice the next `ImageVersion` bump, roughly a week. One image-version window instead of two years. Closing it outright would need a discriminator for failed exact restores, a key segment every run pays for to shorten a window this rare. Deliberately not done.

Two placement rules that look arbitrary and are not:

- **The bust is a digest segment the rung retains**, not a tail on the primary. A trailing bust would leave the rung un-busted, so a busted run would miss its primary, match an ordinary entry on the rung, and restore it — defeating `cache-bust`'s entire documented purpose. It also stops the traffic in the other direction: an unbusted run's rung prefix-matching a busted entry. Both rungs carry the bust or neither does. A busted run additionally drops its ladder (`withoutRestoreKeys()`), so a fixture's restore proves an **exact** hit rather than being satisfied by a rung — the same distinction the dependency key draws, where zero rungs is a *policy* and absence selects the default ladder.
- **`ImageOS` and `ImageVersion` are arguments, and empty is absent.** The runner exports an empty string for a variable it has no value for, and `??` keeps it happily. An `ImageOS=""` would key on `kcov-43--x64-…`, a namespace the `<platform>-unknown` fallback that same runner uses everywhere else never matches — a cache that stays cold forever without ever looking wrong. An absent `ImageVersion` (every self-hosted runner) collapses the primary onto what would have been the rung and drops the ladder, degrading exactly to single-key semantics rather than minting a `…-undefined` key nothing matches or a dead rung nothing can match either.

### The verify probe

A restored kcov binary is **probed** (`kcov --version`) before it is trusted, and a failing probe falls through to a rebuild.

`install-biome` deliberately has no such probe, and the asymmetry is the point: Biome is a single static executable that a later step either invokes or does not. kcov dynamically links `libdw`, `libbfd`, `libelf` and `libcurl` against the runner's system libraries, so an entry can be simultaneously **valid by key and unloadable in practice**. That is precisely the failure that makes kcov's own published binary unusable, happening to this action's cache instead of to someone else's release asset.

The key narrows the window; the probe closes it. The **fall-through to a rebuild** is what makes it a mitigation rather than a detection — a probe that reported failure without rebuilding would be strictly worse than no probe at all.

The rejected tree is `rm -rf`'d before the rebuild. `make install` only replaces the files it produces, so anything the restored entry carried that this build does not would survive, and the state handed to `post` names the whole prefix — sealing the probe's rejects into the *new* entry, which is the opposite of what the path is for. A failure to remove is not worth failing over.

### `KcovCacheState` and the post-phase save

`state.ts` gains a third key and class beside `CacheState` and `TurboServerState`:

```ts
export class KcovCacheState extends Schema.Class<KcovCacheState>("KcovCacheState")({
  paths: Schema.Array(Schema.String),
  primaryKey: Schema.String,
  restoredKey: Schema.OptionFromNullOr(Schema.String),
}) {}
```

`Schema.OptionFromNullOr`, not `Schema.Option`, for the reason the [next section](#cross-phase-state-protocol) documents at length.

`main` writes it in exactly two cases, and the omitted case is the interesting one:

| Restore outcome | State written? | Why |
| --- | --- | --- |
| Exact hit, probe passes | No | The tree is already in the cache under the key a save would use. |
| Rung hit, probe passes | Yes, `restoredKey = Some(old)` | Good and warm, but living under the *old* primary. Skipping this save is the mistake that leaves the ladder permanently one image behind. |
| Miss, or a probe failure that rebuilt | Yes, `restoredKey = None` | `restoredKey` is `None` on the build path **whatever the restore did** — the tree on disk was just built, and nothing about the restored entry describes it, so `post` must always attempt the save. |

`post` gains a third independent branch, in its own read-and-catch beside the turbo reap and the dependency save. Three independent jobs, three independent failure modes, and none of them may cost another its work: an unreadable dependency-cache state says nothing about whether the kcov tree is worth archiving. The `main`-side state save is likewise best-effort — a run whose kcov works but whose successor rebuilds it is a slower run, not a broken one, and failing the install over a `GITHUB_STATE` write would make it one.

---

## Cross-phase state protocol

GitHub Actions runs `main` and `post` as separate processes. State crosses as **text**: `save` appends `key<<DELIM` heredoc blocks to the `GITHUB_STATE` file, and the runner republishes each as a `STATE_<key>` environment variable that `get` reads back.

> **Rule: every field's *encoded* form must be plain JSON.** `ActionState` uses a JSON text protocol — `JSON.stringify(encoded)` out, `JSON.parse` in.

This is not theoretical. `CacheState.restoredKey` was originally `Schema.Option(Schema.String)`, whose **encoded** form is an `Option` *instance*. Stringifying it goes through `Option.toJSON` and produces `{"_id":"Option","_tag":"Some",…}`, which no longer decodes — `"Expected Option"`. Main reported a successful save and post could not read it. The fix is one line: `Schema.OptionFromNullOr(Schema.String)`, which encodes to `string | null`.

Two corollaries:

- **In-memory test doubles are strictly more permissive than the runner.** A `Map`-backed double hands the encoded object straight back and round-trips schemas that JSON cannot. Never trust one alone for a state schema — `__test__/unit/state.test.ts` uses the **real** `ActionState.layer` against a temp `GITHUB_STATE` file and republishes it the way the runner does. That is the harness pattern for any future state schema.
- **The same constraint applies to `BlobEnvelope` metadata.** The envelope writes metadata as JSON between its header and the body, so `turbo-cache/meta.ts` spells its tag `Schema.NullOr(Schema.String)` for exactly this reason.

### The three state values

```ts
export const STATE_KEYS = {
  cache: "silk-runtime-cache",
  turboServer: "silk-runtime-turbo-server",
  kcovCache: "silk-runtime-kcov",
} as const;

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

export class KcovCacheState extends Schema.Class<KcovCacheState>("KcovCacheState")({
  paths: Schema.Array(Schema.String),
  primaryKey: Schema.String,
  restoredKey: Schema.OptionFromNullOr(Schema.String),
}) {}
```

`KcovCacheState` carries no `lockfiles` and gets no `isExactHit`: its cache has two outcomes where the dependency cache has three, so `post` compares `restoredKey` to `primaryKey` inline rather than reaching for a shared helper that encodes a distinction kcov does not have.

`restoredKey` distinguishes all three outcomes in one field: `None` is a miss, `Some(primaryKey)` is an exact hit, `Some(other)` is a partial restore from a fallback rung. The comparison lives once, beside the state:

```ts
export const isExactHit = (state: CacheState): boolean =>
  Option.isSome(state.restoredKey) && state.restoredKey.value === state.primaryKey;
```

Both phases turn on it — `post` saves unless it is `true`, and `main` publishes `cache-hit` from it — and the panel's cache cell derives from it too, so there is exactly one definition of "exact".

`lockfiles` rides along because it is the restore step's answer to the `lockfiles` output and this is the value the step already returns; `post` has no use for it. `pid` is `ProcessId` rather than a bare number because a truncated state file, an absent key or `Number("")` all decode to `0`, and `ProcessId` refuses that value rather than letting it reach `DetachedProcess.reap`.

`STATE_KEYS` values are internal, **not** parity surface, and free to change.

### Post-phase save

The dependency-cache branch, which is one of three (reap → dependency cache → kcov cache), each reading its own state key and catching its own failures:

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
| `CacheState`, `TurboServerState`, `KcovCacheState`, `isExactHit`, `STATE_KEYS` | `src/state.ts` | Schema |
| kcov's key and ladder | `src/descriptors/kcov.ts` (`kcovCacheKey`) | Pure, image-as-argument |
| kcov's restore, probe, rebuild and state stash | `src/steps/install-kcov.ts` | Effectful |
| The saves | `src/post.ts` | Effectful |

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
- `src/descriptors/kcov.ts` — `kcovCacheKey`, the ladder and the bust placement.
- `src/steps/install-kcov.ts` — restore → probe → build → stash.
- `src/state.ts` — `CacheState`, `TurboServerState`, `KcovCacheState`, `isExactHit`, `STATE_KEYS`.
- `src/post.ts` — the two saves.
