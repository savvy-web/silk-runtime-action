# src/CLAUDE.md

Source code architecture, build process, and development guidelines for the silk-runtime-action.

**See also:** [Root CLAUDE.md](../CLAUDE.md) for repository overview.

## Architecture Overview

The action is written as an **Effect-based program** using `@savvy-web/github-action-effects` (^2.0.0) for GitHub Action service abstractions. All side effects (file I/O, command execution, caching, outputs) flow through Effect services rather than direct API calls.

Key architectural properties:

- **Zero `@actions/*` dependencies** -- `github-action-effects` implements the GitHub Actions runtime protocol natively (V2 Twirp protocol with Azure Blob Storage for caching, native process execution, etc.)
- **Inputs via Effect Config API** -- `Config.string`, `Config.boolean`, `Config.withDefault` backed by a `ConfigProvider` that reads GitHub Actions input environment variables; `ActionInput.*` combinators for multi-value inputs
- **Logging via Step.\* namespace** -- `Step.groupStep` for collapsible sections that buffer output and expand on failure; `Step.success` for canonical success lines
- **Build via rsbuild** -- `@savvy-web/github-action-builder` ^0.7.1 uses rsbuild under the hood

For a full architectural spec see `.claude/design/silk-runtime-action/architecture.md`.

## Entry Points

The action has two lifecycle hooks:

```yaml
runs:
  using: "node24"
  main: "dist/main.js"
  post: "dist/post.js"
```

- **[main.ts](main.ts)** -> `dist/main.js` -- Thin entry that calls `Action.run(program, { layer: MainLive })`
- **[program.ts](program.ts)** -> `dist/main.js` (bundled) -- Effect pipeline that detects config, installs runtimes, sets up package manager, caches dependencies, and sets outputs
- **[post.ts](post.ts)** -> `dist/post.js` -- Saves the dependency cache after the job completes; reads `CacheState` from main, no-op on exact hit (non-fatal; errors and defects are logged as warnings via `Effect.catchAll` + `Effect.catchAllDefect`)

## Source Modules

### [main.ts](main.ts)

3-line thin entry. Imports `program` from `program.ts` and `MainLive` from `layers/app.ts`; calls `Action.run(program, { layer: MainLive })`.

### [program.ts](program.ts)

Top-level Effect pipeline (the main phase). Contains the `program` export plus helper functions:

- `installBiome` -- Installs Biome as a raw binary via `ToolInstaller.download` + `ToolInstaller.cacheFile`
- `installDependencies` -- Lockfile-aware install for the detected package manager
- `setupPackageManager` -- Activates the correct PM version via corepack or npm global install
- `getActivePackageManagers` -- Determines which PMs are active from runtimes
- `setOutputs` -- Sets all action outputs from pipeline results

### [post.ts](post.ts)

Post-action: reads `CacheState` via `ActionState.getOptional`, skips when missing or `restored===true`, otherwise calls `saveCache()` inside a `Step.groupStep`. Wrapped in `Effect.catchAll` + `Effect.catchAllDefect` so post-action failures never fail the workflow.

### [state.ts](state.ts)

Cross-phase state schemas. Exports `CacheState` (`Schema.Class` with `key`, `paths`, `restored`) and `STATE_KEYS` constant for use with `ActionState.save`/`get`.

### [layers/app.ts](layers/app.ts)

`MainLive` layer composition. Merges every library and Node platform layer the program needs: `ActionCacheLive` (with `NodeHttpClient`), `ToolInstallerLive`, `CommandRunnerLive`, `ActionStateLive` (with `NodeFileSystem`), `ActionEnvironmentLive`, `GlobLive`, `NodeFileSystem.layer`.

### [services/cache.ts](services/cache.ts)

Effect functions backed by `ActionCache`, `ActionState`, `ActionEnvironment`, `CommandRunner`, and library `Glob` services:

- `getDefaultCachePaths` / `getLockfilePatterns` -- Pure helpers per package manager
- `detectCachePath` -- Queries the installed PM for its actual cache directory (e.g., `pnpm store path`)
- `getCacheConfig` / `getCombinedCacheConfig` -- Merges configs for active PMs and adds tool cache paths
- `findLockFiles` -- Resolves lockfile patterns via `Glob.glob` (newline-separated patterns; `!`-prefix excludes)
- `generateCacheKey` / `generateRestoreKeys` -- Deterministic keys from runtime versions, PM version, branch, lockfile hashes (via `Glob.hashFiles`)
- `restoreCache` -- Restores cache via `ActionCache` (V2 Twirp) and saves `CacheState` for the post action
- `saveCache` -- Reads state saved by `restoreCache` and saves only when previous restore was not an exact hit

### [services/runtime-installer.ts](services/runtime-installer.ts)

- `RuntimeDescriptor` interface -- Describes how to download and install a tool
- `RuntimeInstaller` `Context.Tag` class -- Service tag with a single `install(version)` method
- `makeRuntimeInstaller` -- Factory that creates a `RuntimeInstaller` service shape from a descriptor; uses `ToolInstaller` primitives (`download`, `extractTar`/`extractZip`, `cacheDir`); wraps failures in `RuntimeInstallError`
- Pre-built layers: `NodeInstallerLive`, `BunInstallerLive`, `DenoInstallerLive`
- `installerLayerFor(name)` -- Returns the appropriate layer by runtime name

### [services/config-loader.ts](services/config-loader.ts)

Pure Effect functions for configuration loading and detection:

- `loadPackageJson` -- Reads and decodes `package.json` via `FileSystem`, wraps failures in `ConfigError`
- `parseDevEngines` -- Normalises `devEngines.runtime` from object/array to always-array
- `detectBiome` -- Checks `biome-version` input, then reads `$schema` from `biome.jsonc`/`biome.json`
- `detectTurbo` -- Returns `true` if `turbo.json` exists

### [schemas/domain.ts](schemas/domain.ts)

Effect Schema definitions:

- `AbsoluteVersion` -- Rejects semver range operators
- `RuntimeName` / `PackageManagerName` -- `Schema.Literal` unions
- `RuntimeEntry` / `PackageManagerEntry` -- Validated structs
- `DevEngines` -- Complete devEngines schema

### [errors/errors.ts](errors/errors.ts)

`Schema.TaggedError` hierarchy with computed `.message` getters:

| Tag | Fields | When thrown |
| --- | ------- | ----------- |
| `ConfigError` | `reason`, `file?`, `cause?` | Invalid/missing `package.json` or `devEngines` |
| `RuntimeInstallError` | `runtime`, `version`, `reason`, `cause?` | Runtime download or setup failure |
| `PackageManagerSetupError` | `packageManager`, `version`, `reason`, `cause?` | PM setup failure (corepack/npm) |
| `DependencyInstallError` | `packageManager`, `reason`, `cause?` | npm/pnpm/yarn/bun install failure |
| `CacheError` | `operation`, `reason`, `cause?` | Cache restore/save/key-generation failure |
| `ActionError` | union | Union type for exhaustive `Effect.catchTag` |

### [descriptors/](descriptors/)

One file per installable runtime (`node.ts`, `bun.ts`, `deno.ts`). Each exports a `descriptor` conforming to `RuntimeDescriptor`. `biome.ts` exports a `binaryMap` (platform/arch to binary name) since Biome is a single-binary download handled directly by `installBiome()`.

## Build Process

Build is configured in [`action.config.ts`](../action.config.ts) at the repo root:

```typescript
export default defineConfig({
  entries: { main: "src/main.ts", post: "src/post.ts" },
  build: { minify: true },
  persistLocal: { enabled: true, path: ".github/actions/local" },
});
```

Run the build:

```bash
pnpm build
```

This uses `@savvy-web/github-action-builder` (^0.7.1, rsbuild-based) to bundle both entry points to `dist/` and copy a testing variant to `.github/actions/local/`.

**Always commit `dist/` and `.github/actions/local/` after building.**

## TypeScript Configuration

- `module: "ESNext"`, `moduleResolution: "bundler"`, `target: "ES2022"`, `strict: true`, `noEmit: true`
- All imports must use `.js` extensions (enforced by Biome)
- Built-in Node.js modules must use the `node:` protocol (enforced by Biome)
- Separate type imports from value imports (enforced by Biome)

## Development Workflow

```bash
# 1. Edit source
vim src/services/config-loader.ts

# 2. Type-check
pnpm typecheck

# 3. Run tests
pnpm test

# 4. Lint
pnpm lint:fix

# 5. Build
pnpm build

# 6. Commit source AND dist
git add src/ dist/ .github/actions/local/
git commit -m "feat: ..."
```

## Effect Patterns

### Service injection

All services (`FileSystem`, `CommandRunner`, `ActionOutputs`, `ToolInstaller`, etc.) are provided via `Effect.provide` or as layers. Never import `@actions/*` packages directly -- they are not dependencies of this project.

### Input reading

Action inputs are read via the Effect `Config` API and library `ActionInput.*` combinators at point of use:

```typescript
const installDeps = yield* ActionInput.boolean("install-deps").pipe(Config.withDefault(true));
const biomeVersion = yield* Config.string("biome-version").pipe(Config.withDefault(""));
const additionalLockfiles = yield* ActionInput.multiline("additional-lockfiles").pipe(Config.withDefault([]));
```

`Action.run` sets up a `ConfigProvider` that reads from GitHub Actions input environment variables (`INPUT_*`). `ActionInput.multiline` splits on `\n` and trims; it does not parse comma-separated, bullets, or JSON arrays -- use newline-separated input.

### Step.groupStep convention

Each phase of the main program is wrapped in `Step.groupStep(title, effect)`. This:

- Buffers log lines emitted inside the group
- Collapses the group in CI when successful (quiet-on-success)
- Expands and prints buffered lines when the group fails (verbose-on-failure)

Use `Step.success("X")` inside a group body to emit a canonical success-line for the group's summary.

```typescript
yield* Step.groupStep("Install runtimes", Effect.forEach(config.runtimes, (rt) => /* ... */));
yield* Step.success(`Biome ${version}`);
```

### Error handling

Use tagged errors (`ConfigError`, `RuntimeInstallError`, etc.) and handle them with `Effect.catchTag`. Non-fatal steps use `Effect.catchAll` or `Effect.catchTag` to demote failures to warnings.

### Testing

Tests use library-provided test layers from `@savvy-web/github-action-effects/testing`:

```typescript
import { ActionOutputsTest } from "@savvy-web/github-action-effects/testing";
const outputs = ActionOutputsTest.empty();
const layer = ActionOutputsTest.layer(outputs);
await program.pipe(Effect.provide(layer), Effect.runPromise);
expect(outputs.outputs.find((o) => o.name === "node-version")?.value).toBe("24.11.0");
```

Test layers expose mutable state objects that capture method calls. Asserting against the state is preferred over mocking individual methods. For failure-injection cases (e.g., simulating `ActionCache.save` errors), a hand-rolled `Layer.succeed(Tag, {...})` mock is still acceptable.

Action inputs are overridden via `ConfigProvider.fromMap(new Map([["input-name", "value"]]))`.

Tests are co-located with their source modules. See [errors/errors.test.ts](errors/errors.test.ts), [services/cache.test.ts](services/cache.test.ts), [program.test.ts](program.test.ts), [post.test.ts](post.test.ts) for representative patterns.

## Common Issues

### Changes don't take effect in CI

Run `pnpm build` and commit `dist/` + `.github/actions/local/`.

### Import not found

Add the `.js` extension to all local imports.

### Effect service not provided

Ensure the required service is included in the layer passed to `Effect.provide` or `Action.run`.

## Related Documentation

- [Root CLAUDE.md](../CLAUDE.md) - Repository overview
- [**fixtures**/CLAUDE.md](../__fixtures__/CLAUDE.md) - Integration testing
- [Effect Documentation](https://effect.website/docs) - Effect framework reference

### Design Documentation

For deep architectural details:

- **Architecture:** `@../.claude/design/silk-runtime-action/architecture.md`
- **Effect Service Model:** `@../.claude/design/silk-runtime-action/effect-service-model.md`
- **Runtime Installation:** `@../.claude/design/silk-runtime-action/runtime-installation.md`
- **Caching Strategy:** `@../.claude/design/silk-runtime-action/caching-strategy.md`
