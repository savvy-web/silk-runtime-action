# @savvy-web/workflow-runtime-action

## 0.2.3

### Dependencies

* | [`59c7dcb`](https://github.com/savvy-web/workflow-runtime-action/commit/59c7dcb4236f5b8418dd886e95eb66ac940bc943) | Dependency    | Type    | Action   | From    | To |
  | :---------------------------------------------------------------------------------------------------------------- | :------------ | :------ | :------- | :------ | -- |
  | @savvy-web/github-action-effects                                                                                  | dependency    | updated | ^0.11.12 | ^1.2.0  |    |
  | @savvy-web/changesets                                                                                             | devDependency | updated | ^0.8.0   | ^0.10.0 |    |
  | @savvy-web/commitlint                                                                                             | devDependency | updated | ^0.6.0   | ^0.9.0  |    |
  | @savvy-web/github-action-builder                                                                                  | devDependency | updated | ^0.6.3   | ^0.7.1  |    |
  | @savvy-web/lint-staged                                                                                            | devDependency | updated | ^1.0.0   | ^1.0.1  |    |
  | @savvy-web/vitest                                                                                                 | devDependency | updated | ^1.3.1   | ^1.3.2  |    |

## 0.2.2

### Bug Fixes

* [`64f2859`](https://github.com/savvy-web/workflow-runtime-action/commit/64f285956b82a93639139358dc843acd1db65c89) Retry `corepack enable` after removing stale shims when it fails with EEXIST. This handles the case where a cached Node installation contains symlinks from a previous corepack setup, causing `corepack enable` to fail when trying to create them again.

## 0.2.1

### Bug Fixes

* [`d16d202`](https://github.com/savvy-web/workflow-runtime-action/commit/d16d202c9d0025de9797662008e1b73e8c695616) Fix Node.js not being available on PATH after installation. The Node tar archive extracts to a nested directory (e.g., `node-v24.11.0-linux-x64/`), so the `bin/` path added to PATH didn't contain the actual binary. Now passes `--strip 1` to tar during extraction to flatten the archive root, matching the pattern used by `actions/setup-node`. Also adds `streaming: true` to dependency install for visible error output on failure, and temporary runtime diagnostics logging.

## 0.2.0

### Breaking Changes

* [`354877c`](https://github.com/savvy-web/workflow-runtime-action/commit/354877c6a163c476d7153b66f6b434bf2ae0a9d1) Remove explicit version inputs (`node-version`, `bun-version`, `deno-version`, `package-manager`, `package-manager-version`). All configuration now comes exclusively from `package.json` `devEngines` fields.
* Remove `pre` action hook (collapsed into main).
* Require `devEngines.packageManager` and `devEngines.runtime` in `package.json`.

### Features

* [`354877c`](https://github.com/savvy-web/workflow-runtime-action/commit/354877c6a163c476d7153b66f6b434bf2ae0a9d1) Rewrite action internals from imperative TypeScript to Effect-based programs using `@savvy-web/github-action-effects` 0.11.x.

- **Zero `@actions/*` dependencies**: The effects library implements the GitHub Actions runtime protocol natively (V2 Twirp caching, native process execution, workflow commands). No CJS/ESM interop issues, no bundler hacks.
- **Effect architecture**: Two entry points (main.ts, post.ts) as Effect pipelines with typed errors, dependency injection via layers, and schema-validated configuration.
- **RuntimeInstaller service**: Shared service with per-runtime descriptor layers (Node.js, Bun, Deno) using ToolInstaller primitives (download, extract, cache, addPath).
- **Biome binary install**: Direct download via ToolInstaller.cacheFile for raw binary tools.
- **Schema validation**: All `devEngines` configuration validated through Effect Schema with `RuntimeEntry`/`PackageManagerEntry` literal name types.
- **Cache module**: Battle-tested cache key generation with V2 Twirp protocol for save/restore, typed cross-phase state transfer via ActionState.
- **Inputs via Effect Config API**: `Config.string`, `Config.boolean`, `Config.withDefault` backed by the GitHub Actions input ConfigProvider.
- **Build toolchain**: rsbuild via `@savvy-web/github-action-builder` 0.5.0. Clean ESM output, no eval("require"), no CJS chunks.
- **Testing**: 220 unit tests with Effect test layers imported from `/testing` subpath. No `vi.mock` needed. 86%+ branch coverage.
- **Multi-format input parsing**: `additional-lockfiles` and `additional-cache-paths` accept newlines, bullets, commas, or JSON arrays.
- **Platform support**: Full support for Ubuntu, macOS, and Windows runners with platform-aware PATH handling and tar extraction.

### Dependencies

* | [`358dce1`](https://github.com/savvy-web/workflow-runtime-action/commit/358dce10a1486bad3b524257ea67b84daa360fc1) | Dependency | Type    | Action | From   | To |
  | :---------------------------------------------------------------------------------------------------------------- | :--------- | :------ | :----- | :----- | -- |
  | @savvy-web/changesets                                                                                             | dependency | updated | ^0.4.2 | ^0.5.3 |    |
  | @savvy-web/commitlint                                                                                             | dependency | updated | ^0.4.0 | ^0.4.2 |    |
  | @savvy-web/github-action-builder                                                                                  | dependency | updated | ^0.2.1 | ^0.4.0 |    |
  | @savvy-web/lint-staged                                                                                            | dependency | updated | ^0.5.0 | ^0.6.1 |    |
  | @savvy-web/vitest                                                                                                 | dependency | updated | ^0.2.0 | ^0.2.2 |    |

## 0.1.7

### Dependencies

* [`32ff0b0`](https://github.com/savvy-web/workflow-runtime-action/commit/32ff0b0f977eeddad3aa0a3d262dccb2806f1eab) @savvy-web/changesets: ^0.1.1 → ^0.4.2
* @savvy-web/commitlint: ^0.3.3 → ^0.4.0
* @savvy-web/github-action-builder: ^0.1.4 → ^0.2.1
* @savvy-web/lint-staged: ^0.4.5 → ^0.5.0
* @savvy-web/vitest: ^0.1.0 → ^0.2.0

## 0.1.6

### Bug Fixes

* [`7f4fb75`](https://github.com/savvy-web/workflow-runtime-action/commit/7f4fb753ce138a762c2c1511d74662fed2973051) Supports @savvy-web/vitest

## 0.1.5

### Patch Changes

* 33ff69f: ## Dependencies
  * @savvy-web/commitlint: ^0.3.1 → ^0.3.2

## 0.1.4

### Patch Changes

* d8b212c: Update dependencies:

  **Dependencies:**

  * @savvy-web/github-action-builder: ^0.1.1 → ^0.1.2
  * @savvy-web/lint-staged: ^0.3.1 → ^0.4.0

## 0.1.3

### Patch Changes

* 667b520: Update dependencies:

  **Dependencies:**

  * @savvy-web/commitlint: ^0.3.0 → ^0.3.1
  * @savvy-web/github-action-builder: ^0.1.0 → ^0.1.1

## 0.1.2

### Patch Changes

* f83278c: Fix pnpm setup hanging when `configDependencies` present in `pnpm-workspace.yaml`

  Run corepack and package manager setup commands from `os.tmpdir()` instead of the
  project directory to prevent pnpm from eagerly resolving `configDependencies` during
  setup, which can hang indefinitely on first CI run for each ref.

## 0.1.1

### Patch Changes

* 8c5570b: Switch to github-action-builder
