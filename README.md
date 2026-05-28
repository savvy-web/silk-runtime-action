# silk-runtime-action

[![License: MIT](https://img.shields.io/badge/License-MIT-4caf50.svg)](https://opensource.org/licenses/MIT)
[![GitHub Action](https://img.shields.io/badge/GitHub-Action-blue?logo=github)](https://github.com/savvy-web/pnpm-config-dependency-action)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-green?logo=node.js)](https://nodejs.org)

Automatically detect and set up JavaScript runtime environments in GitHub Actions from your `package.json` `devEngines` configuration. One action for Node.js, Bun, and Deno with intelligent package manager detection and dependency caching.

## Why This Action?

Setting up JavaScript environments in CI should be simple. This action:

- **Detects your environment** from `package.json` `devEngines` configuration
- **Installs exact versions** of runtimes and package managers
- **Caches dependencies** automatically for faster builds
- **Supports multiple runtimes** simultaneously (Node.js + Deno, Node.js + Bun)

**No configuration needed** -- just add the action and it figures everything out from your `package.json`.

## Quick Start

```yaml
name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: savvy-web/silk-runtime-action@v1
      - run: pnpm test
      - run: pnpm build
```

The action reads all configuration from your `package.json` `devEngines` field:

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

**Requirements:**

- Versions must be **exact** (e.g., `24.10.0`, not `^24.0.0`)
- `onFail` is recommended to be set to `"error"` for strict validation
- Supports single or multiple runtimes

### What Gets Installed

1. **Runtime(s)** -- Node.js, Bun, and/or Deno at specified versions
2. **Package Manager** -- pnpm, yarn, npm, bun, or deno at specified version
3. **Dependencies** -- Automatically installs with appropriate lockfile flags
4. **Caching** -- Sets up dependency caching optimized for your package manager

## Inputs

All inputs are optional. Runtime and package manager versions are read exclusively from `devEngines` in `package.json`.

| Input | Description | Default |
| ----- | ----------- | ------- |
| `biome-version` | Biome version to install (e.g., `2.3.14`). Auto-detects from `biome.jsonc`/`biome.json` `$schema` field if not provided. Leave empty to skip. | `""` |
| `turbo-token` | Turbo remote cache token (for Vercel Remote Cache) | `""` |
| `turbo-team` | Turbo team slug (for Vercel Remote Cache) | `""` |
| `install-deps` | Whether to install dependencies (`true` \| `false`) | `"true"` |
| `cache-bust` | Cache busting for testing -- `true` (auto-generate), `false` (normal), or custom string. **Testing only.** | `"false"` |
| `additional-lockfiles` | Additional lockfile patterns for cache key generation (multiline glob patterns) | `""` |
| `additional-cache-paths` | Additional paths to cache/restore (multiline glob patterns) | `""` |

## Outputs

| Output | Description |
| ------ | ----------- |
| `node-version` | Installed Node.js version or empty |
| `node-enabled` | Whether Node.js was installed (`true` \| `false`) |
| `bun-version` | Installed Bun version or empty |
| `bun-enabled` | Whether Bun was installed (`true` \| `false`) |
| `deno-version` | Installed Deno version or empty |
| `deno-enabled` | Whether Deno was installed (`true` \| `false`) |
| `package-manager` | Package manager name (`npm` \| `pnpm` \| `yarn` \| `bun` \| `deno`) |
| `package-manager-version` | Package manager version |
| `biome-version` | Installed Biome version or empty |
| `biome-enabled` | Whether Biome was installed (`true` \| `false`) |
| `turbo-enabled` | Whether Turbo configuration was detected (`true` \| `false`) |
| `cache-hit` | Cache status (`true` \| `partial` \| `false` \| `n/a`) |
| `lockfiles` | Comma-separated list of detected lockfiles |
| `cache-paths` | Comma-separated list of cached paths |

## Usage Examples

### Basic Node.js Project

```yaml
# Automatically detects Node.js version and pnpm from package.json
- uses: savvy-web/silk-runtime-action@v1
- run: pnpm test
```

### Multi-Runtime Project

```yaml
# Sets up both Node.js and Deno from package.json devEngines
- uses: savvy-web/silk-runtime-action@v1

- name: Test with Node.js
  run: npm test

- name: Test with Deno
  run: deno test
```

### Custom Dependency Installation

```yaml
# Skip automatic installation
- uses: savvy-web/silk-runtime-action@v1
  with:
    install-deps: false

# Install with custom flags
- run: pnpm install --no-frozen-lockfile --prefer-offline
```

### Using Outputs

```yaml
- name: Setup runtime
  id: setup
  uses: savvy-web/silk-runtime-action@v1

- name: Display environment
  run: |
    echo "Node.js: ${{ steps.setup.outputs.node-version }}"
    echo "Package Manager: ${{ steps.setup.outputs.package-manager }} v${{ steps.setup.outputs.package-manager-version }}"
    echo "Cache Hit: ${{ steps.setup.outputs.cache-hit }}"
```

### With Biome and Turbo

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    turbo-token: ${{ secrets.TURBO_TOKEN }}
    turbo-team: ${{ secrets.TURBO_TEAM }}
# Biome auto-detected from biome.jsonc $schema field
```

## Supported Package Managers

### pnpm

- Installed via corepack with exact version
- Install command: `pnpm install --frozen-lockfile` (or `pnpm install` without lockfile)

### Yarn

- Installed via corepack with exact version
- Supports Yarn Classic (1.x) and Berry (2.x+)
- Install command: `yarn install --immutable` (or `yarn install --no-immutable` without lockfile)

### npm

- Installed via corepack with exact version
- Install command: `npm ci` (or `npm install` without lockfile)

### bun

- Downloaded from official releases
- Install command: `bun install --frozen-lockfile` (or `bun install` without
  lockfile)

### deno

- Downloaded from official releases
- Install command: `deno install` (respects `deno.lock` automatically)

## Dependency Caching

The action automatically caches dependencies based on your package manager and lockfile:

- **Cache key** includes lockfile hash for invalidation on changes
- **Platform-specific** cache paths for each package manager
- **Restore keys** for partial cache hits
- **Automatic setup** -- no configuration needed

Cache hit status is available in the `cache-hit` output.

## Troubleshooting

### Missing devEngines Configuration

**Error:** `devEngines.runtime or devEngines.packageManager not found`

**Solution:** Add `devEngines` to your `package.json`:

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

### Version Must Be Exact

**Error:** `Must be an absolute version, not a semver range`

**Solution:** Use exact versions (e.g., `24.10.0`) instead of ranges (e.g., `^24.0.0`).

### Dependency Installation Fails

**Solution:** Skip automatic installation and install manually:

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    install-deps: false

- run: pnpm install --no-frozen-lockfile
```

## Multiple Runtimes

You can set up multiple runtimes simultaneously by specifying an array in `devEngines.runtime`:

```json
{
  "devEngines": {
    "runtime": [
      {
        "name": "node",
        "version": "24.10.0",
        "onFail": "error"
      },
      {
        "name": "deno",
        "version": "2.5.6",
        "onFail": "error"
      }
    ],
    "packageManager": {
      "name": "pnpm",
      "version": "10.20.0",
      "onFail": "error"
    }
  }
}
```

The action will install all specified runtimes and make them available in your workflow.

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing and contribution guidelines.

## License

[MIT](LICENSE)
