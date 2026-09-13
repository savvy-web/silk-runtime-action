---
title: kcov gets its own Actions cache entry, key ladder, and verify probe
description: Why kcov is cached separately from the dependency archive, how the ImageOS rung and ImageVersion primary combine to self-heal, and why a restored binary is probed before it is trusted.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 2a979818003019cca405a0565d152b8248c42ffe1234629a88de9a50ab0b08c2
sources:
  - id: kcov-descriptor
    resource: ../../src/descriptors/kcov.ts
  - id: install-kcov
    resource: ../../src/steps/install-kcov.ts
  - id: state
    resource: ../../src/state.ts
  - id: post
    resource: ../../src/post.ts
tags:
  - caching
  - architecture
---

# kcov gets its own Actions cache entry, key ladder, and verify probe

## Context

kcov is built from source on every platform because no usable prebuilt exists, which costs
minutes. The Actions cache is what makes that acceptable — but the dependency cache turns on
lockfile hashes, the branch, and `devEngines` tool versions, none of which have anything to
do with when a built kcov tree goes stale; kcov goes stale when the runner's system libraries
move under it, tracked by the runner's `ImageOS` and `ImageVersion`.[^kcov-descriptor]

## Decision

kcov gets a **second, independent** Actions cache entry, its own key ladder, and its own
cross-phase state, none of which touch the dependency cache.[^state]

**Why not folded into the dependency cache:** sharing one entry would tie a multi-minute
kcov build to lockfile hashes and discard it on every dependency bump, and in the other
direction would keep a stale kcov tree alive across an image change a lockfile edit happens
not to notice. Neither key is a proxy for the other, so neither can carry the other's
payload. bats-core and its four helper libraries are cached by **neither** entry — at roughly
500 KB across five tarballs and about two seconds of download, an Actions cache round trip
costs about the same, and coupling them to kcov's entry would mean a kcov key change
needlessly re-downloads bats while a poisoned entry takes out both.

**The key ladder**, assembled by `kcovCacheKey`:

```text
rung     kcov-<version>-<ImageOS>-<arch>-<bustDigest>
primary  <rung>-<ImageVersion>
```

with `withRestoreDepths([5])` — the same typed-`CacheKey` reasoning as the dependency key: the
kit owns the ladder, `ActionCache.restore` reads the rungs off it, and the primary and its
fallbacks cannot drift apart.[^kcov-descriptor]

| Situation | Behaviour |
| --- | --- |
| Image unchanged | Exact hit on the primary. Fast path, no save, no `apt`/`brew`. |
| `ImageVersion` bumped (roughly weekly) | Primary misses, the rung restores the previous entry, the probe passes, `post` re-saves it under the new primary. Warm; costs one upload. |
| System libraries moved under one `ImageOS` | The probe fails, the step rebuilds, and `post` saves under the **new** primary. The next run exact-hits a binary that works. |

**`ImageOS` in the rung, `ImageVersion` in the primary — complementary, not contradictory.**
An earlier design used `ImageOS` alone as a single key, reasoning that `ImageVersion` bumps
roughly weekly and would reduce the cache to near-uselessness. That reasoning was incomplete
rather than wrong: as a **sole** key, `ImageVersion` really would mean a weekly cold rebuild,
but with an `ImageOS` rung underneath it a bump restores warm off the rung and re-saves under
the new primary. Anyone revisiting this design will rediscover the weekly-bump objection; it
is answered by the rung, not by dropping the primary.[^kcov-descriptor]

What the ladder buys that a single key cannot have is **self-healing**, and the qualifier is
exact: cache entries are **immutable**, and a save to an already-taken key is a success.
Under a single key, a tree whose system libraries have moved is poisoned **permanently** —
every run restores it, fails the probe, rebuilds, saves to the same taken key, and throws the
good tree away, correct every time and permanently slow for the roughly two years an LTS
`ImageOS` lives. A failed **rung** restore is healed: the rebuild lands under a primary
nothing holds yet, and the next run exact-hits a working binary. A failed **exact** restore
is *not* healed — the rebuild's key is the one it just restored from, so the save is a no-op.
What the ladder buys there instead is a **bound**: the poisoning lasts until any primary
component moves, in practice the next `ImageVersion` bump, roughly a week — one
image-version window instead of two years. Closing it outright would need a discriminator
for failed exact restores, a key segment every run would pay for to shorten a window this
rare; deliberately not done.[^kcov-descriptor]

Two placement rules that look arbitrary and are not:

- **The bust is a digest segment the rung retains**, not a tail on the primary. A trailing
  bust would leave the rung un-busted, so a busted run would miss its primary, match an
  ordinary entry on the rung, and restore it — defeating `cache-bust`'s documented purpose —
  and would also let an unbusted run's rung prefix-match a busted entry in the other
  direction. Both rungs carry the bust or neither does. A busted run additionally drops its
  ladder entirely (`withoutRestoreKeys()`), so a fixture's restore proves an exact hit rather
  than being satisfied by a rung — the same distinction the dependency key draws, where zero
  rungs is a *policy* and absence selects the default ladder.[^kcov-descriptor]
- **`ImageOS` and `ImageVersion` are arguments, and empty is absent.** The runner exports an
  empty string for a variable it has no value for. An `ImageOS=""` would key on
  `kcov-43--x64-…`, a namespace the `<platform>-unknown` fallback used everywhere else never
  matches — a cache that stays cold forever without ever looking wrong. An absent
  `ImageVersion` (every self-hosted runner) collapses the primary onto what would have been
  the rung and drops the ladder, degrading exactly to single-key semantics rather than
  minting a `…-undefined` key nothing matches or a dead rung nothing can match
  either.[^kcov-descriptor][^install-kcov]

**The verify probe.** A restored kcov binary is probed (`kcov --version`) before it is
trusted, and a failing probe falls through to a rebuild.[^install-kcov] `install-biome`
deliberately has **no** such probe, and the asymmetry is the point: Biome is a single static
executable a later step either invokes or does not. kcov dynamically links `libdw`, `libbfd`,
`libelf`, and `libcurl` against the runner's system libraries, so an entry can be
simultaneously **valid by key and unloadable in practice** — the same failure mode that makes
kcov's own published binary unusable, happening to this action's cache instead of to
someone else's release asset. The key narrows the window; the probe closes it. The
**fall-through to a rebuild** is what makes it a mitigation rather than a detection: a probe
that reported failure without rebuilding would be strictly worse than no probe at
all.[^install-kcov]

The rejected tree is `rm -rf`'d (`fs.remove(prefix, { recursive: true })`) before the
rebuild. `make install` only replaces the files it produces, so anything the restored entry
carried that the new build does not would otherwise survive — and the state handed to `post`
names the whole prefix, sealing the probe's rejects into the *new* entry, the opposite of
what the path is for. A failure to remove is not worth failing the step over.[^install-kcov]

**`KcovCacheState` and the post-phase save.** `state.ts` carries a third cross-phase-state
class beside `CacheState` and `TurboServerState`:

```ts
export class KcovCacheState extends Schema.Class<KcovCacheState>("KcovCacheState")({
  paths: Schema.Array(Schema.String),
  primaryKey: Schema.String,
  restoredKey: Schema.OptionFromNullOr(Schema.String),
}) {}
```

`main` writes it in exactly two cases:

| Restore outcome | State written? | Why |
| --- | --- | --- |
| Exact hit, probe passes | No | The tree is already in the cache under the key a save would use. |
| Rung hit, probe passes | Yes, `restoredKey = Some(old)` | Good and warm, but living under the *old* primary. Skipping this save is the mistake that leaves the ladder permanently one image behind. |
| Miss, or a probe failure that rebuilt | Yes, `restoredKey = None` | `restoredKey` is `None` on the build path whatever the restore did — the tree on disk was just built, and nothing about the restored entry describes it, so `post` must always attempt the save. |

`post` runs a third independent branch (`saveKcovCache`), reading its own state key and
catching its own failures beside the turbo reap and the dependency-cache save — three
independent jobs, three independent failure modes, none of which may cost another its
work.[^post] The `main`-side state save is likewise best-effort: a run whose kcov works but
whose successor rebuilds it is a slower run, not a broken one, and failing the install over
a `GITHUB_STATE` write would make it one.[^install-kcov]

## Alternatives rejected

- **One shared cache entry keyed on both lockfiles and the runner image.** Ties an expensive,
  rarely-invalid build to a frequently-changing digest, and vice versa.
- **`ImageOS` as the sole key, with no `ImageVersion` component.** Trades a weekly cold
  rebuild for simplicity nobody asked for once the rung already solves the same problem.
- **`ImageVersion` as the sole key.** Poisons a broken tree for the roughly two-year life of
  an LTS `ImageOS`, since every rebuild saves back to the same taken key.
- **A discriminator segment to close the exact-restore poisoning window outright.** Rejected
  as a permanent per-run cost to shorten a rare, already-bounded window.
- **No verify probe, matching `install-biome`.** kcov's dynamic linking against system
  libraries makes "valid by key" and "loadable in practice" genuinely different claims for
  this tool specifically; Biome's single static executable has no such gap.

## Consequences

A dependency bump never discards a warm kcov build, and a runner image change never keeps a
broken one alive past one `ImageVersion` window. The cost is one extra Actions cache entry
and one extra piece of cross-phase state to reason about, but each is independent: an
unreadable dependency-cache state says nothing about whether the kcov tree is worth
archiving, and the reverse holds too.

[^kcov-descriptor]: kcov-descriptor
[^install-kcov]: install-kcov
[^state]: state
[^post]: post
