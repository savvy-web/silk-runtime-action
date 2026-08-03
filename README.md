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
      - uses: savvy-web/silk-runtime-action@v1
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
      "version": "10.20.0",
      "onFail": "error"
    }
  }
}
```

Both `devEngines.runtime` and `devEngines.packageManager` are required. `runtime` accepts a single object or a non-empty array. A top-level corepack `packageManager` pin is ignored — `devEngines` is the only source of truth.

### Version rules

Versions must be **absolute** (`"24.10.0"`), never ranges. Anything containing `^`, `~`, `>`, `<`, `=`, `*`, `x` or `X` is rejected before any install runs. `onFail` is optional on both entries; it is parsed for format compatibility but this action does not act on it — a failed install always fails the step.

### What gets installed

1. **Runtimes** — Node.js from `nodejs.org/dist`, Bun and Deno from their GitHub releases, unpacked into the runner tool cache.
2. **Package manager** — npm, pnpm or yarn provisioned at the pinned version and added to `PATH`. Bun and Deno are their own package managers, so naming either is a no-op.
3. **Dependencies** — installed with the reproducible flag when a lockfile is present.
4. **Biome** — installed when `biome.jsonc` or `biome.json` declares a version in its `$schema`, or when `biome-version` is set.
5. **Turbo remote cache** — an embedded cache server, or passthrough to Vercel, when `turbo.json` is detected.

## Inputs

All inputs are optional. Runtime and package manager versions are read exclusively from `devEngines`, so there are no version inputs.

| Input | Description | Default |
| ----- | ----------- | ------- |
| `biome-version` | Biome version to install (e.g. `2.3.14`). Auto-detects from the `biome.jsonc`/`biome.json` `$schema` field when empty. | `""` |
| `turbo-cache` | Turbo remote cache mode (`auto` \| `off`). `auto` starts an embedded cache server when `turbo.json` is present and no Vercel credentials are set. | `"auto"` |
| `turbo-cache-prefix` | Key prefix/namespace for embedded turbo cache artifacts. | `""` |
| `turbo-token` | Turbo remote cache token. With `turbo-team`, selects Vercel passthrough and disables the embedded server. | `""` |
| `turbo-team` | Turbo team slug. With `turbo-token`, selects Vercel passthrough and disables the embedded server. | `""` |
| `turbo-s3-bucket` | S3 bucket for the embedded turbo cache backend. Its presence selects the S3 backend. | `""` |
| `turbo-s3-region` | S3 region for the embedded turbo cache backend. | `""` |
| `turbo-s3-endpoint` | Custom S3 endpoint (R2/MinIO/Spaces). Leave empty for AWS S3. | `""` |
| `turbo-s3-access-key-id` | S3 access key ID for the embedded turbo cache backend. | `""` |
| `turbo-s3-secret-access-key` | S3 secret access key for the embedded turbo cache backend. | `""` |
| `turbo-s3-session-token` | S3 session token, for temporary credentials. | `""` |
| `turbo-s3-prefix` | Key prefix within the S3 bucket. | `""` |
| `install-deps` | Whether to install dependencies (`true` \| `false`). | `"true"` |
| `cache-bust` | String appended to the cache key to force a miss. `false` or empty disables it; any other value busts. **Testing only.** | `"false"` |
| `additional-lockfiles` | Extra lockfile glob patterns to fold into the cache key. One pattern per line. | `""` |
| `additional-cache-paths` | Extra paths to cache and restore. One glob pattern per line. | `""` |

## Outputs

| Output | Description |
| ------ | ----------- |
| `node-version` | The Node.js version that was installed, or empty |
| `node-enabled` | Whether Node.js was installed (`true` \| `false`) |
| `bun-version` | The Bun version that was installed, or empty |
| `bun-enabled` | Whether Bun was installed (`true` \| `false`) |
| `deno-version` | The Deno version that was installed, or empty |
| `deno-enabled` | Whether Deno was installed (`true` \| `false`) |
| `package-manager` | The package manager name (`npm` \| `pnpm` \| `yarn` \| `bun` \| `deno`) |
| `package-manager-version` | The package manager version |
| `biome-version` | The Biome version that was installed, or empty |
| `biome-enabled` | Whether Biome was installed (`true` \| `false`) |
| `turbo-enabled` | Whether `turbo.json` was detected (`true` \| `false`) |
| `turbo-cache-backend` | Active turbo cache backend (`github` \| `s3` \| `remote` \| `none`) |
| `turbo-cache-port` | Local port the embedded turbo cache server bound to, or empty when it did not start |
| `cache-hit` | Dependency cache status (`true` \| `partial` \| `false`) |
| `lockfiles` | Comma-separated list of detected lockfiles used for the cache key |
| `cache-paths` | Comma-separated list of paths that were cached and restored |

`biome-enabled` reflects a **successful install**, not detection. A Biome that was detected but could not be fetched degrades to a warning and reports `false`.

## Usage examples

### Basic Node.js project

```yaml
- uses: savvy-web/silk-runtime-action@v1
- run: pnpm test
```

### Multiple runtimes

```yaml
- uses: savvy-web/silk-runtime-action@v1

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
      "version": "10.20.0",
      "onFail": "error"
    }
  }
}
```

### Installing dependencies yourself

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    install-deps: false

- run: pnpm install --no-frozen-lockfile --prefer-offline
```

The runtimes, package manager and dependency cache are still set up — only the install command is skipped.

### Reading outputs

```yaml
- name: Set up runtime
  id: setup
  uses: savvy-web/silk-runtime-action@v1

- name: Show what was installed
  run: |
    echo "Node.js: ${{ steps.setup.outputs.node-version }}"
    # Node.js: <the devEngines node version, or empty>
    echo "Manager: ${{ steps.setup.outputs.package-manager }} ${{ steps.setup.outputs.package-manager-version }}"
    # Manager: <name and version from devEngines.packageManager>
    echo "Cache:   ${{ steps.setup.outputs.cache-hit }}"
    # Cache:   one of true, partial, false
```

### Turbo remote cache on S3

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    turbo-s3-bucket: my-turbo-cache
    turbo-s3-region: us-east-1
    turbo-s3-access-key-id: ${{ secrets.AWS_ACCESS_KEY_ID }}
    turbo-s3-secret-access-key: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
```

Point `turbo-s3-endpoint` at Cloudflare R2, MinIO or DigitalOcean Spaces to use an S3-compatible store instead of AWS.

### Turbo passthrough to Vercel

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    turbo-token: ${{ secrets.TURBO_TOKEN }}
    turbo-team: ${{ secrets.TURBO_TEAM }}
```

## Package managers

The package manager named in `devEngines.packageManager` is provisioned at exactly that version. If the pin carries an integrity hash — the `pnpm@10.20.0+sha512-…` form — the downloaded artifact is checked against it; a pin without one installs anyway and logs a warning. A manager already on the runner's `PATH` at the right version is reused rather than reinstalled.

| Manager | How it is provisioned | Install command |
| ------- | --------------------- | --------------- |
| `npm` | Downloaded at the pinned version into the tool cache, then added to `PATH` | `npm ci`, or `npm install` with no lockfile |
| `pnpm` | Downloaded at the pinned version into the tool cache, then added to `PATH` | `pnpm install --frozen-lockfile`, or `pnpm install` with no lockfile |
| `yarn` | Downloaded at the pinned version into the tool cache, then added to `PATH` | `yarn install --immutable`, or `yarn install --no-immutable` with no lockfile |
| `bun` | No-op — the Bun runtime install already put it on `PATH` | `bun install --frozen-lockfile`, or `bun install` with no lockfile |
| `deno` | No-op — the Deno runtime install already put it on `PATH` | None; Deno caches modules on demand, so the install step is skipped |

Yarn Classic (1.x) and Berry (2.x and later) are both supported. Corepack is not used, and is not required in the consuming repository.

## Dependency caching

Cache restore runs before every install, so a hit is what makes the installs after it cheap. The key is built from the runner platform and architecture, a digest of every installed tool version (runtimes, package manager and Biome), a digest of the branch name, and a digest of the matched lockfiles. Any of those changing produces a new key.

Which lockfiles feed the key depends on which package managers this run actually uses — a repository declaring pnpm but running only a Bun runtime keys on Bun's lockfiles, because pnpm never runs. Files under `node_modules`, `.git` and test-fixture directories are excluded. Add your own patterns with `additional-lockfiles`.

Two restore keys back up the primary one: the first drops the lockfile digest and matches an earlier cache for the same tool versions on this branch, the second drops the branch as well and reaches across branches. Either reports `partial` on the `cache-hit` output.

Cached paths cover each active manager's global store, the workspace directories it populates (`**/node_modules`, and yarn's PnP directories), and the tool-cache directory of every runtime and Biome version installed. Add more with `additional-cache-paths`. The resolved list is reported on the `cache-paths` output, and the key and matched lockfiles appear in the job summary.

### Turbo build cache

When `turbo.json` is detected, the action resolves one of four strategies, in order:

1. `turbo-cache: off`, or no `turbo.json` — nothing starts, and `turbo-cache-backend` reports `none`.
2. `turbo-token` **and** `turbo-team` — Turborepo talks straight to Vercel Remote Cache and the embedded server stays down. Reported as `remote`.
3. `turbo-s3-bucket` — an embedded remote cache server starts, backed by S3 or any S3-compatible store. Reported as `s3`.
4. Otherwise — an embedded remote cache server starts, backed by the GitHub Actions cache. Reported as `github`.

Passthrough wins over S3 when both are configured. The S3 rule probes the bucket alone, so credentials without a bucket fall through to the GitHub backend rather than starting a misconfigured S3 one. Supplying only one of `turbo-token`/`turbo-team` logs a warning and falls through to an embedded server.

Alongside whichever remote cache is active, Turbo's local artifact directory (`**/.turbo/cache`) is added to the dependency file cache as a fast local-restore layer. The other `.turbo` subdirectories are deliberately excluded — a restored stale run summary breaks "latest run is the current run" detection in tooling that parses `turbo --summarize`.

The embedded server is torn down in the action's post step. On the GitHub backend it captures `ACTIONS_RUNTIME_TOKEN` when it spawns, and that token is a short-lived JWT, so very long jobs can see late cache writes rejected with `401`. The S3 backend uses its own credentials and is unaffected.

## Job summary

The action writes a panel to the workflow's job summary listing the runtimes and package manager it set up, whether Biome was installed, the active Turbo cache backend and mode, the dependency cache hit status and the install outcome, with a collapsed section carrying the cache key and the matched lockfiles. Collapsed step groups also report their result inline, so the detected configuration, the Turbo backend and the cache hit are readable without expanding anything. Writing the summary is non-fatal — a failure logs a warning and the run continues.

## Troubleshooting

### `package.json not found` or `invalid devEngines`

Both `devEngines.runtime` and `devEngines.packageManager` must be present in the root `package.json`:

```json
{
  "devEngines": {
    "runtime": { "name": "node", "version": "24.10.0", "onFail": "error" },
    "packageManager": { "name": "pnpm", "version": "10.20.0", "onFail": "error" }
  }
}
```

### `Must be an absolute version, not a semver range`

Replace the range with the exact version you want — `24.10.0` rather than `^24.0.0`. The schema rejects `^`, `~`, `>`, `<`, `=`, `*`, `x` and `X`.

### Dependency installation fails

Turn the install off and run it yourself with whatever flags the repository needs:

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    install-deps: false

- run: pnpm install --no-frozen-lockfile
```

### Turbo is not using the cache you configured

Check the `turbo-cache-backend` output against the resolution order above. The most common surprise is a leftover `turbo-token`/`turbo-team` pair winning over the S3 inputs you just added.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing and contribution guidelines.

## License

[MIT](LICENSE)
