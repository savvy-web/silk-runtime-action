---
title: Two cache entries — the workspace archive and the package-manager store — keyed independently
description: Why dependency caching is split into a workspace archive and a store, what each key deliberately omits, and how the store tops up rather than freezing.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: f0f88f25627d467b85fc21658b46a2d80efca6d3d4f46bedf8cfd3029d6e6bfa
sources:
  - id: cache-config
    resource: ../../src/steps/cache-config.ts
  - id: restore-cache
    resource: ../../src/steps/restore-cache.ts
  - id: post
    resource: ../../src/post.ts
tags:
  - caching
  - performance
  - architecture
---

# Two cache entries — the workspace archive and the package-manager store — keyed independently

## Context

Dependency installation produces two kinds of on-disk state with different lifetimes: the
linked `node_modules` trees (specific to a platform, an architecture, a set of tool
versions, and a lockfile) and each package manager's own download cache (content-addressable
and append-only, unrelated to which branch or runtime is in play). Caching them under one
key ties the long-lived one to the short-lived one's turnover.[^cache-config]

## Decision

The action keeps **two** Actions cache entries, because what they hold goes stale for
different reasons:

- The **workspace archive** — linked `node_modules` trees, yarn's PnP directories, every
  installed tool's tool-cache directory, and (when turbo is detected) turbo's local artifact
  cache — keyed on the platform, the architecture, the tool versions, the install policy,
  the branch, and the lockfile contents.[^cache-config]
- The **package-manager store** — each active manager's global download cache — keyed on
  the platform, the architecture, the manager version, and the lockfile contents, and
  **nothing else**. A store is content-addressable and append-only, so a branch cut or a
  runtime bump has no business discarding it.[^cache-config]

They hit and miss independently and report on `cache-hit` and `store-cache-hit`
respectively.[^cache-config]

**The install-policy token is part of the workspace key precisely because a poisoning was
observed in production.** The token is `deps:scripts`, `deps:no-scripts`, or `no-deps`, from
the `install-deps` and `ignore-scripts` inputs. The archive is a picture of the workspace
*after* the install, so two runs whose installs do different things must not share a key.
Before the token existed, a job passing `install-deps: false` archived an empty
`node_modules` under exactly the key a full-install job would use; every later run then
reported an exact hit, skipped the save, and installed from the network anyway, with nothing
able to repair it because the poisoned entry kept winning. This was observed in
`spencerbeggs/effected` as an "exact hit" restore followed by pnpm's
`reused 0, downloaded 939`. `ignore-scripts` is the same hazard one layer down — a tree built
with lifecycle scripts skipped is missing every `postinstall` artifact — and a skipped
install collapses to one token whatever `ignore-scripts` says. See
[exact-hit-skips-save-poisoning](../gotchas/exact-hit-skips-save-poisoning.md).[^cache-config]

**The store key's format is `store-{platform}-{arch}-{managerHash}-{lockfileHash}`, and what
is absent is the point.** No branch — a store from another branch is as good as this one's.
No runtime or Biome version — a package tarball is the same tarball whichever node unpacks
it. `managerHash` is a digest of the cache-bust (if any) then each active manager as
`name:version`, sorted by name — versioned because the store layout itself is (pnpm keeps a
`v10`/`v11` subdirectory beneath the archived path).[^cache-config]

The lockfile digest stays on the store key, doing a different job than it does on the
workspace key: a store is append-only, so an older one is never *wrong*, only short. Keeping
the digest on the primary key while `STORE_RESTORE_DEPTHS = [4]` drops it from the one rung
below is what makes the entry **top up**: a changed lockfile misses the primary, hits the
rung, restores the previous store, lets the install add what is new, and archives the union
under the new digest. Without the digest the key would never change, every run after the
first would report an exact hit, and — since an exact hit skips the save — the store would
freeze at whatever the first run downloaded. There is deliberately nothing below depth 4:
depth 3 would drop the manager version and restore a store laid out for a different
major.[^cache-config]

**Archived paths follow `WorkspaceDiscovery.listPackages()`, not `**/node_modules`.** The
workspace archive's `node_modules` entries come from that discovery call — one per workspace
package, as `<relativePath>/node_modules`, root first — replacing a bare `**/node_modules`
glob that matched every `node_modules` anywhere beneath the checkout, including ones inside
`dist/` trees and test fixtures. A discovery failure, or an empty answer, degrades to
root-only with a warning: a layout the kit cannot parse is precisely the one where a
wildcard would sweep up the most, and a cache is never worth failing a run
over.[^cache-config][^restore-cache]

**Store paths are a defaults table, not a shelled-out probe.** A legacy implementation asked
each manager for its configured store (`npm config get cache`, `pnpm store path`, …) and
fell back to a table on any failure — about fifty lines of subprocess for a value that, on a
GitHub runner with a freshly installed manager, is always the default. That detection is
dropped: no fixture ever asserted a detected store path, and the step now needs no spawner
at all.[^cache-config]

**One archive for everything.** Runtime tool-cache directories are archived alongside the
package managers' stores in the *workspace* archive rather than in a third cache. A runtime
bump therefore invalidates the dependency cache, which is a real cost — but the alternative
is two caches that can disagree about what was installed, and a `node_modules` with native
builds is specific to the runtime that built it. This is the pairing the split into two
entries preserves, not one it introduces.[^cache-config]

`post`'s dependency-cache branch reads `CacheState`, skips the save on an exact hit or an
empty path set, and otherwise saves under the **primary** key — not whichever key matched —
because a partial restore left the archive short of what this run installed, so the key this
run asked for is the one that has to end up populated.[^post]

## Alternatives rejected

- **One combined cache entry for both the workspace and the store.** Coupling their keys
  would tie the store's long append-only lifetime to the workspace archive's short one (a
  branch cut, a runtime bump), discarding a perfectly good store on every event that only
  the workspace archive needed to react to.
- **Including the branch or runtime versions in the store key.** The whole value of a store
  is that a package tarball is identical regardless of which branch or runtime unpacked it;
  including either would fragment the store needlessly and slow every branch's first run.
- **Dropping the lockfile digest from the store's primary key**, to avoid ever missing the
  primary. That would freeze the store at its first download forever, since an exact hit on
  the primary skips the save.
- **A bare `**/node_modules` glob for archived paths.** It matched fixture and `dist/`
  copies that no install produced and no restore used, inflating the archive with directories
  nothing needed.
- **Re-adding a shelled-out per-manager store-path probe.** No fixture ever needed the
  detected answer over the defaults table, and dropping it removed the step's spawner
  dependency entirely.

## Consequences

Any new package manager added to this action needs both a lockfile pattern set and a default
store-path entry, and its default store path becomes part of the defaults table's contract
rather than something probed at runtime. The install-policy token must be included in any
future key derivation touching what the workspace install actually does — a key describing a
resulting state, keyed on inputs that do not capture every choice that produced it, recreates
the exact-hit-skips-save poisoning this decision closes. `WorkspaceDiscovery.listPackages()`
becomes a load-bearing dependency of correct cache-path resolution; a change to how it
enumerates packages is a change to what gets archived.

[^cache-config]: cache-config
[^restore-cache]: restore-cache
[^post]: post
