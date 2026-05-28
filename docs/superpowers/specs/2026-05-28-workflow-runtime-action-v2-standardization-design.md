# workflow-runtime-action v2 Standardization — Design

**Date:** 2026-05-28
**Branch:** `dev`
**Status:** Approved — ready for implementation planning

## Background

`@savvy-web/github-action-effects` released v2.0.0 with a stable 38-service API surface, native ESM runtime, Twirp V2 cache, step-buffered logging (`Step.*` namespace), structured outputs (`ActionInput.multiline` / `ActionInput.boolean`), and a library-provided markdown helper namespace (`GithubMarkdown`). Two sibling actions — `silk-release-action` and `pnpm-config-dependency-action` — have already been migrated to this v2 canonical pattern.

`workflow-runtime-action` is already on `@savvy-web/github-action-effects@^2.0.0` and `@savvy-web/github-action-builder@^0.7.1`, with `Action.run` as the entry pattern, no `@actions/*` deps, and shared `tsconfig`/`biome`/`vitest` configs. But it still carries pre-v2 idioms in six areas: file layout, entry-point composition, test mocking, logging primitives, custom markdown/emoji helpers, and multiline input parsing.

This spec describes how to bring the action into full canonical alignment with the pnpm-config-dependency-action template (its closest structural sibling — single-package action with multiple domain services), as one bundled change on the `dev` branch.

## Scope

**In scope:**

- Restructure `src/` to the canonical `services/`, `errors/`, `schemas/`, `layers/`, `state.ts` layout.
- Split `src/main.ts` into a 4-line entry (`main.ts`) + program body (`program.ts`) + composed layer (`layers/app.ts`).
- Migrate domain errors from `Data.TaggedError` → `Schema.TaggedError` with computed `.message` getters.
- Migrate every test from hand-rolled `Layer.succeed(...)` mocks to library `<Service>Test.empty()` + `<Service>Test.layer(state)` from `@savvy-web/github-action-effects/testing`.
- Adopt `Step.groupStep` / `Step.withStep` / `Step.success` in `program.ts` for quiet-on-success, verbose-on-failure step buffering.
- Replace inline multiline parsing with `ActionInput.multiline` and `ActionInput.boolean`.
- Replace `src/emoji.ts` with `GithubMarkdown.*` from the library.
- Replace `fast-glob` direct dep with `GlobLive` + `Glob.hashFiles` from the library.
- Convert custom `RuntimeInstaller` from `Context.GenericTag` to a `Context.Tag` class.
- Add `Dogfooding First-Party Dependencies` and `Development & Release Cycle` sections to `CLAUDE.md` (scoped to this action's two first-party deps).
- Sync `.claude/design/workflow-runtime-action/*.md` design docs and `src/CLAUDE.md` + `__test__/CLAUDE.md` to reflect the new structure.
- Align `pnpm` version in `devEngines.packageManager` to `10.33.4` to match references.
- Rebuild `dist/` and `.github/actions/local/dist/` (currently stale from Mar 2024).

**Out of scope:**

- Adding a `pre.ts` entry. This action has no GitHub App token to provision; the runtime install → cache restore sequencing requires `main` to do both. Two entries (`main`, `post`) remain.
- Refactoring `src/descriptors/{node,bun,deno,biome}.ts` — domain-specific, well-isolated, no canonical equivalent to defer to.
- Changes to `action.yml` inputs or outputs.
- Changes to fixture-based workflow tests in `.github/workflows/test.yml` and `__fixtures__/`.
- Changes to the published action's contract (inputs, outputs, runs.using, dist entry paths).

## Target file layout

```text
src/
├── main.ts                    # 4-line: Action.run(program, { layer: MainLive })
├── post.ts                    # post Effect + PostLive + Action.run
├── program.ts                 # Main Effect program (was inline in main.ts)
├── state.ts                   # Schema.Class state + STATE_KEYS
├── layers/
│   └── app.ts                 # MainLive composition
├── services/
│   ├── runtime-installer.ts   + runtime-installer.test.ts
│   ├── cache.ts               + cache.test.ts
│   └── config-loader.ts       + config-loader.test.ts
├── descriptors/               # unchanged
│   ├── node.ts
│   ├── bun.ts
│   ├── deno.ts
│   └── biome.ts
├── schemas/
│   └── domain.ts              + domain.test.ts
└── errors/
    └── errors.ts              + errors.test.ts
```

No `src/utils/` (library covers inputs + markdown). No `src/emoji.ts`. `__fixtures__/` stays for workflow integration tests. `__test__/` near-empty after migration — fold its `CLAUDE.md` guidance into `src/CLAUDE.md` and delete the file. Keep `__test__/integration/` only if cross-cutting integration tests exist.

## Entry-point shapes

### `src/main.ts`

```typescript
import { Action } from "@savvy-web/github-action-effects";
import { MainLive } from "./layers/app.js";
import { program } from "./program.js";

Action.run(program, { layer: MainLive });
```

### `src/program.ts`

Body of the current `main.ts`, restructured as `Step.groupStep` blocks:

```typescript
export const program = Effect.gen(function* () {
  // Inputs (top of program)
  const biomeVersion = yield* Config.string("biome-version").pipe(Config.withDefault(""));
  const installDeps = yield* ActionInput.boolean("install-deps").pipe(Config.withDefault(true));
  const additionalLockfiles = yield* ActionInput.multiline("additional-lockfiles").pipe(Config.withDefault([]));
  const additionalCachePaths = yield* ActionInput.multiline("additional-cache-paths").pipe(Config.withDefault([]));
  const cacheBust = yield* Config.string("cache-bust").pipe(Config.withDefault(""));
  const turboToken = yield* Config.string("turbo-token").pipe(Config.withDefault(""));
  const turboTeam = yield* Config.string("turbo-team").pipe(Config.withDefault(""));

  // Phase groups
  const devEngines = yield* Step.groupStep("Load devEngines", loadDevEngines);
  const installed = yield* Step.groupStep("Setup runtimes", installRuntimes(devEngines));
  yield* Step.groupStep("Setup package manager", setupPackageManager(devEngines));
  const cacheOutcome = yield* Step.groupStep("Cache restore", restoreCache({ lockfiles, additionalCachePaths, cacheBust }));
  if (installDeps) {
    yield* Step.groupStep("Install dependencies", runPackageManagerInstall(devEngines, cacheOutcome));
  }
  if (biomeVersion !== "" || /* auto-detect */) {
    yield* Step.groupStep("Biome", installBiome(biomeVersion));
  }
  if (turboToken !== "") {
    yield* Step.groupStep("Turbo", configureTurbo({ turboToken, turboTeam }));
  }

  // Outputs (scalar strings only — no setJson)
  yield* emitOutputs({ installed, cacheOutcome, biomeVersion, turboEnabled });
});
```

### `src/post.ts`

```typescript
export const post = Effect.gen(function* () {
  const state = yield* ActionState;
  const cacheState = yield* state.getOptional(STATE_KEYS.cacheState, CacheState);
  if (Option.isSome(cacheState) && !cacheState.value.restored) {
    yield* Step.groupStep("Cache save", saveCache(cacheState.value));
  }
}).pipe(
  Effect.catchAllDefect((defect) =>
    Effect.logWarning(`Post-action warning: ${defect instanceof Error ? defect.message : String(defect)}`),
  ),
);

export const PostLive = Layer.mergeAll(
  ActionCacheLive,
  ActionStateLive.pipe(Layer.provide(NodeFileSystem.layer)),
);

if (process.env.GITHUB_ACTIONS) {
  await Action.run(post, { layer: PostLive });
}
```

### `src/layers/app.ts`

```typescript
export const MainLive = Layer.mergeAll(
  RuntimeInstallerLive,
  ActionCacheLive,
  ToolInstallerLive,
  CommandRunnerLive,
  ActionStateLive.pipe(Layer.provide(NodeFileSystem.layer)),
  ActionEnvironmentLive,
  GlobLive,
  NodeFileSystem.layer,
);
```

Notable changes from current `MainLive`:

- **Add `GlobLive`** for lockfile hashing via `Glob.hashFiles` — drops `fast-glob` direct dep.
- **`RuntimeInstaller`** becomes a `Context.Tag` class (modern Effect pattern), not `Context.GenericTag`.

## Errors

`src/errors/errors.ts` — five `Schema.TaggedError` types with computed `.message` getters:

```typescript
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
  reason: Schema.NonEmptyString,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Unknown),
}) {
  get message(): string {
    return this.path ? `${this.reason} (at ${this.path})` : this.reason;
  }
}

export class RuntimeInstallError extends Schema.TaggedError<RuntimeInstallError>()("RuntimeInstallError", {
  runtime: Schema.Literal("node", "bun", "deno"),
  version: Schema.String,
  reason: Schema.NonEmptyString,
  cause: Schema.optional(Schema.Unknown),
}) {
  get message(): string {
    return `Failed to install ${this.runtime}@${this.version}: ${this.reason}`;
  }
}

// PackageManagerSetupError, DependencyInstallError, CacheError follow the same shape.

export type ActionError =
  | ConfigError
  | RuntimeInstallError
  | PackageManagerSetupError
  | DependencyInstallError
  | CacheError;
```

## State

`src/state.ts` formalizes the cross-phase state that `main` writes and `post` reads:

```typescript
export const STATE_KEYS = {
  cacheState: "cache-state",
} as const;

export class CacheState extends Schema.Class<CacheState>("CacheState")({
  key: Schema.String,
  paths: Schema.Array(Schema.String),
  restored: Schema.Boolean,
}) {}
```

`main` writes `CacheState` after a restore attempt (whether hit or miss). `post` reads it and saves the cache iff `restored === false`.

## Schemas

`src/schemas/domain.ts` is the current `src/schemas.ts` relocated verbatim — `AbsoluteVersion`, `RuntimeName`, `RuntimeSpec`, `PackageManagerSpec`, `DevEngines`. No semantic changes.

## Test migration

Replace every hand-rolled `Layer.succeed(Tag, { method: () => Effect.void })` mock with library `<Service>Test.empty()` + `<Service>Test.layer(state)` from `@savvy-web/github-action-effects/testing`.

### Per-file plan

| Current file | New location & treatment |
| --- | --- |
| `__test__/main.test.ts` (28 KB) | Rewrite as `src/program.test.ts` using library Test layers |
| `__test__/post.test.ts` | Rewrite as `src/post.test.ts` using `ActionCacheTest` + `ActionStateTest` |
| `__test__/runtime-installer.test.ts` | Move to `src/services/runtime-installer.test.ts`, use `ToolInstallerTest` + `CommandRunnerTest` |
| `__test__/cache.test.ts` | Move to `src/services/cache.test.ts`, use `ActionCacheTest` + `GlobTest` |
| `__test__/config.test.ts` | Move to `src/services/config-loader.test.ts` — pure-function tests, no Effect layers needed |
| `__test__/descriptors.test.ts` | Move alongside `src/descriptors/` |
| `__test__/schemas.test.ts` | Move to `src/schemas/domain.test.ts` |
| `__test__/errors.test.ts` | Move to `src/errors/errors.test.ts` |
| `__test__/emoji.test.ts` | Delete (emoji.ts is removed) |

For the custom `RuntimeInstaller` service, define `RuntimeInstallerTest` following the library convention (`empty()` returns state object, `layer(state)` returns Layer) so downstream consumers (`program.test.ts`) get a consistent mocking surface.

### Canonical test shape

```typescript
import { ActionOutputsTest, ActionStateTest, ActionCacheTest, CommandRunnerTest, ToolInstallerTest }
  from "@savvy-web/github-action-effects/testing";

const outputs = ActionOutputsTest.empty();
const state = ActionStateTest.empty();
const cache = ActionCacheTest.empty();
const runner = CommandRunnerTest.empty();
const tools = ToolInstallerTest.empty();

const layer = Layer.mergeAll(
  ActionOutputsTest.layer(outputs),
  ActionStateTest.layer(state),
  ActionCacheTest.layer(cache),
  CommandRunnerTest.layer(runner),
  ToolInstallerTest.layer(tools),
);

const config = ConfigProvider.fromMap(new Map([
  ["install-deps", "true"],
  ["additional-lockfiles", ""],
]));

await program.pipe(
  Effect.provide(layer),
  Effect.withConfigProvider(config),
  Effect.runPromise,
);

expect(outputs.outputs.get("node-version")).toBe("24.11.0");
expect(cache.restoreCalls).toHaveLength(1);
expect(runner.calls.map((c) => c.cmd)).toContain("pnpm");
```

Coverage thresholds and the `vitest.config.ts` (which uses `VitestConfig.create()` from `@savvy-web/vitest`) are unchanged.

## Build, dependencies, configs

### `package.json`

- **Drop** `fast-glob` direct dep — replaced by `GlobLive` + `Glob.hashFiles`.
- **Keep** `jsonc-effect` — used for Biome config detection; no library equivalent.
- **Align** `devEngines.packageManager.version`: `10.34.0` → `10.33.4` to match references.
- **Add scripts** to match references (if missing): `test:coverage`, `test:watch`. Verify `lint:md`, `lint:md:fix` present.

### `action.config.ts`, `tsconfig.json`, `biome.jsonc`, `vitest.config.ts`

No changes — all four already canonical.

### `turbo.json`

Verify `inputs` glob `src/**` still covers new subdirs (`services/`, `layers/`, `errors/`, `schemas/`). No edits expected.

### CI workflows

No changes to `release.yml`, `release-sync.yml`, `test.yml`, or any other workflow.

### `dist/` and `.github/actions/local/dist/`

Stale (Mar 25–26, 2024). Rebuild via `pnpm build` at the end of the migration — regenerates both.

## CLAUDE.md updates

### Root `CLAUDE.md`

- Add **Dogfooding First-Party Dependencies** section (verbatim from the prompt, scoped to this action's two first-party deps):

  | Package | Repo | Local checkout |
  | ------- | ---- | -------------- |
  | `@savvy-web/github-action-effects` | `savvy-web/github-action-effects` | `../github-action-effects` |
  | `@savvy-web/github-action-builder` | `savvy-web/github-action-builder` | `../github-action-builder` |

  Both are direct-only dependencies of this action with no transitive duplication path, so `pnpm link ../<repo>` is the linking mechanism for either. The `pnpm-workspace.yaml` `overrides` mechanism described in the broader org procedure is not needed here unless a future first-party transitive dependency is introduced.

- Add **Development & Release Cycle** section (verbatim).
- Update **Project Structure** tree to reflect new layout.
- Remove references to `src/emoji.ts`, custom multiline parsing, `Context.GenericTag`.
- Update **Technical stack** to mention `Step.*`, `GithubMarkdown`, library `*Test` layers.

### `src/CLAUDE.md`

- Document the `main.ts` / `program.ts` / `layers/app.ts` / `services/` split.
- Document `Step.groupStep` usage convention.
- Before/after example for inputs: `Config.string + split` → `ActionInput.multiline`.

### `__test__/CLAUDE.md`

- **Delete** (or move guidance into `src/CLAUDE.md`). After migration, `__test__/` holds only `integration/` if any cross-cutting tests survive.

### Design docs (`.claude/design/workflow-runtime-action/`)

Seven files. Update each via the `design-docs:design-doc-agent` agent in a single sync pass at the end of implementation:

- `architecture.md` — new `program.ts` / `layers/app.ts` split.
- `effect-service-model.md` — `Schema.TaggedError`, `Context.Tag` class, `Step.*`.
- `runtime-installation.md` — `RuntimeInstaller` now in `src/services/`, class-based tag.
- `caching-strategy.md` — `GlobLive`/`Glob.hashFiles` replaces `fast-glob`.
- `build-and-distribution.md` — no semantic changes; verify paths.
- `testing-strategy.md` — library `*Test` layers, co-located test pattern.
- `INDEX.md` — refresh completeness percentages and last-synced date.

## Sequencing

Single bundled PR on `dev` branch. Order of work within the migration:

1. New file layout (move, rename, no behavior changes yet).
2. Errors → `Schema.TaggedError` with getters.
3. State → `Schema.Class` + `STATE_KEYS`.
4. `RuntimeInstaller` → `Context.Tag` class; define `RuntimeInstallerTest`.
5. Test migration to library `<Service>Test` layers (largest single chunk).
6. Inputs → `ActionInput.multiline` + `ActionInput.boolean`.
7. Logging → `Step.groupStep` / `Step.withStep` / `Step.success`.
8. Markdown → `GithubMarkdown.*`; delete `src/emoji.ts` + test.
9. Drop `fast-glob`; add `GlobLive`; switch lockfile hashing to `Glob.hashFiles`.
10. Split `main.ts` → `main.ts` + `program.ts` + `layers/app.ts`.
11. `post.ts` → wrap in `Effect.catchAllDefect`; use `CacheState` from `state.ts`.
12. Align pnpm version `10.34.0` → `10.33.4`; verify scripts.
13. `pnpm build` to refresh `dist/` and `.github/actions/local/dist/`.
14. Update `CLAUDE.md` (root, `src/`, delete `__test__/CLAUDE.md`).
15. Sync `.claude/design/workflow-runtime-action/*.md` via design-doc agent.
16. Create changeset describing the standardization.

## Risks and trade-offs

- **Test migration scope.** ~140 KB of test code touches every service. Risk is overwriting working assertions with a subtly different mocking surface. Mitigation: migrate one test file at a time, keep the test count + name list visible, run `pnpm test` after each file.
- **`Step.*` log shape change.** GitHub Actions log output will look different — collapsed groups, summary lines, buffered debug. CI consumers that grep log text may break. Mitigation: this action is consumed by workflows that grep *outputs*, not logs; outputs are unchanged.
- **`GlobLive` semantic parity with `fast-glob`.** `Glob.hashFiles` is documented as v1-parity with `@actions/glob.hashFiles`. Need to verify the cache-key hash format stays stable across the switch, or accept a one-time cache invalidation. Mitigation: compare hashes for the same lockfile set before/after via a temporary debug log; if they differ, document as a known one-shot invalidation in the changeset.
- **Stale `.github/actions/local/dist/`.** Workflows in `.github/workflows/test.yml` reference `./.github/actions/local`. After rebuild, behavior may change because the local dist becomes current for the first time in ~14 months. Mitigation: run `pnpm test` and the local fixture workflows after rebuild to confirm green.
- **Bigger PR.** Single bundled change is large. Mitigation: order within the migration is risk-graded; the test-layer migration (step 5) gates the rest, so if it breaks down we stop and reassess before touching logging/markdown/inputs.

## Acceptance criteria

- `pnpm typecheck` passes.
- `pnpm test` passes; coverage thresholds met.
- `pnpm lint` passes.
- `pnpm build` succeeds; `dist/main.js`, `dist/post.js`, `dist/package.json`, and `.github/actions/local/dist/*` are regenerated and committed.
- No `src/emoji.ts`, no `src/utils/`, no `fast-glob` in `package.json`.
- No `Context.GenericTag` in source.
- No `Data.TaggedError` in source.
- All test files in `src/**/*.test.ts` (plus optional `__test__/integration/`).
- Root `CLAUDE.md` includes Dogfooding + Dev Cycle sections.
- All `.claude/design/workflow-runtime-action/*.md` files synced and last-synced date refreshed.
- Changeset present in `.changeset/` describing the standardization.
- A workflow run on `dev` exercises the rebuilt action against `.github/actions/local` and reports green.
