---
title: Cross-phase state — STATE_KEYS and the four Schema.Class bundles
description: What main writes and post reads across the GitHub Actions main/post process boundary, and what breaks when an entry's shape is wrong.
status: draft
type: DataModel
resource: ../../src/state.ts
tags:
  - caching
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 9cea61548325729c2e08cf9b415c492759687682cf6ffa3cb235a68d17cf303f
sources:
  - id: state
    resource: ../../src/state.ts
  - id: post
    resource: ../../src/post.ts
  - id: state-test
    resource: ../../__test__/unit/state.test.ts
---

# Cross-phase state — STATE_KEYS and the four Schema.Class bundles

`main` and `post` run as **separate processes** in a GitHub Actions job. `src/state.ts` is the
one place that defines what crosses the boundary between them: four `STATE_KEYS` entries, each
paired with a `Schema.Class` bundle, that `main` saves through `ActionState.save` and `post`
reads back through `ActionState.getOptional`.[^state]

## The text protocol, and the rule it forces

State crosses as **text**: `ActionState.save` appends `key<<DELIM` heredoc blocks to the
`GITHUB_STATE` file, and the runner republishes each block as a `STATE_<key>` environment
variable that `get`/`getOptional` reads back (`state.ts:4-8`). `ActionState` itself layers a
JSON text protocol on top — `JSON.stringify(encoded)` out, `JSON.parse` in.

**Rule: every field's *encoded* form must be plain JSON.** This is not a preference; it is the
lesson of a real bug. `CacheState.restoredKey` was originally `Schema.Option(Schema.String)`,
whose *encoded* form is an `Option` *instance*. Stringifying it goes through `Option.toJSON`
and produces `{"_id":"Option","_tag":"Some",…}`, which does not decode back —
`JSON.parse` hands `ActionState`'s decoder an object shape `Schema.Option`'s decoder rejects
as `"Expected Option"`. `main` reported a successful save; `post` could not read it. The fix is
one line: `Schema.OptionFromNullOr(Schema.String)`, which encodes to `string | null` — plain
JSON, round-trips cleanly. Every `restoredKey` field below carries this schema for exactly
that reason. See [plain-json-cross-phase-state](../conventions/plain-json-cross-phase-state.md)
for the convention this incident produced.

Two corollaries worth carrying here rather than deferring: an **in-memory test double is
strictly more permissive than the runner** — a `Map`-backed double hands the encoded object
straight back and round-trips a schema JSON cannot, so a state schema must be proven against
the **real** `ActionState.layer` over a temp `GITHUB_STATE` file, republished the way the
runner does it, which is exactly what `__test__/unit/state.test.ts` does. And the same
plain-JSON constraint governs an unrelated boundary in this codebase — `BlobEnvelope`
metadata, since the envelope also writes its metadata as JSON; see
[turbo-artifacts-protocol](../interfaces/turbo-artifacts-protocol.md).

## `STATE_KEYS`

```ts
export const STATE_KEYS = {
  cache: "silk-runtime-cache",
  storeCache: "silk-runtime-store",
  turboServer: "silk-runtime-turbo-server",
  kcovCache: "silk-runtime-kcov",
} as const;
```

(`state.ts:9-14`)

These string values are **internal, not parity surface** — free to change without notice,
unlike the `action.yml` input/output names documented in
[action-contract](../interfaces/action-contract.md).

## The four state values

### `CacheState` — the dependency cache

```ts
export class CacheState extends Schema.Class<CacheState>("CacheState")({
  paths: Schema.Array(Schema.String),
  primaryKey: Schema.String,
  restoredKey: Schema.OptionFromNullOr(Schema.String),
  lockfiles: Schema.Array(Schema.String),
}) {}
```

(`state.ts:37-42`)

`restoredKey` distinguishes all three `ActionCache` outcomes in one field: `None` is a miss,
`Some(primaryKey)` is an exact hit, `Some(otherKey)` is a partial restore from a fallback rung.
`isExactHit` is the one definition both phases turn on:

```ts
export const isExactHit = (state: CacheState): boolean =>
  Option.isSome(state.restoredKey) && state.restoredKey.value === state.primaryKey;
```

(`state.ts:52-53`)

`post` saves unless `isExactHit` is true; `main` publishes `cache-hit` from it; the job-summary
panel's cache cell derives from it too — one definition of "exact," used in three places, so
none of them can silently disagree. `lockfiles` rides along because it is the restore step's
own answer to the `lockfiles` output and this is the value the step already has in hand; `post`
never reads it.

### `StoreCacheState` — the package-manager store

```ts
export class StoreCacheState extends Schema.Class<StoreCacheState>("StoreCacheState")({
  paths: Schema.Array(Schema.String),
  primaryKey: Schema.String,
  restoredKey: Schema.OptionFromNullOr(Schema.String),
}) {}
```

(`state.ts:77-81`)

**No `lockfiles` field.** The workspace state already carries the resolved list, and both keys
hash the same digest from it — a second copy in `GITHUB_STATE` would be two things that could
disagree with each other, for no reader that needs both. Its `post` branch compares
`restoredKey` to `primaryKey` **inline** rather than through `isExactHit`, and that inline
comparison carries real weight: the store's one restore rung deliberately drops the lockfile
digest (see [cache-config](./cache-config.md)), so a run whose lockfile changed **hits the
rung** and *must* archive the union under its own new primary key — reading every `Some` as
"already cached, skip the save" would freeze the store at whatever the first job downloaded.

`paths` here are the directories each active manager **would** download to, never a probe of
what is actually on disk. `post` therefore probes each for **content** before archiving, and
saves only the populated ones — the probe is on content, not on whether an install ran in this
job, because a workflow that passes `install-deps: false` and installs in a later step still
has a populated store by the time `post` runs, and archiving it is correct while gating on the
input would throw it away. The probe exists because a *missing* directory was never the
danger — `ActionCache.save` resolves its paths first and fails outright when nothing
matched — but an *existing and empty* one is reachable: a manager creates its store root the
first time it runs, whether or not it downloaded anything into it.

### `TurboServerState` — the embedded cache server's pid

```ts
export class TurboServerState extends Schema.Class<TurboServerState>("TurboServerState")({
  pid: ProcessId,
  port: Schema.Number,
  backend: Schema.Literals(["github", "s3"]),
  logFile: Schema.String,
}) {}
```

(`state.ts:92-97`)

`pid` is `ProcessId`, not a bare `Schema.Number`. The value crosses the phase boundary as text,
and a truncated state file, an absent key, or `Number("")` all decode to `0` — `ProcessId`'s
own schema refuses that value rather than letting `0` reach `DetachedProcess.reap`, where
reaping pid `0` is a different and much worse mistake than reaping nothing. `post` reads this
state first and unconditionally, ahead of every other branch that can return early — see
[turbo-artifacts-protocol](../interfaces/turbo-artifacts-protocol.md) and
[embedded-turbo-server](../decisions/embedded-turbo-server.md) for the server this state
tears down.

### `KcovCacheState` — the kcov build tree

```ts
export class KcovCacheState extends Schema.Class<KcovCacheState>("KcovCacheState")({
  paths: Schema.Array(Schema.String),
  primaryKey: Schema.String,
  restoredKey: Schema.OptionFromNullOr(Schema.String),
}) {}
```

(`state.ts:120-124`)

Deliberately **not** folded into `CacheState`, and given its own `STATE_KEYS` entry, because
the two are keyed on entirely different things: the dependency cache on lockfile hashes and
`devEngines` tool versions, this one on a pinned kcov version plus the runner's `ImageOS` and
architecture. Sharing one entry would tie a multi-minute kcov build to the lockfiles and
discard it on every dependency bump — and, in the other direction, would keep a stale kcov tree
alive across an image change that a lockfile edit happens not to touch.

It has **no `isExactHit`**: kcov's cache has two outcomes (a build happened, or it didn't)
where the dependency cache has three, so `post` compares `restoredKey` to `primaryKey` inline
rather than reaching for a helper that encodes a distinction kcov's cache does not have.
`main` writes this state in exactly two cases:

| Restore outcome | State written? | Why |
| --- | --- | --- |
| Exact hit, verify probe passes | No | The tree is already in the cache under the key a save would use |
| Rung hit, verify probe passes | Yes, `restoredKey = Some(old)` | Good and warm, but living under the *old* primary — skipping this save is the mistake that leaves the ladder permanently one image behind |
| Miss, or a probe failure that rebuilt | Yes, `restoredKey = None` | The tree on disk was just built; nothing about a restored entry describes it, so `post` must always attempt the save |

See [cache-config](./cache-config.md) for the key ladder this state's `restoredKey` derives
from, and [separate-kcov-cache-entry](../decisions/separate-kcov-cache-entry.md) for why the
cache is split at all.

## What `post` derives from each

`post.ts` reads all four states in the same shape: `getOptional`, then a self-contained branch
that **catches its own failure**. The reap (`TurboServerState`) runs first and
unconditionally, ahead of every branch that can return early — a leaked cache server outlives
the job regardless of whether this run's dependencies are worth archiving. The dependency-cache
save and the kcov-cache save are two more independent branches. Three independent jobs, three
independent failure modes, and none of them may cost another its work: an unreadable
dependency-cache state says nothing about whether the kcov tree is worth archiving, and the
reverse holds too. Every save that does run saves under the **primary** key the state names,
never whichever key the restore actually matched — a partial restore left the archive short of
what this run installed, so the key this run asked for is the one that has to end up
populated.

## What breaks if an entry is wrong

- A field whose *encoded* form is not plain JSON (a raw `Schema.Option`, a class instance)
  breaks the `main`→`post` handoff silently: `main` logs a successful save, and `post`'s
  decode fails or reads back the wrong shape.
- A `pid` decoded from a corrupted or missing state as `0` (if it were a bare number) would
  hand `DetachedProcess.reap` a value that means something else entirely on most platforms.
- Treating `StoreCacheState`'s `restoredKey` as "already cached" on every `Some` (via
  `isExactHit`-style logic) freezes the store cache the first time a lockfile bump causes a
  rung restore.
- Skipping the `KcovCacheState` save on a rung hit leaves the cache one `ImageVersion` bump
  permanently behind, since nothing else ever promotes the rung's content to the new primary.

[^state]: state
