# silk-runtime-action

[![License: MIT](https://img.shields.io/badge/License-MIT-4caf50.svg)](https://opensource.org/licenses/MIT)
[![Node.js >=24.11.0](https://img.shields.io/badge/Node.js-%3E%3D24.11.0-5fa04e.svg)](https://nodejs.org/)
[![GitHub Action](https://img.shields.io/badge/GitHub-Action-blue?logo=github)](https://github.com/savvy-web/silk-runtime-action)

Set up JavaScript runtimes in GitHub Actions from the `devEngines` field of your `package.json`. One action installs Node.js, Bun and/or Deno, provisions the pinned package manager, restores a dependency cache, and optionally installs Biome and wires up a Turborepo remote cache.

## Why this action

Every runtime version in CI is a second place to edit when you bump a version. This action reads `devEngines` — the field your local toolchain already reads — so the workflow never names a version at all. Versions must be absolute, so two runs of the same commit install the same bytes. Multiple runtimes install side by side, which is what a repository testing on both Node.js and Deno needs.

## Quick start

```yaml
name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: savvy-web/silk-runtime-action@v2
      - run: pnpm test
      - run: pnpm build
```

Everything comes from `package.json`:

```json
{
  "devEngines": {
    "runtime": {
      "name": "node",
      "version": "24.10.0",
      "onFail": "error"
    },
    "packageManager": {
      "name": "pnpm",
      "version": "12.20.0",
      "onFail": "error"
    }
  }
}
```

Both `devEngines.runtime` and `devEngines.packageManager` are required. `runtime` accepts a single object or a non-empty array. A top-level corepack `packageManager` pin is ignored — `devEngines` is the only source of truth.

### Version rules

Versions must be **absolute** (`"24.10.0"`), never ranges. Anything containing `^`, `~`, `>`, `<`, `=`, `*`, `x` or `X` is rejected before any install runs. `onFail` is optional on both entries and may be `warn`, `error` or `ignore`, or pnpm's `download` when the package manager is pnpm; it is validated but this action does not act on it — the pinned versions are always installed up front, and a failed install always fails the step.

### What gets installed

1. **Runtimes** — Node.js from `nodejs.org/dist`, Bun and Deno from their GitHub releases, unpacked into the runner tool cache.
2. **Package manager** — npm or pnpm (12 or later) provisioned at the pinned version and added to `PATH`. Bun and Deno are their own package managers, so naming either is a no-op.
3. **Dependencies** — installed with the reproducible flag when a lockfile is present.
4. **Biome** — installed when `biome.jsonc` or `biome.json` declares a version in its `$schema`, or when `biome-version` is set.
5. **Turbo remote cache** — a hosted cache the job signs in to, passthrough to Vercel, or an embedded cache server, when `turbo.json` is detected.

## Inputs

All inputs are optional. Runtime and package manager versions are read exclusively from `devEngines`, so there are no version inputs.

| Input | Description | Default |
| ----- | ----------- | ------- |
| `biome-version` | Biome version to install (e.g. `2.3.14`). Auto-detects from the `biome.jsonc`/`biome.json` `$schema` field when empty. | `""` |
| `turbo-cache` | Turbo remote cache mode (`auto` \| `off`). `auto` uses `turbo-api` when it is set, else Vercel when both credentials are set, else an embedded cache server, whenever `turbo.json` is present. `off` disables all of it. | `"auto"` |
| `turbo-cache-prefix` | Key prefix/namespace for embedded turbo cache artifacts. | `""` |
| `turbo-token` | Turbo remote cache token. With `turbo-team`, selects Vercel passthrough and disables the embedded server. | `""` |
| `turbo-team` | Turbo team slug. With `turbo-token`, selects Vercel passthrough and disables the embedded server. | `""` |
| `turbo-api` | Base URL of a hosted Turborepo remote cache that signs the job in with its GitHub OIDC token. Must be `https`, and the job needs `id-token: write`. When sign-in is not possible the embedded server is used instead. Wins over `turbo-token`/`turbo-team`. | `""` |
| `install-deps` | Whether to install dependencies (`true` \| `false`). | `"true"` |
| `ignore-scripts` | Skip dependency lifecycle scripts during the install (`true` \| `false`). Passes `--ignore-scripts` to npm/pnpm/bun. No effect when `install-deps` is `false`, or for deno. | `"false"` |
| `bats` | Provision the BATS toolchain — bats-core, bats-support, bats-assert, bats-file, bats-mock (`auto` \| `true` \| `false`). `auto` installs when a `*.bats` file or a `vitest-bats` dependency is present. | `"auto"` |
| `kcov` | Provision kcov for shell-script coverage (`auto` \| `true` \| `false`). `auto` follows the bats decision. Built from source and cached; never installed when bats is off. | `"auto"` |
| `cache-bust` | String appended to the cache key to force a miss. `false` or empty disables it; any other value busts. **Testing only.** | `"false"` |
| `additional-lockfiles` | Extra lockfile glob patterns to fold into the cache key. One pattern per line. | `""` |
| `additional-cache-paths` | Extra paths to cache and restore. One glob pattern per line. | `""` |

**Windows is not supported for either tool.** `kcov` is refused outright — it has no
Windows build — so `kcov-enabled` is always `false` there. `bats` is not blocked, because
bats-core is a bash program that may well work under Git Bash, but its install path here
(`$HOME/.local/share`, `BATS_LIB_PATH`) has never been exercised on Windows and the fixture
matrix excludes it: treat a `bats-enabled=true` on a Windows runner as unverified. Both
tools are installed and validated on Linux and macOS.

## Outputs

| Output | Description |
| ------ | ----------- |
| `node-version` | The Node.js version that was installed, or empty |
| `node-enabled` | Whether Node.js was installed (`true` \| `false`) |
| `bun-version` | The Bun version that was installed, or empty |
| `bun-enabled` | Whether Bun was installed (`true` \| `false`) |
| `deno-version` | The Deno version that was installed, or empty |
| `deno-enabled` | Whether Deno was installed (`true` \| `false`) |
| `package-manager` | The package manager name (`npm` \| `pnpm` \| `bun` \| `deno`) |
| `package-manager-version` | The package manager version |
| `biome-version` | The Biome version that was installed, or empty |
| `biome-enabled` | Whether Biome was installed (`true` \| `false`) |
| `bats-enabled` | Whether the BATS toolchain was installed (`true` \| `false`) |
| `bats-version` | The bats-core version that was installed, or empty |
| `bats-lib-path` | The `BATS_LIB_PATH` value that was exported, or empty when bats was not installed |
| `kcov-enabled` | Whether kcov was installed (`true` \| `false`) |
| `kcov-version` | The kcov version that was installed, or empty |
| `kcov-cache-hit` | Whether kcov was restored from the Actions cache rather than built (`true` \| `false`) |
| `turbo-enabled` | Whether `turbo.json` was detected (`true` \| `false`) |
| `turbo-cache-backend` | Active turbo cache backend: `github` (embedded server on the Actions cache) \| `hosted` (signed in to `turbo-api`) \| `remote` (Vercel passthrough) \| `none` |
| `turbo-cache-port` | Local port the embedded turbo cache server bound to, or empty when it did not start |
| `cache-hit` | Workspace cache status (`true` \| `partial` \| `false`) |
| `store-cache-hit` | Package-manager store cache status (`true` \| `partial` \| `false`). Keyed independently of `cache-hit` |
| `lockfiles` | Comma-separated list of detected lockfiles used for the cache key |
| `cache-paths` | Comma-separated list of paths that were cached and restored, across both entries |

`biome-enabled` reflects a **successful install**, not detection. A Biome that was detected but could not be fetched degrades to a warning and reports `false`.

## Usage examples

### Basic Node.js project

```yaml
- uses: savvy-web/silk-runtime-action@v2
- run: pnpm test
```

### Multiple runtimes

```yaml
- uses: savvy-web/silk-runtime-action@v2

- name: Test on Node.js
  run: pnpm test

- name: Test on Deno
  run: deno test
```

Declare them as an array, and the action installs each one and puts it on `PATH`:

```json
{
  "devEngines": {
    "runtime": [
      { "name": "node", "version": "24.10.0", "onFail": "error" },
      { "name": "deno", "version": "2.5.6", "onFail": "error" }
    ],
    "packageManager": {
      "name": "pnpm",
      "version": "12.20.0",
      "onFail": "error"
    }
  }
}
```

### Installing dependencies yourself

```yaml
- uses: savvy-web/silk-runtime-action@v2
  with:
    install-deps: false

- run: pnpm install --no-frozen-lockfile --prefer-offline
```

The runtimes, package manager and dependency cache are still set up — only the install command is skipped.

### Reading outputs

```yaml
- name: Set up runtime
  id: setup
  uses: savvy-web/silk-runtime-action@v2

- name: Show what was installed
  run: |
    echo "Node.js: ${{ steps.setup.outputs.node-version }}"
    # Node.js: <the devEngines node version, or empty>
    echo "Manager: ${{ steps.setup.outputs.package-manager }} ${{ steps.setup.outputs.package-manager-version }}"
    # Manager: <name and version from devEngines.packageManager>
    echo "Cache:   ${{ steps.setup.outputs.cache-hit }}"
    # Cache:   one of true, partial, false
```

### Turbo remote cache on a hosted service

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v7
      - uses: savvy-web/silk-runtime-action@v2
        with:
          turbo-api: https://cache.example.com
```

`turbo-api` names a Turborepo remote cache that accepts GitHub's OIDC tokens. The action asks the runner for a token whose audience is the URL's origin, sends it to `POST <turbo-api>/auth/github`, and exports the cache token it gets back as a masked `TURBO_TOKEN`, with `TURBO_API` set to the service and `TURBO_TEAM` to `silk`. No secret is stored anywhere: the job's identity is the credential.

The job needs `id-token: write`. Without it, or when the service refuses the token, answers something else, cannot be reached or takes longer than 10 seconds, the action logs one warning naming the reason and starts the embedded cache server instead. Sign-in never fails a job. On the `pull_request` event, a pull request from a fork gets no OIDC token from GitHub, so it always takes the fallback. If the sign-in succeeds and the runner then refuses the write to `GITHUB_ENV`, the run continues with no remote cache, as it does when the embedded server cannot export its own variables.

The URL must be `https`. Grant `id-token: write` only to jobs that build code you trust: the permission lets a job mint a token for any audience, not only this one. The case to watch is `pull_request_target`, which runs with the base repository's permissions: a job there that checks out and builds a fork's code would hand that code a token minter, so leave the grant off it and pass `turbo-cache: off`.

### Turbo passthrough to Vercel

```yaml
- uses: savvy-web/silk-runtime-action@v2
  with:
    turbo-token: ${{ secrets.TURBO_TOKEN }}
    turbo-team: ${{ secrets.TURBO_TEAM }}
```

## Package managers

The package manager named in `devEngines.packageManager` is provisioned at exactly that version. If the pin carries an integrity hash — the `pnpm@12.20.0+sha512-…` form — the downloaded artifact is checked against it; a pin without one installs anyway and logs a warning. A manager already on the runner's `PATH` at the right version is reused rather than reinstalled.

| Manager | How it is provisioned | Install command |
| ------- | --------------------- | --------------- |
| `npm` | Downloaded at the pinned version into the tool cache, then added to `PATH` | `npm ci`, or `npm install` with no lockfile |
| `pnpm` | Downloaded at the pinned version (12 or later) into the tool cache, with the host's native binary, then added to `PATH` | `pnpm install --frozen-lockfile`, or `pnpm install` with no lockfile |
| `bun` | No-op — the Bun runtime install already put it on `PATH` | `bun install --frozen-lockfile`, or `bun install` with no lockfile |
| `deno` | No-op — the Deno runtime install already put it on `PATH` | None; Deno caches modules on demand, so the install step is skipped |

pnpm must be 12 or later: earlier releases ship no native binary and are refused when the action provisions them. Yarn is not supported; a `yarn` pin fails `devEngines` validation before anything installs. Corepack is not used, and is not required in the consuming repository.

## Dependency caching

The run keeps **two** cache entries, because the things they hold go stale for different reasons.

### The workspace archive

This is what a lockfile change invalidates: the `node_modules` each workspace package was linked into, the tool-cache directory of every runtime and Biome version installed, and turbo's local artifact cache. Add more with `additional-cache-paths`.

The key is the runner platform and architecture, a digest of every installed tool version (runtimes, package manager and Biome), a digest of what the install is going to do (`install-deps` and `ignore-scripts`), a digest of the branch name, and a digest of the matched lockfiles. Any of those changing produces a new key. Two restore keys back it up: the first drops the lockfile digest and matches an earlier cache for the same tool versions on this branch, the second drops the branch as well and reaches across branches. Either reports `partial` on the `cache-hit` output.

A partial restore is saved again under the run's own key when the job ends, with one exception: when the entry that matched differs only in its branch digest — same tool versions, same install policy, same lockfile digest — the save is skipped, because the install had nothing to add to it. A branch whose lockfile matches its base branch's therefore keeps restoring the base branch's entry and reports `partial` on every run, without archiving a copy of its own. Turbo's local artifact cache and anything named in `additional-cache-paths` travel with that entry, so on such a branch they stay at the base branch's snapshot.

The `node_modules` directories come from the workspace's own membership, so only the packages your manager actually links are archived — not every `node_modules` that happens to exist under the checkout.

### The package-manager store

The global download cache — pnpm's store, npm's `_cacache`, bun's cache — is archived separately, and reports on the `store-cache-hit` output.

Its key holds only the platform, the architecture, the manager and its version, and the lockfile digest. There is no branch in it and no runtime version, because a store is content-addressable and append-only: another branch's store is as good as yours, and a package tarball does not change because Node did. Its one restore key drops the lockfile digest, which is what lets the entry top up — a changed lockfile restores the previous store, the install adds what is new, and the union is archived under the new key.

Splitting the two is what keeps a branch cut, or a Node bump, from throwing away a download it did not need to.

### Lockfiles

Which lockfiles feed the key depends on which package managers this run actually uses — a repository declaring pnpm but running only a Bun runtime keys on Bun's lockfiles, because pnpm never runs.

Every built-in lockfile name is matched **at the workspace root only**. All five managers write one lockfile at the root, and a workspace package's dependency change reaches the key through that file rather than beside it, so a deeper match is never a lockfile an install reads — what it reliably is instead is a test fixture. Add your own patterns, globs included, with `additional-lockfiles`; those still skip `node_modules`, `.git` and test-fixture directories.

The resolved list is reported on the `lockfiles` output, both archives' paths on `cache-paths`, and the key and matched lockfiles appear in the job summary.

### Turbo build cache

When `turbo.json` is detected, the action resolves one of four strategies, in order:

1. `turbo-cache: off`, or no `turbo.json` — nothing starts, no token is requested, and `turbo-cache-backend` reports `none`.
2. `turbo-api` — the job signs in to that service with its GitHub OIDC token and Turborepo talks to it directly. Reported as `hosted`. When sign-in is not possible, the action warns and continues at rule 4.
3. `turbo-token` **and** `turbo-team` — Turborepo talks straight to Vercel Remote Cache and the embedded server stays down. Reported as `remote`.
4. Otherwise — an embedded remote cache server starts, backed by the GitHub Actions cache. Reported as `github`.

`off` wins over everything, so a workflow can switch the cache off for one job whatever else it passes. `turbo-api` wins over Vercel credentials when both are configured. Without `turbo-api`, supplying only one of `turbo-token`/`turbo-team` logs a warning and falls through to the embedded server.

Alongside whichever remote cache is active, each workspace member's local Turbo artifact directory (`.turbo/cache`, `packages/a/.turbo/cache`, …) is added to the dependency file cache as a fast local-restore layer. The other `.turbo` subdirectories are deliberately excluded — a restored stale run summary breaks "latest run is the current run" detection in tooling that parses `turbo --summarize`.

The embedded server is torn down in the action's post step. It captures `ACTIONS_RUNTIME_TOKEN` when it spawns, and that token is a short-lived JWT, so very long jobs can see late cache writes rejected with `401`. A hosted cache has no server to tear down; its token carries the expiry the service gave it.

## Job summary

The action writes a panel to the workflow's job summary listing the runtimes and package manager it set up, whether Biome was installed, the active Turbo cache backend and mode, the dependency cache hit status and the install outcome, with a collapsed section carrying the cache key and the matched lockfiles. Collapsed step groups also report their result inline, so the detected configuration, the Turbo backend and the cache hit are readable without expanding anything. Writing the summary is non-fatal — a failure logs a warning and the run continues.

When the embedded Turbo cache server ran, the post step adds a `Turbo remote cache activity` entry to the log. Its one-line heading is the totals — for example `✓ Turbo remote cache (github, port 41230): 34 hits, 1 miss, 1 upload, 0 errors · 3ms` — and expanding it shows the server's own log: one line per artifact request with the task hash, the HTTP status, the outcome, the artifact size and the time taken, plus any backend failure the server reported. A server that failed to start leaves its reason there too. The main step also says when the cache was started ahead of the dependency install, and the install names the `TURBO_*` variables it was handed (names only, never values).

## Troubleshooting

### `package.json not found` or `invalid devEngines`

Both `devEngines.runtime` and `devEngines.packageManager` must be present in the root `package.json`:

```json
{
  "devEngines": {
    "runtime": { "name": "node", "version": "24.10.0", "onFail": "error" },
    "packageManager": { "name": "pnpm", "version": "12.20.0", "onFail": "error" }
  }
}
```

### `Must be an absolute version, not a semver range`

Replace the range with the exact version you want — `24.10.0` rather than `^24.0.0`. The schema rejects `^`, `~`, `>`, `<`, `=`, `*`, `x` and `X`.

### Dependency installation fails

Turn the install off and run it yourself with whatever flags the repository needs:

```yaml
- uses: savvy-web/silk-runtime-action@v2
  with:
    install-deps: false

- run: pnpm install --no-frozen-lockfile
```

### Turbo is not using the cache you configured

Check the `turbo-cache-backend` output against the resolution order above. With `turbo-api` set, `github` instead of `hosted` means sign-in did not happen: the step's warning names why, and `oidc: unavailable` is a job without `id-token: write`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing and contribution guidelines.

## License

[MIT](LICENSE)
