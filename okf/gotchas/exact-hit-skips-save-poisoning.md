---
title: An "exact hit" that installs from the network anyway is a poisoned cache, not a fast one
description: A workspace or store cache entry archived empty under a shared key reports exact hit forever after, and every later run pays a full install while believing it saved one.
type: Gotcha
status: draft
stale_after: 2027-03-13T00:00:00Z
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 1650adb2f3ae6c4de7a034deffb89517346aa98fcd6455c4defba503b65d7d5b
resource: ../../src/post.ts
sources:
  - id: post
    resource: ../../src/post.ts
tags:
  - caching
  - ci
---

# An "exact hit" that installs from the network anyway is a poisoned cache, not a fast one

## What a reader sees

`post` logs `"Cache was an exact hit — skipping save"` (workspace) or
`"Store cache was an exact hit — skipping save"` (store) and returns immediately, without
touching `ActionCache`.[^post] A run reporting `cache-hit: true` and skipping the save looks
like the system working exactly as designed: nothing changed, so nothing needs re-archiving.

## What that leads you to conclude

That an exact hit is always the fast path it appears to be, and that "the cache reported a
hit" and "this run's dependencies are actually on disk, ready for the job" are the same
fact.

## What is actually true

An "exact hit" only means the *key* matched a previous save — it says nothing about what was
**inside** that save. Two independent stories show the same failure shape:

**The workspace archive, before the install-policy token existed.** A job run with
`install-deps: false` archived an effectively-empty `node_modules` under the same key a
full-install job would later compute. Every subsequent run against that key reported an
exact hit and skipped the save — by design, since `saveDependencyCache` only skips on
`isExactHit`[^post] — while installing from the network anyway, because there was nothing
usable in the restored archive. Observed against `spencerbeggs/effected` as an "exact hit"
restore followed by pnpm's own `reused 0, downloaded 939`. Nothing could self-repair it:
every later run kept re-computing the same key, kept matching the same poisoned entry, and
kept skipping the save that would have fixed it. `ignore-scripts` is the identical hazard one
layer down — a tree built with lifecycle scripts skipped is not the tree a normal install
needs, and archiving it under a key a normal install will also compute reproduces the same
trap.

**The store, one layer down, guarded differently.** The store key deliberately carries no
install-policy token at all — a store is exactly as good regardless of which run filled it —
so `saveStoreCache` cannot lean on a key-shaped defense the way the workspace archive can. Its
skip condition is a plain `restoredKey` comparison against `primaryKey`, exactly like the
workspace case, but before it runs, `populatedStores` **probes every configured store path
for actual directory contents** and archives only the ones with something in them.[^post]
The reasoning stated at that probe: a directory that does not exist was never the dangerous
case — `ActionCache.save` already fails outright when nothing resolves — an **existing but
empty** directory is the danger, because a package manager creates its store root the first
time it runs, whether or not that run downloaded anything into it.[^post] Without the probe,
a cold store keyspace whose first job installs nothing would archive an empty store under the
shared key; the next full-install job would exact-hit that entry, download everything, and
skip its own save — freezing the store at "empty" until the lockfile changed and moved the
key. The probe deliberately checks **content**, not whether an install ran: a job that passes
`install-deps: false` and then installs in a later step has a populated store by the time
`post` runs, and archiving it is correct — gating on the input alone would throw that work
away.[^post]

The rule this leaves behind: an "exact hit" is a claim about the **key**, never a claim about
what is inside the entry it matched. A skip-on-hit guard that trusts the key alone is only
safe when nothing that computes the same key can ever populate the entry emptily; anywhere
that is not guaranteed, the guard needs its own content probe, the way the store's does.

See [`two-cache-entries-workspace-and-store`](../decisions/two-cache-entries-workspace-and-store.md)
for the install-policy token itself and
[`cross-phase-state`](../models/cross-phase-state.md) for the state each cache branch reads.

[^post]: post
