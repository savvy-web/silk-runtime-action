---
"@savvy-web/silk-runtime-action": minor
---

## Features

### `ignore-scripts` input

Skips dependency lifecycle scripts during the install, for jobs that install only to
get a resolved workspace and then run their own build:

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    ignore-scripts: true
```

Each manager is given the flag it actually understands: `--ignore-scripts` for npm
(on `ci` as well as `install`), pnpm and bun; `--mode=skip-build` for yarn Berry,
which dropped `--ignore-scripts`; `--ignore-scripts` for yarn Classic, which never
had `--mode`. The flag composes with the frozen/immutable decision rather than
replacing it, so a locked install stays locked.

Defaults to `false`. It has no effect when `install-deps` is `false`, and none for
deno, which has no install step.

### The package-manager store is now its own cache entry

The global download cache — pnpm's store, npm's `_cacache`, yarn's and bun's caches
— is archived separately from the workspace, under a key holding only the platform,
the architecture, the manager and its version, and the lockfile digest.

There is no branch in that key and no runtime version. A store is content-addressable
and append-only, so another branch's store is as good as yours and a package tarball
does not change because Node did. Previously the store shared the workspace's key, so
every branch cut and every runtime bump threw away a download worth hundreds of
megabytes for no correctness the cache ever needed.

Its single restore key drops the lockfile digest, which is what lets the entry top up:
a changed lockfile restores the previous store, the install adds what is new, and the
union is archived under the new key.

### `store-cache-hit` output

Reports the store restore as `true` | `partial` | `false`, independently of
`cache-hit`. A `false` here beside a `true` there is the shape of a job that restored
its linked trees and will still download every package.

## Bug Fixes

### A `install-deps: false` job no longer poisons the dependency cache

The cache key did not record what the install was going to do, so a job passing
`install-deps: false` archived an empty `node_modules` and an empty store under
exactly the key a full-install job on the same commit would use. Every later run then
reported `exact hit`, skipped the save — there is nothing to re-save when the key
already matches — and installed from the network anyway. Observed as an `exact hit`
restore followed by pnpm's `reused 0, downloaded 939`, on a cache that nothing could
repair because the poisoned entry kept winning.

The install policy now rides in the key's version digest as `deps:scripts`,
`deps:no-scripts` or `no-deps`. `ignore-scripts` goes in with it, for the same reason
one layer down: a `node_modules` built with lifecycle scripts skipped is missing every
`postinstall` artifact, and restoring it into a run that asked for a full install hands
back a tree that looks complete and is not.

### Lockfile discovery no longer matches test fixtures

Built-in lockfile patterns are matched at the **workspace root** only, where every
manager actually writes one; a workspace package's dependency change reaches the key
through the root lockfile rather than beside it. They were previously globbed at any
depth (`**/pnpm-lock.yaml`), guarded by a denylist of directory names —
`__fixtures__`, `__tests__`, `__test__` — which a repository spelling its fixtures
`test/fixtures/`, `e2e/` or `examples/` walked straight past, keying its cache on
files no install ever reads.

`additional-lockfiles` still accepts arbitrary globs, and those still skip
`node_modules`, `.git` and test-fixture directories.

### The archive no longer sweeps up every `node_modules` under the checkout

The workspace archive names one `node_modules` per workspace package, discovered
through `@effected/workspaces`, instead of globbing `**/node_modules`. The glob
matched the `node_modules` inside `dist/` trees and test fixtures too, so the archive
carried directories no install had produced and no restore could use. A discovery
failure degrades to the root `node_modules` with a warning rather than failing the run.

## Maintenance

`@effected/workspaces` was already a declared dependency; it is now actually imported,
by `restoreCache`, to enumerate the workspace's `node_modules` directories.

Every cache key changes shape, so the first run after upgrading is a miss on both
entries. No workflow input or output is removed, and nothing needs changing in a
consuming repository.
