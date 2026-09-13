---
title: Debug a cache miss or partial hit
description: How to read the debug log restore-cache.ts emits, interpret the one-line verdict, and trace an unexpected miss or partial hit back to a specific key segment or path pattern.
type: Runbook
status: draft
resource: ../../src/steps/restore-cache.ts
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 1ff0d9c739acb7551aa75ddab1440b27d3014d8e9264c3152bbe5931baec6532
sources:
  - id: restore-cache
    resource: ../../src/steps/restore-cache.ts
  - id: cache-config
    resource: ../../src/steps/cache-config.ts
  - id: install-kcov
    resource: ../../src/steps/install-kcov.ts
tags:
  - caching
  - observability
---

# Debug a cache miss or partial hit

## Trigger

An unexpected `miss` or `partial hit` verdict on a run expected to exact-hit, or a fixture's
`expected-cache-hit` assertion failing in CI.

## Steps

1. **Re-run with `ACTIONS_STEP_DEBUG=true`.** `restore-cache.ts` logs everything relevant at
   debug level, and none of it is visible on an ordinary info-level run.[^restore-cache]
2. **Read the debug lines in order, each answering one question:**
   - `Cache primary key: <key>` — the exact key this run computed.
   - `Cache restore keys: <ladder>` or `(none — exact match only)` — the fallback rungs a
     normal run carries (`RESTORE_DEPTHS = [4, 3]`), versus the deliberately empty ladder a
     `cache-bust` run carries instead.[^restore-cache][^cache-config]
   - `Cache paths (N): <list>` — the resolved path set this run asked the cache to
     restore/save, with its count.
   - `Lockfiles (N): <list>` or `(none)` — the lockfile set that fed the key's lockfile
     hash, with its count.
   - `Cache bust: <value>` or `(none)` — logged **whether or not one is set**, because a run
     that restored nothing is exactly the run where "was a bust in play?" is the first
     question, and its absence has to be an answer rather than a missing line.[^restore-cache]
   - `Cache matched key: <key>` or `(none)` — which key, if any, `ActionCache.restore`
     actually matched.
3. **Interpret the one-line verdict** — `exact hit (N lockfiles)`, `partial hit (N
   lockfiles)`, or `miss (N lockfiles)`, at info level rather than debug. The lockfile count
   on the line is diagnostic in its own right: a **miss with 0 lockfiles** means the lockfile
   patterns matched nothing on this workspace (a layout problem), while a **miss with N > 0**
   means the dependency set actually changed since the last save.[^restore-cache]
4. **Check the key segments against `cache-config.ts`** if the verdict itself is not enough:
   - `{platform}-{arch}-{versionHash}-{branchHash}-{lockfileHash}`, assembled by
     `keySegments`. The `arch` segment exists specifically so an arm64 and an x64 runner on
     the same OS never share a key.[^cache-config]
   - The version digest folds the cache-bust (if any), the install-policy token
     (`deps:scripts` / `deps:no-scripts` / `no-deps`), and every tool version — a mismatch
     here after a Biome or runtime version bump is expected, not a bug.
   - The branch segment hashes the literal `"null"` for a branchless run (a tag, a detached
     HEAD) rather than the empty string, and the branch itself is resolved head-ref-first —
     confirm which ref this run actually saw before assuming the branch segment is wrong.[^cache-config]
5. **Check `store-cache-hit` separately from `cache-hit`.** The store cache logs its own
   `Store cache primary key`, `Store cache paths`, and a three-state `Store cache: miss` /
   `exact hit` / `partial hit` line, keyed independently of the workspace archive — a
   workspace miss with a store hit (or vice versa) is a legitimate, separately diagnosable
   state, not a contradiction.[^restore-cache]
6. **For a kcov cache issue**, check `ImageOS`/`ImageVersion` specifically: kcov's ladder
   keys on `ImageOS` in the fallback rung and `ImageVersion` in the primary, and a restored
   rung is only trusted after a verify **probe** actually runs the built binary — a probe
   failure triggers a from-source rebuild regardless of what the cache reported.[^install-kcov]

## End state

The miss (or partial hit) is explained by a specific, named cause — a changed lockfile, a
version bump, a wrong branch resolution, a path pattern that matched nothing, or (for kcov) a
failed verify probe — rather than left as an unexplained cache-layer anomaly.

See also [`../models/cache-config.md`](../models/cache-config.md) for the full key and
ladder derivation this runbook reads segment-by-segment, and
[`../conventions/log-levels-and-buffering.md`](../conventions/log-levels-and-buffering.md)
for why the debug lines above are invisible without `ACTIONS_STEP_DEBUG=true`. The
poisoned-key case this runbook can also surface — an install-policy mismatch producing a
false exact hit — is
[`../gotchas/exact-hit-skips-save-poisoning.md`](../gotchas/exact-hit-skips-save-poisoning.md).

[^restore-cache]: restore-cache
[^cache-config]: cache-config
[^install-kcov]: install-kcov
