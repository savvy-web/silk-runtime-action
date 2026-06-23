# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This repository provides a **comprehensive JavaScript runtime setup GitHub Action** that supports Node.js, Bun, and Deno with a single, intelligent action that handles everything automatically.

**Primary purpose:** Simplify JavaScript/TypeScript CI/CD workflows with a standardized, package.json-driven runtime configuration that ensures reproducible builds.

**Key Features:**

* **Multi-Runtime Support** - Node.js, Bun, and Deno runtimes configured via `devEngines.runtime`
* **Complete Runtime Setup** - Downloads and installs runtimes directly from official sources
* **Package.json-Driven Configuration** - All runtime and package manager config from package.json
* **Absolute Version Enforcement** - Requires exact versions (no semver ranges) for reproducible builds
* **Package Manager Versioning** - Installs exact package manager versions via corepack
* **Intelligent Caching** - Dependency caching with lock file detection for all package managers
* **Optional Biome** - Auto-detects and installs Biome from config files
* **Turbo Detection** - Detects Turborepo configuration
* **Lockfile Intelligence** - Gracefully handles projects with or without lock files

## Requirements

Repositories using this action **MUST** have a `package.json` in their root directory with a `devEngines` field containing:

1. **`devEngines.packageManager` field** - Specifies the package manager and exact version
   * Must be an object with `name` and `version` properties (and optionally `onFail`)
   * Supported package managers: `npm`, `pnpm`, `yarn`, `bun`
   * Version MUST be absolute (e.g., "10.20.0"), NOT semver ranges
   * `onFail` is optional (parsed and stored but not currently acted upon by this action)
   * This follows the [Corepack devEngines format](https://github.com/nodejs/corepack)

2. **`devEngines.runtime` field** - Specifies runtime(s) and exact versions
   * Can be a single runtime object or an array of runtimes
   * Each runtime MUST have `name` (node|bun|deno) and `version` (absolute version) properties (and optionally `onFail`)
   * Versions MUST be absolute (e.g., "24.11.0"), NOT semver ranges (e.g., "^24.0.0")
   * `onFail` is optional (parsed and stored but not currently acted upon by this action)
   * See [pnpm devEngines.runtime](https://pnpm.io/package_json#devenginesruntime) for format details

**Example package.json:**

```json
{
  "name": "my-project",
  "devEngines": {
    "packageManager": {
      "name": "pnpm",
      "version": "10.20.0",
      "onFail": "error"
    },
    "runtime": {
      "name": "node",
      "version": "24.11.0",
      "onFail": "error"
    }
  }
}
```

**Multi-runtime example:**

```json
{
  "name": "my-project",
  "devEngines": {
    "packageManager": {
      "name": "bun",
      "version": "1.3.3",
      "onFail": "error"
    },
    "runtime": [
      {
        "name": "node",
        "version": "24.11.0",
        "onFail": "error"
      },
      {
        "name": "bun",
        "version": "1.3.3",
        "onFail": "error"
      }
    ]
  }
}
```

**Technical stack:**

* **Runtime framework:** [Effect](https://effect.website) for typed errors, dependency injection, and service composition
* **GitHub Action services:** `@savvy-web/github-action-effects` ^2.0.0 — zero `@actions/*` dependencies, ships `Step.*` for step-buffered logging, `GithubMarkdown.*` for summary helpers, `ActionInput.{boolean,multiline}` for typed input parsing, and `<Service>Test` test layers (via `@savvy-web/github-action-effects/testing`).
* **Build tool:** `@savvy-web/github-action-builder` ^0.7.1 (rsbuild-based) configured via `action.config.ts`
* **Cross-phase state:** `src/state.ts` defines `CacheState` (Schema.Class) and `STATE_KEYS`; `main` writes, `post` reads.
* **Platform I/O:** `@effect/platform` (FileSystem)
* **Action type:** Compiled Node.js action (uses `node24` runtime, see `action.yml`)
* **Package manager:** pnpm 10.33.4 (specified in package.json)
* **Node.js version:** 26.2.0 (specified in package.json devEngines.runtime)
* **Linting:** Biome 2.4.15 with strict rules
* **Testing:** Vitest with Effect test layers + fixture-based workflow tests
* **Type checking:** TypeScript with native preview build (`@typescript/native-preview`)
* **Direct dependencies:** Zero `@actions/*` packages -- all GitHub Actions integration is provided by `github-action-effects`
* **No pnpm overrides or patches** -- clean dependency resolution

## Quick Start

### Using the Action

Ensure your project has a valid `package.json` with `devEngines.packageManager` and `devEngines.runtime` fields:

```json
{
  "name": "my-project",
  "devEngines": {
    "packageManager": {
      "name": "pnpm",
      "version": "10.20.0",
      "onFail": "error"
    },
    "runtime": {
      "name": "node",
      "version": "24.11.0",
      "onFail": "error"
    }
  }
}
```

Then use the action in your workflow:

```yaml
steps:
  - uses: actions/checkout@v6
  - uses: savvy-web/silk-runtime-action@v1
    # That's it! Reads everything from package.json
  - run: pnpm test
```

### Development Workflow

```bash
# Install dependencies
pnpm install

# Run type checking
pnpm typecheck

# Run tests
pnpm test

# Run linting
pnpm lint:fix

# Build the action (REQUIRED before commit!)
pnpm build

# Commit both source and dist (including .github/actions/local/)
git add src/ dist/ .github/actions/local/
git commit -m "feat: add new feature"
```

## Dogfooding First-Party Dependencies

We author every dependency in the table below, so a bug or missing API in one can be fixed **in its own repo** and dogfooded through this action before publishing. The action is a **bundled** artifact — `pnpm build` inlines every dependency into `dist/{main,post}.js` — so once a local library build is linked and this repo is rebuilt, the change is baked into the committed `dist`. The integration runs the committed `dist`, **not** `node_modules`.

| Package | Repo | Local checkout |
| --- | --- | --- |
| `@savvy-web/github-action-effects` | `savvy-web/systems` | `../systems/packages/github-action-effects` |
| `@savvy-web/github-action-builder` | `savvy-web/systems` | `../systems/packages/github-action-builder` |

Both packages live inside the `systems` monorepo. Both are direct-only dependencies with no transitive duplication path, so `pnpm link ../<path>` is the linking mechanism for either. The `pnpm-workspace.yaml` `overrides` mechanism is not needed here unless a future first-party transitive dependency is introduced.

**Procedure:**

1. **Build the library:** in the `systems` repo, `cd packages/<name>` and run `node savvy.build.ts --target dev` (produces the `dist/dev` link target).
2. **Link it:** `pnpm link ../systems/packages/github-action-effects` here, then `pnpm install`.
3. **Keep the declared range correct** in this repo's `package.json` for the eventual unlinked install.
4. **Iterate:** edit library source → `node savvy.build.ts --target dev` there → `pnpm typecheck` + `pnpm test` here → `pnpm build` here → commit (`src` + `dist` + changeset) → push `dev`.
5. **Library edits ship separately:** they land on the library's own branch and release with its next published version.
6. **Final step, only AFTER the dogfooded version publishes:** remove the link, pin the published range, `pnpm install`.

Commits must be GPG-signed with the GitHub-verified key for `C. Spencer Beggs <spencer@savvyweb.systems>` or the signature ruleset rejects them.

### `**/.turbo` is no longer file-cached

The `**/.turbo` directory is **not** added to the GitHub Actions file cache. The
embedded remote cache server (or Vercel passthrough) replaces it — Turborepo
writes artifacts to the remote cache API instead of local `.turbo` directories,
so file-caching them is redundant and wasteful.

### Known limitation: `ACTIONS_RUNTIME_TOKEN` lifetime

The embedded GitHub Actions cache backend captures `ACTIONS_RUNTIME_TOKEN` at
server spawn time. This token is a short-lived JWT issued by the GitHub Actions
backend. On very long-running jobs, late cache-write requests from Turborepo may
receive a `401 Unauthorized` response if the token has expired before the job
finishes. The S3 backend is unaffected because it uses its own long-lived
credentials rather than the GitHub runtime token.

## Development & Release Cycle

### The `dev` branch convention

All in-progress feature work lands on a long-lived **`dev`** branch, never directly on `main`. `main` always reflects the last released state.

The shared release workflow at `savvy-web/.github/.github/workflows/release.yml` has a matching **`dev` branch**. This repo's own `release.yml` pins `@dev` so it exercises in-progress workflow changes before they reach `main`.

### Flow: `dev` → `main` → release

1. Feature work accumulates on `dev`; merge it into `main` when ready.
2. The push to `main` triggers **Phase 1** — changeset detection creates/updates `changeset-release/main` and the release PR.
3. Pushes to the release branch trigger **Phase 2** validation (build, publish dry-runs, release-notes preview, sticky comment).
4. Merging the release PR triggers **Phase 3** — publishing, Git tags, and a published GitHub release.
5. The published release fires `release-sync.yml`, which closes the loop by resetting `dev` back to `main`.

### `release-sync.yml` — post-release housekeeping

Triggered by `release: [published]` (and `workflow_dispatch` with a `tag` input + `dry-run` for rehearsal). Runs as the GitHub App bot so its pushes can bypass protection and won't recurse (no workflow triggers on tag/`dev` pushes). On a **stable SemVer 2.0.0 release `>= 1.0.0`** (bare `MAJOR.MINOR.PATCH` — no leading `v`, no `-prerelease`, no `+build`) it:

1. Moves (or creates) the **`v<major>`** alias tag (e.g. `v1`) at the released commit.
2. **Hard-resets `dev` to `main` HEAD** — a genuine clobber, so any `dev` commit not yet in `main` is discarded. This is safe by design: `dev` work always lands in `main` before a release.

Each push is guarded: if the remote `v<major>` tag or `dev` already points at its target commit, that push is skipped. Sub-`1.0.0`, prerelease, build-metadata, and non-SemVer tags are ignored (no-op).

## Documentation Structure

This repository uses modular documentation organized by directory:

* **[src/CLAUDE.md](src/CLAUDE.md)** - Source code architecture, build process, and development guidelines (unit tests are co-located with their source modules under `src/`)
* **[**fixtures**/CLAUDE.md](__fixtures__/CLAUDE.md)** - Test fixtures for integration testing
* **[.github/workflows/CLAUDE.md](.github/workflows/CLAUDE.md)** - Workflow testing patterns and reusable actions

### Design Documentation

For deep architectural details, rationale, and design decisions:

* **Architecture:** `@./.claude/design/silk-runtime-action/architecture.md`
  Load when understanding overall system design, entry points, or layer composition.
* **Effect Service Model:** `@./.claude/design/silk-runtime-action/effect-service-model.md`
  Load when working with services, error handling, or dependency injection.
* **Runtime Installation:** `@./.claude/design/silk-runtime-action/runtime-installation.md`
  Load when modifying runtime descriptors, PM setup, or Biome installation.
* **Caching Strategy:** `@./.claude/design/silk-runtime-action/caching-strategy.md`
  Load when working with cache keys, lockfiles, or cross-phase state.
* **Build and Distribution:** `@./.claude/design/silk-runtime-action/build-and-distribution.md`
  Load when modifying build config, dist management, or release process.
* **Testing Strategy:** `@./.claude/design/silk-runtime-action/testing-strategy.md`
  Load when writing tests, understanding mock patterns, or fixture setup.

## Project Structure

```text
.
├── src/
│   ├── main.ts                # 4-line Action.run(program, { layer: MainLive })
│   ├── post.ts                # post Effect + PostLive + Action.run
│   ├── program.ts             # main Effect program
│   ├── state.ts               # CacheState Schema.Class + STATE_KEYS
│   ├── layers/
│   │   └── app.ts             # MainLive composition
│   ├── services/
│   │   ├── runtime-installer.ts + .test.ts
│   │   ├── cache.ts            + .test.ts
│   │   └── config-loader.ts    + .test.ts
│   ├── descriptors/
│   │   ├── node.ts / bun.ts / deno.ts / biome.ts
│   │   └── descriptors.test.ts
│   ├── schemas/
│   │   └── domain.ts           + domain.test.ts
│   └── errors/
│       └── errors.ts           + errors.test.ts
├── dist/
│   ├── main.js / post.js / package.json
├── __fixtures__/              # workflow integration test fixtures
├── .github/
│   ├── actions/local/         # mirrored bundled action for local testing
│   └── workflows/             # CI workflows
├── action.config.ts
├── action.yml
└── package.json
```

## Action Inputs

All inputs are **optional**. If not provided, values are auto-detected from
`package.json` or configuration files. Runtime and package manager versions
are read exclusively from `devEngines` — there are no explicit version inputs.

### Feature Inputs

* **`biome-version`** - Biome version override (e.g., `2.3.14`). If not
  provided, auto-detects from `biome.jsonc` or `biome.json` `$schema` field.
  Leave empty to skip Biome installation.
* **`install-deps`** - Whether to install dependencies (`true` | `false`).
  Default: `true`. Set to `false` to skip dependency installation.

### Turbo Remote Cache Inputs

* **`turbo-cache`** - Turbo remote cache mode (`auto` | `off`). `auto` starts
  an embedded cache server when `turbo.json` is present and no external Vercel
  creds are set. Default: `"auto"`.
* **`turbo-cache-prefix`** - Key prefix/namespace for embedded turbo cache
  artifacts. Default: `""`.
* **`turbo-token`** - Turbo remote cache token. When provided together with
  `turbo-team`, selects passthrough (external Vercel) mode and disables the
  embedded server.
* **`turbo-team`** - Turbo team slug. When provided together with `turbo-token`,
  selects passthrough (external Vercel) mode and disables the embedded server.
* **`turbo-s3-bucket`** - S3 bucket for the embedded turbo cache backend.
  Presence selects the S3 backend.
* **`turbo-s3-region`** - S3 region for the embedded turbo cache backend.
* **`turbo-s3-endpoint`** - Custom S3 endpoint (R2/MinIO/Spaces). Leave empty
  for AWS S3.
* **`turbo-s3-access-key-id`** - S3 access key ID for the embedded turbo cache
  backend.
* **`turbo-s3-secret-access-key`** - S3 secret access key for the embedded
  turbo cache backend.
* **`turbo-s3-session-token`** - Optional S3 session token for temporary
  credentials.
* **`turbo-s3-prefix`** - Optional key prefix within the S3 bucket.

### Cache Inputs

* **`additional-lockfiles`** - Additional lockfile patterns to include in cache
  key generation. Supports glob patterns. Multiline string.
* **`additional-cache-paths`** - Additional paths to cache/restore. Multiline
  string with glob patterns.

### Testing Inputs

* **`cache-bust`** - Cache busting string appended to cache key. Use a unique
  value (e.g., run ID) to force a cache miss. `"false"` disables. **Only use
  for testing - do not use in production!**

## Action Outputs

### Runtime Outputs

* **`node-version`** - Installed Node.js version (e.g., `"24.10.0"`) or empty
  if not installed
* **`node-enabled`** - Whether Node.js was installed (`"true"` | `"false"`)
* **`bun-version`** - Installed Bun version (e.g., `"1.3.3"`) or empty if not
  installed
* **`bun-enabled`** - Whether Bun was installed (`"true"` | `"false"`)
* **`deno-version`** - Installed Deno version (e.g., `"2.5.6"`) or empty if
  not installed
* **`deno-enabled`** - Whether Deno was installed (`"true"` | `"false"`)

### Package Manager Outputs

* **`package-manager`** - Package manager name (`npm` | `pnpm` | `yarn` |
  `bun` | `deno`)
* **`package-manager-version`** - Package manager version (e.g., `"10.20.0"`)

### Feature Outputs

* **`biome-version`** - Installed Biome version (e.g., `"2.3.14"`) or empty if
  not installed
* **`biome-enabled`** - Whether Biome was installed (`"true"` | `"false"`)
* **`turbo-enabled`** - Whether Turbo configuration was detected (`"true"` |
  `"false"`)
* **`turbo-cache-backend`** - Active turbo cache backend (`"github"` | `"s3"` |
  `"remote"` | `"none"`). `"github"` = embedded GitHub Actions cache backend;
  `"s3"` = embedded S3 backend; `"remote"` = passthrough to external Vercel;
  `"none"` = turbo cache disabled or turbo not detected.
* **`turbo-cache-port`** - Local port the embedded turbo cache server bound to.
  Empty when the embedded server was not started.

### Cache Outputs

* **`cache-hit`** - Whether dependencies were restored from cache (`"true"` |
  `"partial"` | `"false"`)
* **`lockfiles`** - Comma-separated list of detected lockfiles used for cache
  key generation (e.g., `"pnpm-lock.yaml,deno.lock"`)
* **`cache-paths`** - Comma-separated list of cache paths being
  cached/restored (e.g., `"/home/runner/.cache/deno,**/node_modules"`)

## Code Quality Standards

### Biome Configuration

* **Indentation:** Tabs, width 2
* **Line width:** 120 characters
* **Import organization:** Lexicographic order
* **Import extensions:** Forced `.js` extensions (even for TypeScript files)
* **Import types:** Separated type imports
* **Node.js imports:** Must use `node:` protocol
* **Type definitions:** Prefer `type` over `interface`
* **No unused variables:** Error level

### TypeScript Configuration

* **Module system:** ESNext with bundler resolution
* **Target:** ES2022
* **Strict mode:** Enabled
* **Import extensions:** Required (`.js` for all imports)

## Common Commands

```bash
# Linting
pnpm lint              # Check with Biome
pnpm lint:fix          # Auto-fix Biome issues
pnpm lint:md           # Lint markdown
pnpm lint:md:fix       # Fix markdown

# Type Checking
pnpm typecheck         # Run TypeScript compiler

# Testing
pnpm test              # Run unit tests with coverage
pnpm test --watch      # Run tests in watch mode

# Building
pnpm build             # Build action with github-action-builder (see Build Process below)

# Release
pnpm changeset         # Create changeset for release
pnpm ci:version        # Prepare for release
```

## Release Process

Uses Changesets for versioning:

1. **Create changeset:** `pnpm changeset`
2. **Changesets workflow automatically:**
   * Creates release PR
   * Updates `package.json` version
   * Updates `CHANGELOG.md`
   * Creates GitHub release with tags
3. **Users reference by tag:**

   ```yaml
   - uses: savvy-web/silk-runtime-action@v1
   - uses: savvy-web/silk-runtime-action@v1.2.3
   ```

## Build Process

The build is configured by [`action.config.ts`](action.config.ts) and invoked via `@savvy-web/github-action-builder` ^0.7.1 (rsbuild-based).

### What Gets Built

1. **Compile TypeScript to JavaScript** - Bundles two entry points:
   * `src/main.ts` → `dist/main.js` (main action logic)
   * `src/post.ts` → `dist/post.js` (post-action cache save)

2. **Bundle Configuration** (from `action.config.ts`):
   * **Minification:** Enabled

3. **Create Module Markers:**
   * Creates `dist/package.json` with `{ "type": "module" }` to mark files as ES modules

### Local Testing Copy

The build automatically creates a **local copy** of the action at `.github/actions/local/` for testing workflows. This copy is identical to `dist/` but is used by the `test-fixture` composite action, keeping test artifacts separate from the production build.

### Build Output Structure

```text
dist/                           # Production build (committed)
├── main.js                     # Main action bundle
├── post.js                     # Post-action bundle
└── package.json                # Module marker

.github/actions/local/          # Local testing copy (committed)
└── dist/
    ├── main.js
    ├── post.js
    └── package.json
```

### Key Points

1. **Always commit both directories** - Both `dist/` and `.github/actions/local/` must be committed to git
2. **Build before committing** - Run `pnpm build` after any source changes
3. **Clean builds** - The build script cleans both directories before building

## Common Issues and Solutions

### dist/ not updated

**Issue:** Changes don't take effect in CI

**Solution:** Always run `pnpm build` and commit `dist/` files

```bash
pnpm build
git add dist/ .github/actions/local/
git commit -m "build: update compiled output"
```

### Import errors

**Issue:** "Module not found" or import errors

**Solution:** Always use `.js` extensions and `node:` protocol

```typescript
// Correct
import { loadPackageJson } from "./services/config-loader.js";
import { readFile } from "node:fs/promises";

// Incorrect
import { loadPackageJson } from "./services/config-loader";
import { readFile } from "fs/promises";
```

### Missing or invalid package.json

**Issue:** "package.json not found" or "package.json has invalid or missing devEngines field"

**Solution:** Ensure your project has a `package.json` with both `devEngines.packageManager` and `devEngines.runtime` fields.

### Semver range not allowed

**Issue:** "Must be an absolute version (e.g., '24.11.0'), not a semver range"

**Solution:** Use exact versions in `devEngines`, not semver ranges. Version strings containing `^`, `~`, `>`, `<`, `=`, `*`, `x`, or `X` are rejected by the Effect Schema validator.

## Important Notes

1. **Always commit dist/** - The compiled JavaScript must be committed for GitHub Actions to work
2. **Build before pushing** - Run `pnpm build` after any source changes
3. **Test with fixtures** - Push to test real-world scenarios (see [**fixtures**/CLAUDE.md](__fixtures__/CLAUDE.md))
4. **Changesets for versioning** - Use changesets for version management
5. **Biome is authoritative** - All formatting decisions defer to Biome
6. **Absolute versions only** - `devEngines.packageManager` and `devEngines.runtime` must use exact versions, not semver ranges
7. **package.json is required** - All projects using this action MUST have a valid package.json with `devEngines.packageManager` and `devEngines.runtime` fields
8. **devEngines-only config** - Runtime and package manager versions come exclusively from `devEngines`; there are no explicit version inputs

## Contributing

When contributing:

1. Modify TypeScript source in `src/` (see [src/CLAUDE.md](src/CLAUDE.md))
2. Add/update co-located unit tests next to the source modules (e.g., `src/services/cache.test.ts`)
3. Add/update fixtures in `__fixtures__/` if needed (see [**fixtures**/CLAUDE.md](__fixtures__/CLAUDE.md))
4. Update workflows in `.github/workflows/` if needed (see [.github/workflows/CLAUDE.md](.github/workflows/CLAUDE.md))
5. Run `pnpm build` to compile
6. Commit both source and dist
7. Create changeset with `pnpm changeset`
8. Push and verify all tests pass in GitHub Actions
9. Update documentation if needed
