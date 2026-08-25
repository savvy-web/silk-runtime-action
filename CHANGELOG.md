# @savvy-web/silk-runtime-action

## 1.5.0

### Features

#### `ignore-scripts` input

- Skips dependency lifecycle scripts during the install, for jobs that install only to
  get a resolved workspace and then run their own build:

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    ignore-scripts: true
```

- Each manager is given the flag it actually understands: `--ignore-scripts` for npm
  (on `ci` as well as `install`), pnpm and bun; `--mode=skip-build` for yarn Berry,
  which dropped `--ignore-scripts`; `--ignore-scripts` for yarn Classic, which never
  had `--mode`. The flag composes with the frozen/immutable decision rather than
  replacing it, so a locked install stays locked.

- Defaults to `false`. It has no effect when `install-deps` is `false`, and none for
  deno, which has no install step.

#### The package-manager store is now its own cache entry

- The global download cache — pnpm's store, npm's `_cacache`, yarn's and bun's caches
  — is archived separately from the workspace, under a key holding only the platform,
  the architecture, the manager and its version, and the lockfile digest.

- There is no branch in that key and no runtime version. A store is content-addressable
  and append-only, so another branch's store is as good as yours and a package tarball
  does not change because Node did. Previously the store shared the workspace's key, so
  every branch cut and every runtime bump threw away a download worth hundreds of
  megabytes for no correctness the cache ever needed.

- Its single restore key drops the lockfile digest, which is what lets the entry top up:
  a changed lockfile restores the previous store, the install adds what is new, and the
  union is archived under the new key.

- The post phase probes each store directory for content and archives only the populated
  ones. The store key carries no install policy by design, so it cannot tell a&#10;`install-deps: false` run from a full one; without the probe, a cold store keyspace whose
  first job installs nothing would archive an empty store under the shared key and freeze it.
  The probe is on content rather than on whether an install ran, so a workflow that skips
  this action's install and runs its own in a later step still gets its store archived.

#### `store-cache-hit` output

- Reports the store restore as `true` \| `partial` \| `false`, independently of&#10;`cache-hit`. A `false` here beside a `true` there is the shape of a job that restored
  its linked trees and will still download every package.

### Bug Fixes

#### A `install-deps: false` job no longer poisons the dependency cache

- The cache key did not record what the install was going to do, so a job passing&#10;`install-deps: false` archived an empty `node_modules` and an empty store under
  exactly the key a full-install job on the same commit would use. Every later run then
  reported `exact hit`, skipped the save — there is nothing to re-save when the key
  already matches — and installed from the network anyway. Observed as an `exact hit`&#10;restore followed by pnpm's `reused 0, downloaded 939`, on a cache that nothing could
  repair because the poisoned entry kept winning.

- The install policy now rides in the key's version digest as `deps:scripts`,&#10;`deps:no-scripts` or `no-deps`. `ignore-scripts` goes in with it, for the same reason
  one layer down: a `node_modules` built with lifecycle scripts skipped is missing every&#10;`postinstall` artifact, and restoring it into a run that asked for a full install hands
  back a tree that looks complete and is not.

#### Lockfile discovery no longer matches test fixtures

- Built-in lockfile patterns are matched at the **workspace root** only, where every
  manager actually writes one; a workspace package's dependency change reaches the key
  through the root lockfile rather than beside it. They were previously globbed at any
  depth (`**/pnpm-lock.yaml`), guarded by a denylist of directory names —&#10;`__fixtures__`, `__tests__`, `__test__` — which a repository spelling its fixtures&#10;`test/fixtures/`, `e2e/` or `examples/` walked straight past, keying its cache on
  files no install ever reads.

- `additional-lockfiles` still accepts arbitrary globs, and those still skip&#10;`node_modules`, `.git` and test-fixture directories.

#### The archive no longer sweeps up every `node_modules` under the checkout

- The workspace archive names one `node_modules` per workspace package, discovered
  through `@effected/workspaces`, instead of globbing `**/node_modules`. The glob
  matched the `node_modules` inside `dist/` trees and test fixtures too, so the archive
  carried directories no install had produced and no restore could use. A discovery
  failure degrades to the root `node_modules` with a warning rather than failing the run.

### Maintenance

- `@effected/workspaces` was already a declared dependency; it is now actually imported,
  by `restoreCache`, to enumerate the workspace's `node_modules` directories.

- Every cache key changes shape, so the first run after upgrading is a miss on both
  entries. No workflow input or output is removed, and nothing needs changing in a
  consuming repository. [#302][#302]

### Thanks

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#302]: https://github.com/savvy-web/silk-runtime-action/pull/302

## 1.4.9

### Dependencies

| Dependency | Type | Action | From | To |
| --- | --- | --- | --- | --- |
| @effected/sbom | dependency | updated | ^0.4.1 | ^0.4.2 |
| @effected/workspaces | dependency | updated | ^0.18.0 | ^0.18.1 |

[#296][#296]

### Thanks

Thanks to [@savvy-web-bot](https://github.com/apps/savvy-web-bot) for their contributions!

[#296]: https://github.com/savvy-web/silk-runtime-action/pull/296

## 1.4.8

### Refactoring

- Adopted the one-class-per-failure error split. `@effected/github-actions@0.10.0` splits four monolithic tagged errors into one
  class per failure, each of the old names surviving only as a type-only union
  alias. Failures are now matched on `_tag` rather than a `reason` field:

| Was | Now |
| --- | --- |
| `ActionOutputError` | `RunnerFileUnavailableError` \| `RunnerFileWriteError` \| `InvalidOutputNameError` \| `OutputEncodeError` \| `DetachedOutputError` |
| `CacheKeyError` | `CacheKeyReadError` \| `CacheKeyBadPatternError` |
| `DetachedProcessError` | `DetachedLogUnavailableError` \| `DetachedSpawnFailedError` \| `InvalidPidError` \| `DetachedSignalFailedError` \| `DetachedNotReadyError` |
| `BlobEnvelopeError` | `NotABlobEnvelopeError` \| `TruncatedBlobEnvelopeError` \| `UnsupportedBlobEnvelopeVersionError` \| `BlobMetadataDecodeError` \| `BlobMetadataEncodeError` |

- Behavior is unchanged; the visible difference is that a lockfile, spawn or
  cache-key failure now names its class where it previously named a `reason`&#10;literal — `Lockfile discovery failed (CacheKeyReadError)` rather than&#10;`(readFailed)`. The turbo cache handler still treats every unreadable envelope
  as a miss, now by catching all five envelope tags. `ToolInstallerError` also
  gained a required `subject`. [#293][#293]

### Dependencies

| Dependency | Type | Action | From | To |
| --- | --- | --- | --- | --- |
| @effected/git | dependency | updated | ^0.9.0 | ^0.10.0 |
| @effected/github | dependency | updated | ^0.7.0 | ^0.8.0 |
| @effected/github-actions | dependency | updated | ^0.9.2 | ^0.10.0 |
| @effected/lockfiles | dependency | updated | ^0.6.3 | ^0.7.0 |
| @effected/npm | dependency | updated | ^0.11.1 | ^0.12.0 |
| @effected/package-json | dependency | updated | ^0.10.2 | ^0.11.0 |

### Thanks

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#293]: https://github.com/savvy-web/silk-runtime-action/pull/293

## 1.4.7

### Dependencies

| Dependency | Type | Action | From | To |
| --- | --- | --- | --- | --- |
| @effected/markdown | dependency | updated | ^0.6.2 | ^0.6.3 |
| @effected/workspaces | dependency | updated | ^0.17.2 | ^0.18.0 |

[#291][#291]

### Thanks

Thanks to [@savvy-web-bot](https://github.com/apps/savvy-web-bot) for their contributions!

[#291]: https://github.com/savvy-web/silk-runtime-action/pull/291

## 1.4.6

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/lockfiles | dependency | updated | ^0.6.2 | ^0.6.3 |  |
  | @effected/markdown | dependency | updated | ^0.6.1 | ^0.6.2 |  |
  | @effected/workspaces | dependency | updated | ^0.17.1 | ^0.17.2 |  |
  | @effected/yaml | dependency | updated | ^0.10.0 | ^0.11.0 | [#288][#288] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#288]: https://github.com/savvy-web/silk-runtime-action/pull/288

## 1.4.6

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/markdown | dependency | updated | ^0.6.0 | ^0.6.1 | [#285][#285] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#285]: https://github.com/savvy-web/silk-runtime-action/pull/285

## 1.4.5

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/workspaces | dependency | updated | ^0.17.0 | ^0.17.1 | [#282][#282] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#282]: https://github.com/savvy-web/silk-runtime-action/pull/282

## 1.4.4

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/lockfiles | dependency | updated | ^0.6.1 | ^0.6.2 |  |
  | @effected/workspaces | dependency | updated | ^0.16.0 | ^0.17.0 | [#273][#273] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#273]: https://github.com/savvy-web/silk-runtime-action/pull/273

## 1.4.3

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/runtimes | dependency | updated | ^0.4.2 | ^0.4.3 | [#270][#270] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#270]: https://github.com/savvy-web/silk-runtime-action/pull/270

## 1.4.2

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/npm | dependency | updated | ^0.11.0 | ^0.11.1 |  |
  | @effected/runtimes | dependency | updated | ^0.4.1 | ^0.4.2 |  |
  | @effected/workspaces | dependency | updated | ^0.15.1 | ^0.16.0 | [#267][#267] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#267]: https://github.com/savvy-web/silk-runtime-action/pull/267

## 1.4.1

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/lockfiles | dependency | updated | ^0.5.1 | ^0.6.1 |  |
  | @effected/runtimes | dependency | updated | ^0.4.0 | ^0.4.1 |  |
  | @effected/workspaces | dependency | updated | ^0.14.2 | ^0.15.1 | [#264][#264] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#264]: https://github.com/savvy-web/silk-runtime-action/pull/264

## 1.4.0

### Features

- Added auto-detected support for the BATS bash-testing toolchain and kcov coverage.
  - New inputs `bats` and `kcov` (`auto | true | false`, default `auto`). `bats: auto`&#10;installs when the repo shows bash testing — any `**/*.bats` file, or a `vitest-bats`&#10;dependency in the root manifest. `kcov: auto` follows the bats decision.
  - Provisions bats-core `1.14.0` into the tool cache, and `bats-support` `0.3.0`,&#10;`bats-assert` `2.2.4`, `bats-file` `0.4.0` and `bats-mock` `1.2.5` into&#10;`$HOME/.local/share` — one location that satisfies both `bats_load_library` and&#10;`vitest-bats`'s own directory scan, with no `sudo` required.
  - Builds kcov `43` from source and caches it under its own Actions cache entry with a
    restore-key ladder, verifying a restored binary before trusting it and rebuilding when
    that probe fails.
  - Exports `BATS_LIB_PATH`, `BATS_PATH` and `KCOV_PATH`, and adds six new outputs:&#10;`bats-enabled`, `bats-version`, `bats-lib-path`, `kcov-enabled`, `kcov-version` and&#10;`kcov-cache-hit`.
  - Every failure degrades to a warning and a `false` enabled-output — neither install can
    fail the job.
  - Windows is not supported for this toolchain: the kcov descriptor refuses `win32`, and
    the bats install path is validated on Linux and macOS only. [#261][#261]

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/github-actions | dependency | updated | ^0.9.1 | ^0.9.2 | [#261][#261] Thanks [@spencerbeggs](https://github.com/spencerbeggs)! |

### Patch Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#261]: https://github.com/savvy-web/silk-runtime-action/pull/261

## 1.3.11

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/github | dependency | updated | ^0.6.0 | ^0.7.0 |  |
  | @effected/github-actions | dependency | updated | ^0.9.0 | ^0.9.1 |  |
  | @effected/lockfiles | dependency | updated | ^0.5.0 | ^0.5.1 |  |
  | @effected/npm | dependency | updated | ^0.10.0 | ^0.11.0 |  |
  | @effected/package-json | dependency | updated | ^0.10.0 | ^0.10.2 |  |
  | @effected/sbom | dependency | updated | ^0.4.0 | ^0.4.1 |  |
  | @effected/workspaces | dependency | updated | ^0.14.0 | ^0.14.2 | [#259][#259] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#259]: https://github.com/savvy-web/silk-runtime-action/pull/259

## 1.3.10

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/github | dependency | updated | ^0.5.0 | ^0.6.0 |  |
  | @effected/github-actions | dependency | updated | ^0.8.0 | ^0.9.0 | [#256][#256] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#256]: https://github.com/savvy-web/silk-runtime-action/pull/256

## 1.3.9

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effect/platform-node | dependency | updated | 4.0.0-beta.107 | 4.0.0-rc.109 |  |
  | @effected/commands | dependency | updated | ^0.4.0 | ^0.5.0 |  |
  | @effected/git | dependency | updated | ^0.8.0 | ^0.9.0 |  |
  | @effected/github | dependency | updated | ^0.4.3 | ^0.5.0 |  |
  | @effected/github-actions | dependency | updated | ^0.7.0 | ^0.8.0 |  |
  | @effected/glob | dependency | updated | ^0.3.0 | ^0.4.0 |  |
  | @effected/jsonc | dependency | updated | ^0.6.0 | ^0.7.0 |  |
  | @effected/lockfiles | dependency | updated | ^0.4.2 | ^0.5.0 |  |
  | @effected/markdown | dependency | updated | ^0.5.2 | ^0.6.0 |  |
  | @effected/npm | dependency | updated | ^0.9.0 | ^0.10.0 |  |
  | @effected/package-json | dependency | updated | ^0.9.0 | ^0.10.0 |  |
  | @effected/runtimes | dependency | updated | ^0.3.0 | ^0.4.0 |  |
  | @effected/sbom | dependency | updated | ^0.3.1 | ^0.4.0 |  |
  | @effected/semver | dependency | updated | ^0.4.0 | ^0.5.0 |  |
  | @effected/workspaces | dependency | updated | ^0.13.1 | ^0.14.0 |  |
  | @effected/yaml | dependency | updated | ^0.9.0 | ^0.10.0 |  |
  | effect | dependency | updated | 4.0.0-beta.107 | 4.0.0-rc.109 | [#253][#253] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#253]: https://github.com/savvy-web/silk-runtime-action/pull/253

## 1.3.8

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/lockfiles | dependency | updated | ^0.4.1 | ^0.4.2 |  |
  | @effected/markdown | dependency | updated | ^0.5.1 | ^0.5.2 |  |
  | @effected/workspaces | dependency | updated | ^0.13.0 | ^0.13.1 |  |
  | @effected/yaml | dependency | updated | ^0.8.0 | ^0.9.0 | [#250][#250] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

* | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/github | dependency | updated | ^0.4.2 | ^0.4.3 | [#246][#246] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#246]: https://github.com/savvy-web/silk-runtime-action/pull/246

[#250]: https://github.com/savvy-web/silk-runtime-action/pull/250

## 1.3.7

### Bug Fixes

- The npm named in `devEngines.packageManager` is now the npm that actually runs the dependency install.

  Previously an npm pin could be answered by the runner's own npm when its version matched the pin exactly. That answer carries no directory, so it contributed nothing to the `PATH` this action assembles — and the pinned node's bin directory led instead, meaning the install ran the npm *bundled with* that node rather than the pinned one. When the runner's npm did **not** match, the pin was downloaded and did run. So which npm executed depended on the runner image, while the `package-manager-version` output reported the pinned version either way.

  The action now installs the pinned npm unconditionally, so npm behaves like every other tool it provisions. The visible cost is one small download on runs where the runner's npm happened to match.
  - No change for `pnpm`, `yarn`, `bun` or `deno` — none of them had an ambient short-circuit
  - `package-manager` and `package-manager-version` outputs are unchanged

### Refactoring

- Adopts three members `@effected/github-actions` 0.7.0 added for this action, replacing local constructs that existed only because the kit did not ship them. No behavior changes.
  - The turbo cache server's readiness check is now `DetachedProcess.httpProbe`, replacing a local probe. Refused connections, transport errors and non-2xx answers still all mean "not ready yet", and a server that never answers still degrades to a cacheless run
  - The detached-process test seams — one in the main phase, one in `post` — collapse onto the kit's `DetachedProcessOps` / `makeTestOps`
  - Secrets supplied to the action are registered with the runner's log filter through `Secret.mask`, which masks and returns nothing, rather than through a declassification member whose plaintext was discarded

* Removed the defensive wrapper around job-summary rendering. `@effected/github-actions` 0.6.1 documents that a `GitHubMarkdown` render cannot fail, so the wrapper only widened the failure it caught. `SummaryError` now carries the single reason `write`.

### Tests

- Added coverage asserting which npm leads the install's `PATH`, the gap that let the behavior above go unnoticed [#243][#243]

* The readiness cases run against a stubbed `HttpClient` instead of standing up a loopback server, and now assert the probe's exact URL against the exported `TURBO_API` [#243][#243]

### Dependencies

| Dependency | Type | Action | From | To |
| --- | --- | --- | --- | --- |
| @effected/github-actions | dependency | updated | 0.6.1 | 0.7.0 |

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/git | dependency | updated | ^0.7.0 | ^0.8.0 |  |
  | @effected/github | dependency | updated | ^0.4.1 | ^0.4.2 |  |
  | @effected/package-json | dependency | updated | ^0.8.0 | ^0.9.0 |  |
  | @effected/sbom | dependency | updated | ^0.3.0 | ^0.3.1 |  |
  | @effected/workspaces | dependency | updated | ^0.12.0 | ^0.13.0 | [#243][#243] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

Thanks to [@savvy-web-bot](https://github.com/apps/savvy-web-bot) for their contributions!

[#243]: https://github.com/savvy-web/silk-runtime-action/pull/243

## 1.3.6

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/workspaces | dependency | updated | ^0.11.2 | ^0.12.0 | [#236][#236] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#236]: https://github.com/savvy-web/silk-runtime-action/pull/236

## 1.3.5

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/github | dependency | updated | ^0.3.0 | ^0.4.1 |  |
  | @effected/github-actions | dependency | updated | ^0.6.0 | ^0.6.1 | [#233][#233] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#233]: https://github.com/savvy-web/silk-runtime-action/pull/233

## 1.3.4

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/lockfiles | dependency | updated | ^0.4.0 | ^0.4.1 |  |
  | @effected/markdown | dependency | updated | ^0.5.0 | ^0.5.1 |  |
  | @effected/workspaces | dependency | updated | ^0.11.1 | ^0.11.2 |  |
  | @effected/yaml | dependency | updated | ^0.7.0 | ^0.8.0 | [#230][#230] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#230]: https://github.com/savvy-web/silk-runtime-action/pull/230

## 1.3.3

### Dependencies

| Dependency | Type | Action | From | To |
| --- | --- | --- | --- | --- |
| @effected/pnpm-plugin-effect | config | updated | 0.3.2 | 0.4.0 |
| @effect/platform-node | dependency | updated | 4.0.0-beta.101 | 4.0.0-beta.107 |
| @effected/commands | dependency | updated | ^0.2.1 | ^0.4.0 |
| @effected/git | dependency | updated | ^0.5.2 | ^0.7.0 |
| @effected/github | dependency | updated | ^0.2.2 | ^0.3.0 |
| @effected/github-actions | dependency | updated | ^0.4.1 | ^0.6.0 |
| @effected/glob | dependency | updated | ^0.2.2 | ^0.3.0 |
| @effected/jsonc | dependency | updated | ^0.5.2 | ^0.6.0 |
| @effected/lockfiles | dependency | updated | ^0.3.1 | ^0.4.0 |
| @effected/markdown | dependency | updated | ^0.4.2 | ^0.5.0 |
| @effected/npm | dependency | updated | ^0.8.1 | ^0.9.0 |
| @effected/package-json | dependency | updated | ^0.7.2 | ^0.8.0 |
| @effected/runtimes | dependency | updated | ^0.2.3 | ^0.3.0 |
| @effected/sbom | dependency | updated | ^0.2.2 | ^0.3.0 |
| @effected/semver | dependency | updated | ^0.3.1 | ^0.4.0 |
| @effected/workspaces | dependency | updated | ^0.9.4 | ^0.11.1 |
| @effected/yaml | dependency | updated | ^0.6.1 | ^0.7.0 |
| effect | dependency | updated | 4.0.0-beta.101 | 4.0.0-beta.107 |
| @effect/vitest | devDependency | updated | 4.0.0-beta.101 | 4.0.0-beta.107 |
| @savvy-web/github-action-builder | devDependency | updated | ^2.2.2 | ^2.2.3 |
| @savvy-web/silk | devDependency | updated | ^3.4.0 | ^3.5.2 |
| @vitest-agent/plugin | devDependency | updated | ^2.0.13 | ^2.0.16 |

### Maintenance

- Re-pinned the vendored `.repos/effect` reference submodule to `effect@4.0.0-beta.107` so the read-only v4 API authority matches the installed catalog [#222][#222]

### Patch Changes

Thanks to [@savvy-web-bot](https://github.com/apps/savvy-web-bot) for their contributions!

[#222]: https://github.com/savvy-web/silk-runtime-action/pull/222

## 1.3.2

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effected/commands | dependency | updated | ^0.2.0 | ^0.2.1 |  |
  | @effected/git | dependency | updated | ^0.5.1 | ^0.5.2 |  |
  | @effected/github | dependency | updated | ^0.2.1 | ^0.2.2 |  |
  | @effected/github-actions | dependency | updated | ^0.4.0 | ^0.4.1 |  |
  | @effected/glob | dependency | updated | ^0.2.1 | ^0.2.2 |  |
  | @effected/jsonc | dependency | updated | ^0.5.1 | ^0.5.2 |  |
  | @effected/lockfiles | dependency | updated | ^0.3.0 | ^0.3.1 |  |
  | @effected/markdown | dependency | updated | ^0.4.1 | ^0.4.2 |  |
  | @effected/npm | dependency | updated | ^0.8.0 | ^0.8.1 |  |
  | @effected/package-json | dependency | updated | ^0.7.1 | ^0.7.2 |  |
  | @effected/runtimes | dependency | updated | ^0.2.2 | ^0.2.3 |  |
  | @effected/sbom | dependency | updated | ^0.2.1 | ^0.2.2 |  |
  | @effected/semver | dependency | updated | ^0.3.0 | ^0.3.1 |  |
  | @effected/workspaces | dependency | updated | ^0.9.3 | ^0.9.4 |  |
  | @effected/yaml | dependency | updated | ^0.6.0 | ^0.6.1 | [#217][#217] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#217]: https://github.com/savvy-web/silk-runtime-action/pull/217

## 1.3.1

### Bug Fixes

- Corrects three wrong cells in the default package-manager cache-directory table, which archived directories the manager never writes to. Nothing failed — a wrong cell costs a cold cache rather than a broken run, which is why it survived a release. The table now comes from `@effected/npm`'s `PackageManagerCache`, which cites an authority per row.
  - pnpm on macOS now archives `~/Library/pnpm/store` rather than the Linux `~/.local/share/pnpm/store`
  - The yarn rows are unscrambled: Classic is `~/Library/Caches/Yarn` on macOS and `~/.cache/yarn` on Linux, Berry is `~/.yarn/berry/cache`. `~/.yarn/cache` was never either one
  - bun on Windows now archives `~/.bun/install/cache`, the path bun documents on every platform, rather than a path under `AppData`

  A tag push now keys its cache under the tag name. It previously fell through to the branchless bucket every other tag also shared; the cross-branch restore rung means a cold tag still restores what the branch it was cut from saved.

### Refactoring

- Adopts the upstream surfaces that replace hand-rolled equivalents, with no change to the cache keys a run produces.
  - `GitHubContext.branch` replaces the raw `GITHUB_HEAD_REF`/`GITHUB_REF` fallback chain, and encodes the trap that the runner writes `GITHUB_HEAD_REF` as the empty string on non-pull-request events
  - `CacheKey.digest` replaces both hand-rolled `sha256(…).slice(0, 8)` call sites
  - `ChildEnv.prependPath` and `ChildEnv.needsShell` replace the local `pathKeyOf`, `childEnv` and `needsShell`. The child's `PATH` is now joined with the target platform's delimiter rather than the host's
  - `filenamesFor` from `@effected/lockfiles` supplies the lockfile names; the workspace-config extras (`pnpm-workspace.yaml`, `.pnpmfile.cjs`, `.pnp.cjs`, `.yarn/install-state.gz`) and deno's row stay local

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | :-- | :-- | :-- | :-- | :-- | --- |
  | @effected/github-actions | dependency | updated | ^0.3.0 | ^0.4.0 |  |
  | @effected/npm | dependency | updated | ^0.7.0 | ^0.8.0 |  |
  | @effected/lockfiles | dependency | updated | ^0.2.3 | ^0.3.0 |  |
  | @effected/package-json | dependency | updated | ^0.7.0 | ^0.7.1 |  |
  | @effected/workspaces | dependency | updated | ^0.9.2 | ^0.9.3 |  |
  | @vitest-agent/plugin | devDependency | updated | ^2.0.10 | ^2.0.11 | [#209][#209] Thanks [@spencerbeggs](https://github.com/spencerbeggs)! |

### Patch Changes

[#209]: https://github.com/savvy-web/silk-runtime-action/pull/209

## 1.3.0

### Features

- Rebuilt the action's internals on the `@effected/*` Effect v4 suite (`github-actions` 0.3.0, `npm` 0.7.0, `package-json` 0.7.0, `semver` 0.3.0), replacing `@savvy-web/github-action-effects`. The public interface is unchanged — same inputs, outputs, and `devEngines` contract, and the same job summary and log output. Consuming repos require no changes.
  ### Package managers provisioned without Corepack
  Package managers are now installed directly into the tool cache. Corepack has been removed from the install path and is no longer required in consuming repos.
  ### Hardened dependency cache key
  The dependency cache key now includes a CPU-architecture segment, and a partial cache hit falls back through a hardened two-rung restore ladder.
  ### Turbo remote-cache server hardening
  The embedded Turbo remote-cache server is more resilient:
  - A per-run random auth token fails closed instead of accepting unauthenticated requests
  - `SIGTERM` triggers a graceful teardown so in-flight artifact writes are not lost
  - `EADDRINUSE` on the chosen port is handled instead of crashing the job

  ### Runtimes visible to lifecycle scripts
  Lifecycle scripts such as `postinstall` now see the installed runtimes and package manager on `PATH`. This fixes failures in consuming repos whose `postinstall` invokes `bun` or `deno`.

### Bug Fixes

- Windows package manager shims are now invoked safely, mitigating CVE-2024-27980 [#206][#206]

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @savvy-web/github-action-effects | dependency | removed | ^3.1.0 | — |  |
  | @effected/commands | dependency | added | — | ^0.2.0 |  |
  | @effected/git | dependency | added | — | ^0.5.1 |  |
  | @effected/github | dependency | added | — | ^0.2.1 |  |
  | @effected/github-actions | dependency | added | — | ^0.3.0 |  |
  | @effected/glob | dependency | added | — | ^0.2.1 |  |
  | @effected/lockfiles | dependency | added | — | ^0.2.3 |  |
  | @effected/markdown | dependency | added | — | ^0.4.1 |  |
  | @effected/npm | dependency | added | — | ^0.7.0 |  |
  | @effected/package-json | dependency | added | — | ^0.7.0 |  |
  | @effected/runtimes | dependency | added | — | ^0.2.2 |  |
  | @effected/sbom | dependency | added | — | ^0.2.1 |  |
  | @effected/semver | dependency | added | — | ^0.3.0 |  |
  | @effected/workspaces | dependency | added | — | ^0.9.2 |  |
  | @effected/yaml | dependency | added | — | ^0.6.0 | [#206][#206] Thanks [@spencerbeggs](https://github.com/spencerbeggs)! |

### Patch Changes

Thanks to [@spencerbeggs](https://github.com/spencerbeggs) for their contributions!

[#206]: https://github.com/savvy-web/silk-runtime-action/pull/206

## 1.2.3

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @savvy-web/github-action-effects | dependency | updated | ^3.0.5 | ^3.1.0 | [#198][#198] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#198]: https://github.com/savvy-web/silk-runtime-action/pull/198

## 1.2.2

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effect/platform-node | dependency | updated | 4.0.0-beta.99 | 4.0.0-beta.101 |  |
  | @effected/jsonc | dependency | updated | ^0.5.0 | ^0.5.1 |  |
  | @savvy-web/github-action-effects | dependency | updated | ^3.0.4 | ^3.0.5 |  |
  | effect | dependency | updated | 4.0.0-beta.99 | 4.0.0-beta.101 | [#195][#195] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#195]: https://github.com/savvy-web/silk-runtime-action/pull/195

## 1.2.1

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @effect/platform-node | dependency | updated | 4.0.0-beta.98 | 4.0.0-beta.99 |  |
  | @effected/jsonc | dependency | updated | ^0.2.0 | ^0.5.0 |  |
  | @savvy-web/github-action-effects | dependency | updated | ^3.0.1 | ^3.0.4 |  |
  | effect | dependency | updated | 4.0.0-beta.98 | 4.0.0-beta.99 | [#187][#187] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#187]: https://github.com/savvy-web/silk-runtime-action/pull/187

## 1.2.0

### Refactoring

- Migrates the action's internals from Effect v3 to Effect v4 (`effect@4.0.0-beta.98`). This is an internal framework upgrade — the action's public contract is unchanged. Inputs and outputs (`action.yml`), cache-key generation, the turbo remote-cache wire format, and all error messages are identical to the previous release. Existing workflows need no changes.

  Under the hood:
  - `@effect/platform` is dissolved into core `effect` in v4 — `FileSystem` and `Path` now import from `effect`, and Node platform layers come from `@effect/platform-node` (`NodeFileSystem.layer`, `NodeHttpClient.layerUndici`).
  - Services move from `Context.Tag`/`Context.GenericTag` to class-based `Context.Service` with exported `*Shape` companion types (e.g. `RuntimeInstaller` + `RuntimeInstallerShape`).
  - Schema, error, and combinator call sites are updated to the v4 surface (`Schema.Literals`, `Schema.TaggedErrorClass`, `.check(...)` filters, `Schema.decodeUnknownEffect`, `Effect.catch`, `Cause.findErrorOption`, string `LogLevel` values).
  - JSONC parsing moves from `jsonc-effect` to `@effected/jsonc`.

  The full v4 suite (217 tests) passes and the bundled `dist/` is rebuilt against the migrated source.

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | :-- | :-- | :-- | :-- | :-- | --- |
  | effect | dependency | updated | 3.22.0 | 4.0.0-beta.98 |  |
  | @effect/platform-node | dependency | updated | 0.107.0 | 4.0.0-beta.98 |  |
  | @savvy-web/github-action-effects | dependency | updated | 2.4.0 | 3.0.1 |  |
  | @effected/jsonc | dependency | added | — | 0.2.0 |  |
  | @effect/platform | dependency | removed | 0.96.3 | — |  |
  | @effect/cluster | dependency | removed | 0.59.0 | — |  |
  | @effect/rpc | dependency | removed | 0.75.1 | — |  |
  | @effect/sql | dependency | removed | 0.51.1 | — |  |
  | jsonc-effect | dependency | removed | 0.3.1 | — |  |
  | @savvy-web/github-action-builder | devDependency | updated | 1.1.2 | 2.0.2 |  |
  | @savvy-web/silk | devDependency | updated | 2.4.4 | 3.0.2 |  |
  | @vitest-agent/plugin | devDependency | updated | 1.1.9 | 2.0.0 | [#181][#181] Thanks [@spencerbeggs](https://github.com/spencerbeggs)! |

### Minor Changes

[#181]: https://github.com/savvy-web/silk-runtime-action/pull/181

## 1.1.5

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @savvy-web/github-action-effects | dependency | updated | ^2.3.7 | ^2.4.0 | [#165][#165] Thanks [@savvy-web-bot](https://github.com/apps/savvy-web-bot)! |

### Patch Changes

[#165]: https://github.com/savvy-web/silk-runtime-action/pull/165

## 1.1.4

### Dependencies

- | Dependency | Type | Action | From | To |  |
  | --- | --- | --- | --- | --- | --- |
  | @changesets/cli | devDependency | added | — | ^3.0.0-next.8 |  |
  | @savvy-web/github-action-builder | devDependency | updated | ^1.0.3 | ^1.1.0 |  |
  | @savvy-web/silk | devDependency | updated | ^1.3.11 | ^2.0.0 | [#158][#158] Thanks [@spencerbeggs](https://github.com/spencerbeggs)! |

### Patch Changes

[#158]: https://github.com/savvy-web/silk-runtime-action/pull/158

## 1.1.3

### Dependencies

| Dependency | Type | Action | From | To |
| --- | --- | --- | --- | --- |
| @effect/cluster | dependency | updated | ^0.59.0 | catalog:silk |
| @effect/platform | dependency | updated | ^0.96.2 | catalog:silk |
| @effect/platform-node | dependency | updated | ^0.107.0 | catalog:silk |
| @effect/rpc | dependency | updated | ^0.75.1 | catalog:silk |
| @effect/sql | dependency | updated | ^0.51.1 | catalog:silk |
| @savvy-web/github-action-effects | dependency | updated | ^2.3.3 | ^2.3.5 |
| effect | dependency | updated | ^3.21.4 | catalog:silk |
| jsonc-effect | dependency | updated | ^0.2.1 | ^0.3.0 |

## 1.1.2

### Bug Fixes

- [`8bcba52`](https://github.com/savvy-web/silk-runtime-action/commit/8bcba52277be8b79e4d106f98fd67f04b58e92d2) Explicitly declare `@types/node` version.

## 1.1.1

### Dependencies

- [`f48ae13`](https://github.com/savvy-web/silk-runtime-action/commit/f48ae13d768922a92560fd5af44460b85085603c) \| Dependency \| Type \| Action \| From \| To \|
  \| :------------------------------- \| :------------ \| :------ \| :----- \| :----- \|
  \| @savvy-web/github-action-effects \| dependency \| updated \| ^2.3.1 \| ^2.3.3 \|
  \| @savvy-web/github-action-builder \| devDependency \| updated \| ^0.8.0 \| ^1.0.1 \|
  \| @savvy-web/silk \| devDependency \| updated \| ^1.3.4 \| ^1.3.5 \|

* [`fd57381`](https://github.com/savvy-web/silk-runtime-action/commit/fd57381d2925c07a5d3618b657847b01aa4f07ab) \| Dependency \| Type \| Action \| From \| To \|
  \| :------------------------------- \| :------------ \| :------ \| :----- \| :----- \|
  \| @savvy-web/github-action-effects \| dependency \| updated \| ^2.3.0 \| ^2.3.1 \|
  \| @savvy-web/silk \| devDependency \| updated \| ^1.3.3 \| ^1.3.4 \|

## 1.1.0

### Features

- [`c2ac82a`](https://github.com/savvy-web/silk-runtime-action/commit/c2ac82aca9614f7a7bc25c205ce6c75f6d2817b2) ### Runtime-setup job summary and richer logs

The action now writes a GitHub job-summary panel describing the runtime setup —
a table of runtime(s), package manager, Biome, Turbo cache (backend and mode),
dependency-cache hit, and dependency install status, with a collapsed
"Cache details" section listing the cache key and lockfiles. The summary write
is non-fatal: a failure logs a warning and never fails the action.

Collapsed step lines now surface their outcome inline, so you no longer have to
expand a group to see what happened:

- **Detect configuration** shows the detected runtimes, package manager, Biome,
  and whether Turbo was found.
- **Turbo remote cache** shows the active backend and server readiness
  (e.g. `github · server ready (:41230)`), or `passthrough (Vercel)` / `disabled`.
- **Restore cache** shows `exact hit` / `partial hit` / `miss` with the lockfile
  count.

* [`c2ac82a`](https://github.com/savvy-web/silk-runtime-action/commit/c2ac82aca9614f7a7bc25c205ce6c75f6d2817b2) ### Embedded Turborepo remote cache server

When `turbo.json` is detected, the action now auto-starts a local cache server
(bundled as `dist/turbo-server.js`) that persists Turborepo artifacts across
CI runs. Two backends are supported:

- **GitHub Actions cache** (default) — zero-config; uses the existing&#10;`ACTIONS_CACHE_URL` / `ACTIONS_RUNTIME_TOKEN` environment that the runner
  provides.
- **S3-compatible storage** — activated via the new `turbo-s3-*` inputs;
  uses SigV4 request signing internally (no `aws-sdk` dependency).

When `turbo-token` + `turbo-team` are both set the server acts as a passthrough
to the external Vercel Remote Cache instead of one of the local backends.

The server round-trips Turbo's `x-artifact-duration` header (stored on PUT,
returned on GET) so Turborepo reports an accurate `timeSaved` on remote cache
hits, matching local-hit behavior.

**New inputs:**

| Input | Description |
| :-- | :-- |
| `turbo-cache` | Cache mode: `auto` (default) starts the embedded server when `turbo.json` is present; `off` disables. Backend is auto-selected: S3 if `turbo-s3-bucket` is set, otherwise GitHub Actions cache. |
| `turbo-cache-prefix` | Key prefix/namespace for embedded turbo cache artifacts (default: `""`) |
| `turbo-s3-bucket` | S3 bucket name |
| `turbo-s3-region` | AWS region (default: `""`) |
| `turbo-s3-endpoint` | Custom S3-compatible endpoint URL |
| `turbo-s3-access-key-id` | AWS access key ID |
| `turbo-s3-secret-access-key` | AWS secret access key |
| `turbo-s3-session-token` | AWS session token (optional) |
| `turbo-s3-prefix` | S3 key prefix (default: `""`) |

**New outputs:**

| Output | Description |
| :-- | :-- |
| `turbo-cache-backend` | Active backend (`github`, `s3`, `remote`, or `none`) |
| `turbo-cache-port` | Port the local server is listening on |

**Behavior change:** the embedded remote cache server provides artifact-level
caching (faster and more granular than the old whole-`**/.turbo` file cache).
Turbo's local artifact cache (`**/.turbo/cache`) is still file-cached as a fast
local-restore layer, but `**/.turbo/runs` (run summaries) and the other `.turbo`&#10;subdirectories are no longer cached.

### Bug Fixes

- [`c2ac82a`](https://github.com/savvy-web/silk-runtime-action/commit/c2ac82aca9614f7a7bc25c205ce6c75f6d2817b2) ### Lockfile discovery ignores test and fixture directories

Cache-key generation hashes the repository's lockfiles. Lockfile discovery now
excludes test and fixture trees — `__fixtures__/`, `__test__/` (including nested&#10;`fixtures/`), and the Jest `__tests__/` convention — at any depth, in addition
to the existing `node_modules/` and `.git/` exclusions. Repositories that keep
fixture lockfiles (files named like real lockfiles, used by tests) no longer
have those files pollute the dependency cache key, which previously caused
spurious cache invalidation when a fixture changed. Real lockfiles at the
workspace root or in workspace packages are still discovered.

### Dependencies

- | [`c2ac82a`](https://github.com/savvy-web/silk-runtime-action/commit/c2ac82aca9614f7a7bc25c205ce6c75f6d2817b2) | Dependency | Type | Action | From | To |
  | :-- | :-- | :-- | :-- | :-- | --- |
  | @effect/platform | dependency | updated | ^0.96.1 | ^0.96.2 |  |
  | effect | dependency | updated | ^3.21.3 | ^3.21.4 |  |
  | @savvy-web/github-action-effects | dependency | updated | ^2.1.4 | ^2.2.2 |  |
  | @savvy-web/github-action-builder | devDependency | updated | ^0.7.10 | ^0.7.12 |  |
  | @savvy-web/silk | devDependency | updated | ^1.1.0 | ^1.3.0 |  |
  | @savvy-web/vitest | devDependency | updated | ^1.5.0 | ^1.5.1 |  |

### Quieter install logs

The action silences noisy chatter from its own install steps — npm update and
funding notices and husky `prepare` output — by setting `NPM_CONFIG_UPDATE_NOTIFIER`,&#10;`NPM_CONFIG_FUND`, `HUSKY`, and `COREPACK_ENABLE_DOWNLOAD_PROMPT` on its own
process only. These are not exported, so they do not affect later steps in your
job (and `HUSKY=0` correctly skips git-hook installation in CI). The package
manager's own install summary is preserved.

## 1.0.5

### Bug Fixes

- [`137939d`](https://github.com/savvy-web/silk-runtime-action/commit/137939d442ab1e7a44ab3f8919efa22d95a19aa2) The action no longer crashes on Windows runners. The committed bundle had a
  build-machine absolute path frozen into `@azure/storage-common`'s&#10;`createRequire(import.meta.url)` call (reached via the cache service's&#10;`@azure/storage-blob` dependency). That driveless POSIX `file://` path was
  accepted on macOS/Linux but rejected by `createRequire` on Windows, throwing at
  module load. Rebuilt with a bundler that keeps `import.meta.url` as a runtime
  expression, so the path resolves correctly on every platform.

### Dependencies

- | [`137939d`](https://github.com/savvy-web/silk-runtime-action/commit/137939d442ab1e7a44ab3f8919efa22d95a19aa2) | Dependency | Type | Action | From | To |
  | :-- | :-- | :-- | :-- | :-- | --- |
  | @effect/cluster | dependency | updated | ^0.58.2 | ^0.59.0 |  |
  | @effect/platform-node | dependency | updated | ^0.106.0 | ^0.107.0 |  |
  | effect | dependency | updated | ^3.21.2 | ^3.21.3 |  |
  | @savvy-web/github-action-builder | devDependency | updated | ^0.7.8 | ^0.7.10 |  |
  | @savvy-web/silk | devDependency | updated | ^1.0.0 | ^1.1.0 |  |

## 1.0.4

### Other

- [`ae0b23f`](https://github.com/savvy-web/silk-runtime-action/commit/ae0b23fa7a7afe48eacc05d6dd2111c4507edcac) Upgrade to silk-release-action v2.

## 1.0.3

### Other

- [`334253f`](https://github.com/savvy-web/silk-runtime-action/commit/334253f25b51cfa570a85edb015d36fcfe13b9d3) Upgrade to `@savvy-web/silk` dependency system.

## 1.0.2

### Dependencies

- | [`58cf772`](https://github.com/savvy-web/silk-runtime-action/commit/58cf772632b064565b04750667af924f5106c307) | Dependency | Type | Action | From | To |
  | :-- | :-- | :-- | :-- | :-- | --- |
  | @savvy-web/github-action-effects | dependency | updated | ^2.0.1 | ^2.0.2 |  |
  | @savvy-web/github-action-builder | devDependency | updated | ^0.7.1 | ^0.7.2 |  |
  | @savvy-web/lint-staged | devDependency | updated | ^1.2.0 | ^1.2.1 |  |

## 1.0.1

### Dependencies

- | [`202a7f7`](https://github.com/savvy-web/silk-runtime-action/commit/202a7f72029d0b3188a5ad84869340f88348d28d) | Dependency | Type | Action | From | To |
  | :-- | :-- | :-- | :-- | :-- | --- |
  | @savvy-web/github-action-effects | dependency | updated | ^2.0.0 | ^2.0.1 |  |
  | @savvy-web/commitlint | devDependency | updated | ^0.9.1 | ^0.10.0 |  |
  | @savvy-web/lint-staged | devDependency | updated | ^1.1.0 | ^1.2.0 |  |

## 1.0.0

### Breaking Changes

- [`b585e33`](https://github.com/savvy-web/silk-runtime-action/commit/b585e331d11810da11b4bc2900b412d2ee436ef5) ### `additional-lockfiles` accepts only newline-separated values

The `additional-lockfiles` input previously documented comma-separated support. It now only accepts newline-separated values, matching the `ActionInput.multiline` contract from `@savvy-web/github-action-effects` v2.

**Before:**

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    additional-lockfiles: "custom.lock, another.lock"
```

**After:**

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    additional-lockfiles: |
      custom.lock
      another.lock
```

### Features

- [`b585e33`](https://github.com/savvy-web/silk-runtime-action/commit/b585e331d11810da11b4bc2900b412d2ee436ef5) ### v2 Library Standardization

Migrates the action's internals to the v2 conventions provided by `@savvy-web/github-action-effects`, aligning service structure, logging, input handling, and caching with the library's current APIs.

The action's `action.yml` inputs and outputs are unchanged with two exceptions noted below.

### Refactoring

- [`b585e33`](https://github.com/savvy-web/silk-runtime-action/commit/b585e331d11810da11b4bc2900b412d2ee436ef5) Comprehensive internal modernization targeting the v2 library conventions:

* Source reorganized into a canonical layout: `services/`, `errors/`, `schemas/`, `layers/`, `state.ts`
* `main.ts` split into a thin entry point, `program.ts`, and `layers/app.ts`
* Errors migrated to `Schema.TaggedError` with `.message` getters
* `RuntimeInstaller` converted to a `Context.Tag` class
* Logging replaced with `Step.groupStep` / `Step.success` (quiet on success, verbose on failure)
* `src/emoji.ts` removed; log formatting uses `Step.success` and plain strings
* Inputs use `ActionInput.multiline` and `ActionInput.boolean` from the library
* `fast-glob` direct dependency removed; replaced by the library `Glob` service
* `post.ts` reads typed `CacheState` and is wrapped in `Effect.catchAll` + `Effect.catchAllDefect` so post-action failures never fail the workflow

### Tests

- [`b585e33`](https://github.com/savvy-web/silk-runtime-action/commit/b585e331d11810da11b4bc2900b412d2ee436ef5) Test suite migrated to library `<Service>Test` test layers from `@savvy-web/github-action-effects/testing`
- Tests relocated alongside source files under the canonical `src/` layout

### Cache keys will invalidate on first deploy

The cache-key hash algorithm changed from a local `fast-glob` + SHA-256 implementation to the library `Glob.hashFiles` hash-of-hashes. Existing CI caches will miss on the first run after upgrading to this version. Subsequent runs populate and hit the new hash format normally. No action is required — caches rebuild automatically.

## 0.2.2

### Bug Fixes

- [`64f2859`](https://github.com/savvy-web/silk-runtime-action/commit/64f285956b82a93639139358dc843acd1db65c89) Retry `corepack enable` after removing stale shims when it fails with EEXIST. This handles the case where a cached Node installation contains symlinks from a previous corepack setup, causing `corepack enable` to fail when trying to create them again.

## 0.2.1

### Bug Fixes

- [`d16d202`](https://github.com/savvy-web/silk-runtime-action/commit/d16d202c9d0025de9797662008e1b73e8c695616) Fix Node.js not being available on PATH after installation. The Node tar archive extracts to a nested directory (e.g., `node-v24.11.0-linux-x64/`), so the `bin/` path added to PATH didn't contain the actual binary. Now passes `--strip 1` to tar during extraction to flatten the archive root, matching the pattern used by `actions/setup-node`. Also adds `streaming: true` to dependency install for visible error output on failure, and temporary runtime diagnostics logging.

## 0.2.0

### Breaking Changes

- [`354877c`](https://github.com/savvy-web/silk-runtime-action/commit/354877c6a163c476d7153b66f6b434bf2ae0a9d1) Remove explicit version inputs (`node-version`, `bun-version`, `deno-version`, `package-manager`, `package-manager-version`). All configuration now comes exclusively from `package.json` `devEngines` fields.
- Remove `pre` action hook (collapsed into main).
- Require `devEngines.packageManager` and `devEngines.runtime` in `package.json`.

### Features

- [`354877c`](https://github.com/savvy-web/silk-runtime-action/commit/354877c6a163c476d7153b66f6b434bf2ae0a9d1) Rewrite action internals from imperative TypeScript to Effect-based programs using `@savvy-web/github-action-effects` 0.11.x.

* **Zero `@actions/*` dependencies**: The effects library implements the GitHub Actions runtime protocol natively (V2 Twirp caching, native process execution, workflow commands). No CJS/ESM interop issues, no bundler hacks.
* **Effect architecture**: Two entry points (main.ts, post.ts) as Effect pipelines with typed errors, dependency injection via layers, and schema-validated configuration.
* **RuntimeInstaller service**: Shared service with per-runtime descriptor layers (Node.js, Bun, Deno) using ToolInstaller primitives (download, extract, cache, addPath).
* **Biome binary install**: Direct download via ToolInstaller.cacheFile for raw binary tools.
* **Schema validation**: All `devEngines` configuration validated through Effect Schema with `RuntimeEntry`/`PackageManagerEntry` literal name types.
* **Cache module**: Battle-tested cache key generation with V2 Twirp protocol for save/restore, typed cross-phase state transfer via ActionState.
* **Inputs via Effect Config API**: `Config.string`, `Config.boolean`, `Config.withDefault` backed by the GitHub Actions input ConfigProvider.
* **Build toolchain**: rsbuild via `@savvy-web/github-action-builder` 0.5.0. Clean ESM output, no eval("require"), no CJS chunks.
* **Testing**: 220 unit tests with Effect test layers imported from `/testing` subpath. No `vi.mock` needed. 86%+ branch coverage.
* **Multi-format input parsing**: `additional-lockfiles` and `additional-cache-paths` accept newlines, bullets, commas, or JSON arrays.
* **Platform support**: Full support for Ubuntu, macOS, and Windows runners with platform-aware PATH handling and tar extraction.

### Dependencies

- | [`358dce1`](https://github.com/savvy-web/silk-runtime-action/commit/358dce10a1486bad3b524257ea67b84daa360fc1) | Dependency | Type | Action | From | To |
  | :-- | :-- | :-- | :-- | :-- | --- |
  | @savvy-web/changesets | dependency | updated | ^0.4.2 | ^0.5.3 |  |
  | @savvy-web/commitlint | dependency | updated | ^0.4.0 | ^0.4.2 |  |
  | @savvy-web/github-action-builder | dependency | updated | ^0.2.1 | ^0.4.0 |  |
  | @savvy-web/lint-staged | dependency | updated | ^0.5.0 | ^0.6.1 |  |
  | @savvy-web/vitest | dependency | updated | ^0.2.0 | ^0.2.2 |  |

## 0.1.7

### Dependencies

- [`32ff0b0`](https://github.com/savvy-web/silk-runtime-action/commit/32ff0b0f977eeddad3aa0a3d262dccb2806f1eab) @savvy-web/changesets: ^0.1.1 → ^0.4.2
- @savvy-web/commitlint: ^0.3.3 → ^0.4.0
- @savvy-web/github-action-builder: ^0.1.4 → ^0.2.1
- @savvy-web/lint-staged: ^0.4.5 → ^0.5.0
- @savvy-web/vitest: ^0.1.0 → ^0.2.0

## 0.1.6

### Bug Fixes

- [`7f4fb75`](https://github.com/savvy-web/silk-runtime-action/commit/7f4fb753ce138a762c2c1511d74662fed2973051) Supports @savvy-web/vitest

## 0.1.5

### Patch Changes

- 33ff69f: ## Dependencies
  - @savvy-web/commitlint: ^0.3.1 → ^0.3.2

## 0.1.4

### Patch Changes

- d8b212c: Update dependencies:

  **Dependencies:**
  - @savvy-web/github-action-builder: ^0.1.1 → ^0.1.2
  - @savvy-web/lint-staged: ^0.3.1 → ^0.4.0

## 0.1.3

### Patch Changes

- 667b520: Update dependencies:

  **Dependencies:**
  - @savvy-web/commitlint: ^0.3.0 → ^0.3.1
  - @savvy-web/github-action-builder: ^0.1.0 → ^0.1.1

## 0.1.2

### Patch Changes

- f83278c: Fix pnpm setup hanging when `configDependencies` present in `pnpm-workspace.yaml`

  Run corepack and package manager setup commands from `os.tmpdir()` instead of the
  project directory to prevent pnpm from eagerly resolving `configDependencies` during
  setup, which can hang indefinitely on first CI run for each ref.

## 0.1.1

### Patch Changes

- 8c5570b: Switch to github-action-builder
