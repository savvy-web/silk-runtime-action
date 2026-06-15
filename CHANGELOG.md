# @savvy-web/silk-runtime-action

## 1.0.5

### Bug Fixes

* [`137939d`](https://github.com/savvy-web/silk-runtime-action/commit/137939d442ab1e7a44ab3f8919efa22d95a19aa2) The action no longer crashes on Windows runners. The committed bundle had a
  build-machine absolute path frozen into `@azure/storage-common`'s
  `createRequire(import.meta.url)` call (reached via the cache service's
  `@azure/storage-blob` dependency). That driveless POSIX `file://` path was
  accepted on macOS/Linux but rejected by `createRequire` on Windows, throwing at
  module load. Rebuilt with a bundler that keeps `import.meta.url` as a runtime
  expression, so the path resolves correctly on every platform.

### Dependencies

* | [`137939d`](https://github.com/savvy-web/silk-runtime-action/commit/137939d442ab1e7a44ab3f8919efa22d95a19aa2) | Dependency    | Type    | Action   | From     | To |
  | :------------------------------------------------------------------------------------------------------------ | :------------ | :------ | :------- | :------- | -- |
  | @effect/cluster                                                                                               | dependency    | updated | ^0.58.2  | ^0.59.0  |    |
  | @effect/platform-node                                                                                         | dependency    | updated | ^0.106.0 | ^0.107.0 |    |
  | effect                                                                                                        | dependency    | updated | ^3.21.2  | ^3.21.3  |    |
  | @savvy-web/github-action-builder                                                                              | devDependency | updated | ^0.7.8   | ^0.7.10  |    |
  | @savvy-web/silk                                                                                               | devDependency | updated | ^1.0.0   | ^1.1.0   |    |

## 1.0.4

### Other

* [`ae0b23f`](https://github.com/savvy-web/silk-runtime-action/commit/ae0b23fa7a7afe48eacc05d6dd2111c4507edcac) Upgrade to silk-release-action v2.

## 1.0.3

### Other

* [`334253f`](https://github.com/savvy-web/silk-runtime-action/commit/334253f25b51cfa570a85edb015d36fcfe13b9d3) Upgrade to `@savvy-web/silk` dependency system.

## 1.0.2

### Dependencies

* | [`58cf772`](https://github.com/savvy-web/silk-runtime-action/commit/58cf772632b064565b04750667af924f5106c307) | Dependency    | Type    | Action | From   | To |
  | :------------------------------------------------------------------------------------------------------------ | :------------ | :------ | :----- | :----- | -- |
  | @savvy-web/github-action-effects                                                                              | dependency    | updated | ^2.0.1 | ^2.0.2 |    |
  | @savvy-web/github-action-builder                                                                              | devDependency | updated | ^0.7.1 | ^0.7.2 |    |
  | @savvy-web/lint-staged                                                                                        | devDependency | updated | ^1.2.0 | ^1.2.1 |    |

## 1.0.1

### Dependencies

* | [`202a7f7`](https://github.com/savvy-web/silk-runtime-action/commit/202a7f72029d0b3188a5ad84869340f88348d28d) | Dependency    | Type    | Action | From    | To |
  | :------------------------------------------------------------------------------------------------------------ | :------------ | :------ | :----- | :------ | -- |
  | @savvy-web/github-action-effects                                                                              | dependency    | updated | ^2.0.0 | ^2.0.1  |    |
  | @savvy-web/commitlint                                                                                         | devDependency | updated | ^0.9.1 | ^0.10.0 |    |
  | @savvy-web/lint-staged                                                                                        | devDependency | updated | ^1.1.0 | ^1.2.0  |    |

## 1.0.0

### Breaking Changes

* [`b585e33`](https://github.com/savvy-web/silk-runtime-action/commit/b585e331d11810da11b4bc2900b412d2ee436ef5) ### `additional-lockfiles` accepts only newline-separated values

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

* [`b585e33`](https://github.com/savvy-web/silk-runtime-action/commit/b585e331d11810da11b4bc2900b412d2ee436ef5) ### v2 Library Standardization

Migrates the action's internals to the v2 conventions provided by `@savvy-web/github-action-effects`, aligning service structure, logging, input handling, and caching with the library's current APIs.

The action's `action.yml` inputs and outputs are unchanged with two exceptions noted below.

### Refactoring

* [`b585e33`](https://github.com/savvy-web/silk-runtime-action/commit/b585e331d11810da11b4bc2900b412d2ee436ef5) Comprehensive internal modernization targeting the v2 library conventions:

- Source reorganized into a canonical layout: `services/`, `errors/`, `schemas/`, `layers/`, `state.ts`
- `main.ts` split into a thin entry point, `program.ts`, and `layers/app.ts`
- Errors migrated to `Schema.TaggedError` with `.message` getters
- `RuntimeInstaller` converted to a `Context.Tag` class
- Logging replaced with `Step.groupStep` / `Step.success` (quiet on success, verbose on failure)
- `src/emoji.ts` removed; log formatting uses `Step.success` and plain strings
- Inputs use `ActionInput.multiline` and `ActionInput.boolean` from the library
- `fast-glob` direct dependency removed; replaced by the library `Glob` service
- `post.ts` reads typed `CacheState` and is wrapped in `Effect.catchAll` + `Effect.catchAllDefect` so post-action failures never fail the workflow

### Tests

* [`b585e33`](https://github.com/savvy-web/silk-runtime-action/commit/b585e331d11810da11b4bc2900b412d2ee436ef5) Test suite migrated to library `<Service>Test` test layers from `@savvy-web/github-action-effects/testing`
* Tests relocated alongside source files under the canonical `src/` layout

### Cache keys will invalidate on first deploy

The cache-key hash algorithm changed from a local `fast-glob` + SHA-256 implementation to the library `Glob.hashFiles` hash-of-hashes. Existing CI caches will miss on the first run after upgrading to this version. Subsequent runs populate and hit the new hash format normally. No action is required — caches rebuild automatically.

## 0.2.2

### Bug Fixes

* [`64f2859`](https://github.com/savvy-web/silk-runtime-action/commit/64f285956b82a93639139358dc843acd1db65c89) Retry `corepack enable` after removing stale shims when it fails with EEXIST. This handles the case where a cached Node installation contains symlinks from a previous corepack setup, causing `corepack enable` to fail when trying to create them again.

## 0.2.1

### Bug Fixes

* [`d16d202`](https://github.com/savvy-web/silk-runtime-action/commit/d16d202c9d0025de9797662008e1b73e8c695616) Fix Node.js not being available on PATH after installation. The Node tar archive extracts to a nested directory (e.g., `node-v24.11.0-linux-x64/`), so the `bin/` path added to PATH didn't contain the actual binary. Now passes `--strip 1` to tar during extraction to flatten the archive root, matching the pattern used by `actions/setup-node`. Also adds `streaming: true` to dependency install for visible error output on failure, and temporary runtime diagnostics logging.

## 0.2.0

### Breaking Changes

* [`354877c`](https://github.com/savvy-web/silk-runtime-action/commit/354877c6a163c476d7153b66f6b434bf2ae0a9d1) Remove explicit version inputs (`node-version`, `bun-version`, `deno-version`, `package-manager`, `package-manager-version`). All configuration now comes exclusively from `package.json` `devEngines` fields.
* Remove `pre` action hook (collapsed into main).
* Require `devEngines.packageManager` and `devEngines.runtime` in `package.json`.

### Features

* [`354877c`](https://github.com/savvy-web/silk-runtime-action/commit/354877c6a163c476d7153b66f6b434bf2ae0a9d1) Rewrite action internals from imperative TypeScript to Effect-based programs using `@savvy-web/github-action-effects` 0.11.x.

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

* | [`358dce1`](https://github.com/savvy-web/silk-runtime-action/commit/358dce10a1486bad3b524257ea67b84daa360fc1) | Dependency | Type    | Action | From   | To |
  | :------------------------------------------------------------------------------------------------------------ | :--------- | :------ | :----- | :----- | -- |
  | @savvy-web/changesets                                                                                         | dependency | updated | ^0.4.2 | ^0.5.3 |    |
  | @savvy-web/commitlint                                                                                         | dependency | updated | ^0.4.0 | ^0.4.2 |    |
  | @savvy-web/github-action-builder                                                                              | dependency | updated | ^0.2.1 | ^0.4.0 |    |
  | @savvy-web/lint-staged                                                                                        | dependency | updated | ^0.5.0 | ^0.6.1 |    |
  | @savvy-web/vitest                                                                                             | dependency | updated | ^0.2.0 | ^0.2.2 |    |

## 0.1.7

### Dependencies

* [`32ff0b0`](https://github.com/savvy-web/silk-runtime-action/commit/32ff0b0f977eeddad3aa0a3d262dccb2806f1eab) @savvy-web/changesets: ^0.1.1 → ^0.4.2
* @savvy-web/commitlint: ^0.3.3 → ^0.4.0
* @savvy-web/github-action-builder: ^0.1.4 → ^0.2.1
* @savvy-web/lint-staged: ^0.4.5 → ^0.5.0
* @savvy-web/vitest: ^0.1.0 → ^0.2.0

## 0.1.6

### Bug Fixes

* [`7f4fb75`](https://github.com/savvy-web/silk-runtime-action/commit/7f4fb753ce138a762c2c1511d74662fed2973051) Supports @savvy-web/vitest

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
