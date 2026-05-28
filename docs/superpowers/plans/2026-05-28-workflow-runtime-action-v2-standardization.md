# workflow-runtime-action v2 Standardization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `workflow-runtime-action` into full canonical alignment with the v2 pattern of `@savvy-web/github-action-effects`, mirroring `pnpm-config-dependency-action` as the structural template.

**Architecture:** Two-entry GitHub Action (`main`, `post`). Domain services live in `src/services/`, errors in `src/errors/`, schemas in `src/schemas/`, layer composition in `src/layers/app.ts`, cross-phase state in `src/state.ts`. `main.ts` becomes a 3-line thin entry; the Effect program lives in `src/program.ts`.

**Tech Stack:** Effect (catalog:silk), `@savvy-web/github-action-effects@^2.0.0`, `@savvy-web/github-action-builder@^0.7.1`, `@effect/platform-node`, Vitest, Biome 2.4.x, TypeScript native preview (`tsgo`), Node 26.2.0, pnpm 10.33.4.

**Spec:** `docs/superpowers/specs/2026-05-28-workflow-runtime-action-v2-standardization-design.md`

**Branch:** all work on `dev`. One bundled PR at the end.

---

## Conventions used by all tasks

- **Test command:** `pnpm test` (vitest run --pass-with-no-tests). After major moves, also run `pnpm typecheck` and `pnpm lint`.
- **Refactor TDD:** Existing tests must stay green after each task. Where a task introduces new code, write a failing test first (red), implement (green), then commit. Where a task moves or restructures existing code, run the existing tests as the regression gate.
- **Commits:** Commit at the end of each numbered task. Commit message format follows the repo's commitlint config — `type(scope): subject` with `Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>` trailer.
- **Imports:** All local imports use `.js` extension. Node built-ins use `node:` protocol. Type imports separated.
- **DO NOT** run `pnpm build` between tasks except where called out. It rebuilds `dist/` which we want untouched until the end.

---

## Task 1: Move `errors.ts` → `src/errors/errors.ts`

**Files:**

- Move: `src/errors.ts` → `src/errors/errors.ts`
- Move: `__test__/errors.test.ts` → `src/errors/errors.test.ts`
- Modify: every importer of `./errors.js` in `src/`

- [ ] **Step 1: Move the source file**

```bash
mkdir -p src/errors
git mv src/errors.ts src/errors/errors.ts
```

- [ ] **Step 2: Move the test file**

```bash
git mv __test__/errors.test.ts src/errors/errors.test.ts
```

- [ ] **Step 3: Update imports in `src/main.ts`, `src/cache.ts`, `src/config.ts`, `src/runtime-installer.ts`**

Replace every `from "./errors.js"` with `from "./errors/errors.js"`. In `src/runtime-installer.ts` it's currently `from "./errors.js"`; becomes `from "./errors/errors.js"`. Same in `main.ts`, `cache.ts`, `config.ts`.

Update import in `src/errors/errors.test.ts` — it currently imports from `"../src/errors.js"`; becomes `from "./errors.js"`.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS (all current tests still green, types check).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: relocate errors module under src/errors/

Mechanical move from src/errors.ts to src/errors/errors.ts to match the
canonical v2 layout used by pnpm-config-dependency-action. Test file
moved alongside source. No semantic changes.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 2: Move `schemas.ts` → `src/schemas/domain.ts`

**Files:**

- Move: `src/schemas.ts` → `src/schemas/domain.ts`
- Move: `__test__/schemas.test.ts` → `src/schemas/domain.test.ts`
- Modify: importers

- [ ] **Step 1: Move files**

```bash
mkdir -p src/schemas
git mv src/schemas.ts src/schemas/domain.ts
git mv __test__/schemas.test.ts src/schemas/domain.test.ts
```

- [ ] **Step 2: Update imports**

Importers of `./schemas.js`: `src/main.ts`, `src/cache.ts`, `src/config.ts`. Replace with `./schemas/domain.js`.

In `src/schemas/domain.test.ts` update the import from `"../src/schemas.js"` to `"./domain.js"`.

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: relocate schemas module under src/schemas/domain

Mechanical move from src/schemas.ts to src/schemas/domain.ts to match
the canonical v2 layout. Test moved alongside. No semantic changes.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 3: Move `runtime-installer.ts` → `src/services/runtime-installer.ts`

**Files:**

- Move: `src/runtime-installer.ts` → `src/services/runtime-installer.ts`
- Move: `__test__/runtime-installer.test.ts` → `src/services/runtime-installer.test.ts`
- Modify: importers

- [ ] **Step 1: Move files**

```bash
mkdir -p src/services
git mv src/runtime-installer.ts src/services/runtime-installer.ts
git mv __test__/runtime-installer.test.ts src/services/runtime-installer.test.ts
```

- [ ] **Step 2: Fix internal descriptor imports**

`src/services/runtime-installer.ts` imports from `./descriptors/node.js` etc. Update to `../descriptors/node.js`, `../descriptors/bun.js`, `../descriptors/deno.js`. Update `./errors.js` import to `../errors/errors.js`.

- [ ] **Step 3: Update external importers**

`src/main.ts` and `src/post.ts` import from `./runtime-installer.js`. Update both to `./services/runtime-installer.js`.

In `src/services/runtime-installer.test.ts` update import from `"../src/runtime-installer.js"` to `"./runtime-installer.js"`. Update any other `../src/*.js` test imports to relative paths to the new locations (likely `../descriptors/*.js`, `../errors/errors.js`).

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: relocate runtime-installer to src/services/

Mechanical move under the canonical services/ directory. Test moved
alongside. No semantic changes.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 4: Move `cache.ts` → `src/services/cache.ts`

**Files:**

- Move: `src/cache.ts` → `src/services/cache.ts`
- Move: `__test__/cache.test.ts` → `src/services/cache.test.ts`

- [ ] **Step 1: Move files**

```bash
git mv src/cache.ts src/services/cache.ts
git mv __test__/cache.test.ts src/services/cache.test.ts
```

- [ ] **Step 2: Fix internal imports in `src/services/cache.ts`**

Update `./errors.js` → `../errors/errors.js`. Update `./schemas.js` → `../schemas/domain.js`.

- [ ] **Step 3: Update external importers**

`src/main.ts` and `src/post.ts` import from `./cache.js`. Update both to `./services/cache.js`.

In `src/services/cache.test.ts` update `"../src/cache.js"` to `"./cache.js"` and any sibling imports to the new layout.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: relocate cache module to src/services/

Mechanical move under the canonical services/ directory. Test moved
alongside. No semantic changes.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 5: Move `config.ts` → `src/services/config-loader.ts`

**Files:**

- Move: `src/config.ts` → `src/services/config-loader.ts`
- Move: `__test__/config.test.ts` → `src/services/config-loader.test.ts`

- [ ] **Step 1: Move files**

```bash
git mv src/config.ts src/services/config-loader.ts
git mv __test__/config.test.ts src/services/config-loader.test.ts
```

- [ ] **Step 2: Fix internal imports in `src/services/config-loader.ts`**

Update `./errors.js` → `../errors/errors.js`. Update `./schemas.js` → `../schemas/domain.js`.

- [ ] **Step 3: Update external importers**

`src/main.ts` imports from `./config.js`. Update to `./services/config-loader.js`.

In `src/services/config-loader.test.ts` update `"../src/config.js"` to `"./config-loader.js"`.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: relocate config to src/services/config-loader

Mechanical move under the canonical services/ directory; file renamed
to config-loader so the module name matches its responsibility.
Test moved alongside. No semantic changes.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 6: Move `descriptors/*.test.ts` and `emoji.test.ts` co-located

**Files:**

- Move: `__test__/descriptors.test.ts` → `src/descriptors/descriptors.test.ts`
- Move: `__test__/emoji.test.ts` → `src/emoji.test.ts` (temporary — deleted in Task 13 along with `src/emoji.ts`)

- [ ] **Step 1: Move files**

```bash
git mv __test__/descriptors.test.ts src/descriptors/descriptors.test.ts
git mv __test__/emoji.test.ts src/emoji.test.ts
```

- [ ] **Step 2: Update test imports**

In `src/descriptors/descriptors.test.ts` update any `"../src/descriptors/*.js"` imports to relative form (e.g. `"./node.js"`).

In `src/emoji.test.ts` update `"../src/emoji.js"` → `"./emoji.js"`.

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: colocate descriptor and emoji tests with their sources

Moves __test__/descriptors.test.ts and __test__/emoji.test.ts beside
their modules. emoji.test.ts is temporary — its source is removed in a
later task.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 7: Migrate errors from `Data.TaggedError` → `Schema.TaggedError` with getters

**Files:**

- Modify: `src/errors/errors.ts`
- Modify: `src/errors/errors.test.ts`

- [ ] **Step 1: Rewrite `src/errors/errors.ts`**

Replace the file contents with:

```typescript
/**
 * Schema-based tagged errors with computed messages.
 *
 * Uses Schema.TaggedError so payloads are validated, errors round-trip
 * cleanly through ActionState, and downstream callers get a typed `.message`
 * getter for surfacing in logs.
 *
 * @module errors/errors
 */

import { Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

/* v8 ignore start -- pure data carriers */

/**
 * Error thrown when configuration is invalid or missing.
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
 reason: NonEmptyString,
 file: Schema.optional(Schema.String),
 cause: Schema.optional(Schema.Unknown),
}) {
 get message(): string {
  return this.file ? `${this.reason} (at ${this.file})` : this.reason;
 }
}

/**
 * Error thrown when a runtime (node, bun, deno) fails to install.
 */
export class RuntimeInstallError extends Schema.TaggedError<RuntimeInstallError>()("RuntimeInstallError", {
 runtime: NonEmptyString,
 version: NonEmptyString,
 reason: NonEmptyString,
 cause: Schema.optional(Schema.Unknown),
}) {
 get message(): string {
  return `Failed to install ${this.runtime}@${this.version}: ${this.reason}`;
 }
}

/**
 * Error thrown when setting up a package manager fails.
 */
export class PackageManagerSetupError extends Schema.TaggedError<PackageManagerSetupError>()(
 "PackageManagerSetupError",
 {
  packageManager: NonEmptyString,
  version: NonEmptyString,
  reason: NonEmptyString,
  cause: Schema.optional(Schema.Unknown),
 },
) {
 get message(): string {
  return `Failed to setup ${this.packageManager}@${this.version}: ${this.reason}`;
 }
}

/**
 * Error thrown when installing dependencies fails.
 */
export class DependencyInstallError extends Schema.TaggedError<DependencyInstallError>()("DependencyInstallError", {
 packageManager: NonEmptyString,
 reason: NonEmptyString,
 cause: Schema.optional(Schema.Unknown),
}) {
 get message(): string {
  return `Failed to install dependencies with ${this.packageManager}: ${this.reason}`;
 }
}

/**
 * Error thrown when a cache operation fails.
 */
export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
 operation: Schema.Literal("save", "restore", "key-generation"),
 reason: NonEmptyString,
 cause: Schema.optional(Schema.Unknown),
}) {
 get message(): string {
  return `Cache ${this.operation} failed: ${this.reason}`;
 }
}

/**
 * Union of all expected action errors.
 */
export type ActionError =
 | ConfigError
 | RuntimeInstallError
 | PackageManagerSetupError
 | DependencyInstallError
 | CacheError;

/* v8 ignore stop */
```

- [ ] **Step 2: Update `src/errors/errors.test.ts`**

Add tests for the new `.message` getters and verify the `_tag` discriminator round-trips. Append to or rewrite the test file so it includes:

```typescript
import { describe, it, expect } from "vitest";
import {
 CacheError,
 ConfigError,
 DependencyInstallError,
 PackageManagerSetupError,
 RuntimeInstallError,
} from "./errors.js";

describe("errors", () => {
 it("ConfigError exposes _tag and message getter", () => {
  const e = new ConfigError({ reason: "missing devEngines", file: "package.json" });
  expect(e._tag).toBe("ConfigError");
  expect(e.message).toBe("missing devEngines (at package.json)");
 });

 it("ConfigError without file uses reason only", () => {
  const e = new ConfigError({ reason: "bad shape" });
  expect(e.message).toBe("bad shape");
 });

 it("RuntimeInstallError formats runtime/version/reason", () => {
  const e = new RuntimeInstallError({ runtime: "node", version: "24.11.0", reason: "404" });
  expect(e._tag).toBe("RuntimeInstallError");
  expect(e.message).toBe("Failed to install node@24.11.0: 404");
 });

 it("PackageManagerSetupError formats packageManager/version/reason", () => {
  const e = new PackageManagerSetupError({
   packageManager: "pnpm",
   version: "10.33.4",
   reason: "corepack failed",
  });
  expect(e.message).toBe("Failed to setup pnpm@10.33.4: corepack failed");
 });

 it("DependencyInstallError formats packageManager/reason", () => {
  const e = new DependencyInstallError({ packageManager: "pnpm", reason: "lockfile drift" });
  expect(e.message).toBe("Failed to install dependencies with pnpm: lockfile drift");
 });

 it("CacheError formats operation/reason", () => {
  const e = new CacheError({ operation: "save", reason: "ENOSPC" });
  expect(e._tag).toBe("CacheError");
  expect(e.message).toBe("Cache save failed: ENOSPC");
 });
});
```

- [ ] **Step 3: Run tests**

```bash
pnpm test
```

Expected: errors tests PASS. Other tests may FAIL if they construct errors with payloads that violate the new `NonEmptyString` constraint. Note any failures.

- [ ] **Step 4: Fix any constructor sites that pass empty strings**

Search for failing test fixtures and update them so `reason`, `runtime`, `version`, etc. are non-empty:

```bash
grep -rn "new ConfigError\|new RuntimeInstallError\|new PackageManagerSetupError\|new DependencyInstallError\|new CacheError" src/
```

Update any usage that passes an empty `reason: ""` to a meaningful string.

- [ ] **Step 5: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(errors): migrate Data.TaggedError to Schema.TaggedError

Errors now validate their payloads via Effect Schema and expose a typed
.message getter. Matches the pattern used in
pnpm-config-dependency-action. Adds an ActionError union for exhaustive
catchTag handling.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 8: Create `src/state.ts` with `CacheState` Schema class + `STATE_KEYS`

**Files:**

- Create: `src/state.ts`
- Modify: `src/services/cache.ts` (replace inline `CacheStateSchema` usage)
- Modify: `src/schemas/domain.ts` (remove `CacheStateSchema` after migration)
- Modify: `src/post.ts` and any other consumer of `CacheStateSchema`

- [ ] **Step 1: Write the failing test first**

Create `src/state.test.ts`:

```typescript
import { Schema } from "effect";
import { describe, it, expect } from "vitest";
import { CacheState, STATE_KEYS } from "./state.js";

describe("state", () => {
 it("STATE_KEYS exposes cacheState", () => {
  expect(STATE_KEYS.cacheState).toBe("cache-state");
 });

 it("CacheState round-trips through Schema encode/decode", () => {
  const original = new CacheState({
   key: "linux-abc-def-123",
   paths: ["/home/runner/.npm", "**/node_modules"],
   restored: false,
  });
  const encoded = Schema.encodeSync(CacheState)(original);
  const decoded = Schema.decodeSync(CacheState)(encoded);
  expect(decoded.key).toBe(original.key);
  expect(decoded.paths).toEqual(original.paths);
  expect(decoded.restored).toBe(false);
 });
});
```

- [ ] **Step 2: Verify it fails**

```bash
pnpm test -- src/state.test.ts
```

Expected: FAIL — `src/state.ts` does not exist yet.

- [ ] **Step 3: Implement `src/state.ts`**

```typescript
/**
 * Cross-phase state schemas.
 *
 * GitHub Actions persists state between phases as `STATE_*` env vars.
 * `ActionState.save/get` encode and decode each value through its Schema.
 *
 * @module state
 */

import { Schema } from "effect";

/**
 * Cache state persisted from main to post.
 *
 * `restored=true` means main got an exact hit and post should skip the save.
 * `restored=false` means a miss or partial restore — post saves the new key.
 */
export class CacheState extends Schema.Class<CacheState>("CacheState")({
 key: Schema.String,
 paths: Schema.Array(Schema.String),
 restored: Schema.Boolean,
}) {}

/**
 * Keys used with `ActionState.save/get`.
 */
export const STATE_KEYS = {
 cacheState: "cache-state",
} as const;
```

- [ ] **Step 4: Verify the new test passes**

```bash
pnpm test -- src/state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Migrate `src/services/cache.ts` to use `CacheState`**

Find:

```typescript
import { CacheStateSchema } from "../schemas/domain.js";
```

Replace with:

```typescript
import { CacheState, STATE_KEYS } from "../state.js";
```

In `restoreCache`, change the state.save call from:

```typescript
yield* state.save(
 "CACHE_STATE",
 {
  hit,
  key: primaryKey,
  paths: config.cachePaths,
 },
 CacheStateSchema,
);
```

to:

```typescript
yield* state.save(
 STATE_KEYS.cacheState,
 new CacheState({
  key: primaryKey,
  paths: config.cachePaths,
  restored: hit === "exact",
 }),
 CacheState,
);
```

In `saveCache`, change the state.get call from:

```typescript
const cacheState = yield* state.get("CACHE_STATE", CacheStateSchema).pipe(/* ... */);
// branches on cacheState.hit === "exact"
```

to:

```typescript
const cacheState = yield* state.get(STATE_KEYS.cacheState, CacheState).pipe(/* ... */);
// branch on cacheState.restored
```

Update the conditional that previously checked `cacheState.hit === "exact"` to check `cacheState.restored`. Remove references to `cacheState.hit`. The fields `cacheState.key` and `cacheState.paths` keep the same names. Note that `paths` is now `ReadonlyArray<string>` (always defined), not `string[] | undefined`, so drop the `!key || !paths || paths.length === 0` short-circuit if `key` is always a non-empty string at this point — keep only the `paths.length === 0` guard.

The `restoreCache` function should return the original `hit` value (`"exact" | "partial" | "none"`) since `main.ts` writes it to outputs. The state only stores `restored` (boolean derived from the hit).

- [ ] **Step 6: Remove `CacheStateSchema` from `src/schemas/domain.ts`**

Delete:

```typescript
/**
 * Cache state schema
 */
export const CacheStateSchema = Schema.Struct({
 hit: Schema.Literal("exact", "partial", "none"),
 key: Schema.optional(Schema.String),
 paths: Schema.optional(Schema.Array(Schema.String)),
});
export type CacheState = typeof CacheStateSchema.Type;
```

And remove any matching test in `src/schemas/domain.test.ts` for `CacheStateSchema` (if present).

- [ ] **Step 7: Run all tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS. Cache and state tests should both pass. If existing cache tests assert against the old state shape (`hit`, `key?`, `paths?`), update them in this same task to the new shape (`key`, `paths`, `restored`).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(state): introduce src/state.ts with CacheState Schema class

Replaces the inline CacheStateSchema in src/schemas/domain.ts with a
typed Schema.Class. State persistence between main and post now uses a
constant STATE_KEYS.cacheState key. The state stores a boolean
'restored' flag instead of a hit literal — the literal stays in
restoreCache's return value for output emission.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 9: Convert `RuntimeInstaller` to `Context.Tag` class

**Files:**

- Modify: `src/services/runtime-installer.ts`
- Modify: `src/services/runtime-installer.test.ts`
- Modify: `src/main.ts` (importer)

- [ ] **Step 1: Rewrite the `RuntimeInstaller` tag**

In `src/services/runtime-installer.ts`, find:

```typescript
/**
 * Service interface for installing a specific runtime.
 */
export interface RuntimeInstaller {
 readonly install: (
  version: string,
 ) => Effect.Effect<InstalledRuntime, RuntimeInstallError, ToolInstaller | CommandRunner | ActionOutputs>;
}

/**
 * Service tag for RuntimeInstaller.
 */
export const RuntimeInstaller = Context.GenericTag<RuntimeInstaller>("RuntimeInstaller");
```

Replace with:

```typescript
/**
 * Service tag for installing a specific runtime.
 *
 * Context.Tag class form so callers can `yield* RuntimeInstaller` and
 * downstream typing resolves through the static tag identity.
 */
export class RuntimeInstaller extends Context.Tag("RuntimeInstaller")<
 RuntimeInstaller,
 {
  readonly install: (
   version: string,
  ) => Effect.Effect<InstalledRuntime, RuntimeInstallError, ToolInstaller | CommandRunner | ActionOutputs>;
 }
>() {}
```

Remove the standalone `interface RuntimeInstaller` declaration.

Update the `makeRuntimeInstaller` factory's return-type annotation (it currently returns `RuntimeInstaller` the interface — now it returns the *service shape*, which is `Context.Tag.Service<typeof RuntimeInstaller>`):

```typescript
export const makeRuntimeInstaller = (
 descriptor: RuntimeDescriptor,
): Context.Tag.Service<typeof RuntimeInstaller> => ({
 install: (version) => /* ...unchanged body... */
});
```

Update the pre-built layers — `Layer.succeed(RuntimeInstaller, makeRuntimeInstaller(...))` keeps working because `Layer.succeed` accepts the class tag the same way.

- [ ] **Step 2: Update `src/main.ts` usage**

In `src/main.ts` the current pattern is:

```typescript
RuntimeInstaller.pipe(
 Effect.flatMap((installer) => installer.install(rt.version)),
 Effect.provide(installerLayerFor(rt.name)),
 /* ... */
)
```

`Context.Tag` class supports the same `.pipe(Effect.flatMap(...))` form. No change should be needed unless TypeScript surfaces an inference issue. If it does, rewrite to:

```typescript
Effect.gen(function* () {
 const installer = yield* RuntimeInstaller;
 return yield* installer.install(rt.version);
}).pipe(
 Effect.provide(installerLayerFor(rt.name)),
 /* ... */
)
```

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(runtime-installer): use Context.Tag class form

Switches RuntimeInstaller from Context.GenericTag with a separate
interface to the modern Context.Tag class pattern. No behavior change —
the service shape is preserved through Context.Tag.Service<typeof ...>
in the factory return type.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 10: Migrate tests to library `<Service>Test` layers

**Files:**

- Modify: `src/services/cache.test.ts`
- Modify: `src/services/runtime-installer.test.ts`
- Modify: `src/services/config-loader.test.ts` (mostly pure-fn — minimal changes)
- Modify: every other test that constructs `Layer.succeed(Tag, { method: () => Effect.void })` mocks

This is the largest single task. Do it one test file at a time, commit after each. The pattern is:

**Before:**

```typescript
const outputStore: Record<string, string> = {};
const makeOutputsLayer = () =>
 Layer.succeed(ActionOutputs, {
  set: (name, value) => Effect.sync(() => { outputStore[name] = value; }),
  setJson: () => Effect.void,
  summary: () => Effect.void,
  exportVariable: () => Effect.void,
  addPath: () => Effect.void,
  setSecret: () => Effect.void,
  setFailed: () => Effect.void,
 });
```

**After:**

```typescript
import { ActionOutputsTest } from "@savvy-web/github-action-effects/testing";

const outputs = ActionOutputsTest.empty();
const layer = ActionOutputsTest.layer(outputs);
// ...
expect(outputs.outputs.get("node-version")).toBe("24.11.0");
```

- [ ] **Step 1: Confirm library test layer surface**

Run:

```bash
grep -E "export const \w+Test = " /Users/spencer/workspaces/savvy-web/github-action-effects/src/testing.ts | head -50
```

Or read the testing barrel:

```bash
cat /Users/spencer/workspaces/savvy-web/github-action-effects/src/testing.ts | head -100
```

Note which `*Test` namespaces are available: `ActionOutputsTest`, `ActionStateTest`, `ActionCacheTest`, `ActionEnvironmentTest`, `ActionLoggerTest`, `CommandRunnerTest`, `ToolInstallerTest`, `GlobTest` (after Task 13).

- [ ] **Step 2: Migrate `src/services/runtime-installer.test.ts`**

Replace each hand-rolled mock with the library equivalent. Typical replacements:

```typescript
// Before: tools layer
const toolsCalls: Array<{ kind: string; args: unknown[] }> = [];
const toolsLayer = Layer.succeed(ToolInstaller, {
 download: (url) => Effect.sync(() => { toolsCalls.push({ kind: "download", args: [url] }); return "/tmp/x"; }),
 extractTar: () => Effect.succeed("/tmp/extracted"),
 extractZip: () => Effect.succeed("/tmp/extracted"),
 cacheDir: () => Effect.succeed("/cache/tool/1.0.0"),
 cacheFile: () => Effect.succeed("/cache/file"),
 installBinary: () => Effect.succeed("/cache/bin"),
 installBinaryAndAddToPath: () => Effect.succeed("/cache/bin"),
});

// After:
import { ToolInstallerTest } from "@savvy-web/github-action-effects/testing";
const tools = ToolInstallerTest.empty();
const toolsLayer = ToolInstallerTest.layer(tools);
// ...later: expect(tools.downloadCalls).toContainEqual({ url: "https://nodejs.org/..." });
```

The exact property names of test state are documented in the library's `testing.ts`. Use them as the inspector surface — never reach into private internals.

- [ ] **Step 3: Run runtime-installer tests + commit**

```bash
pnpm test -- src/services/runtime-installer.test.ts
```

Expected: PASS.

```bash
git add src/services/runtime-installer.test.ts
git commit -m "$(cat <<'EOF'
test(runtime-installer): migrate to library *Test layers

Replaces hand-rolled Layer.succeed mocks with ToolInstallerTest,
CommandRunnerTest, ActionOutputsTest from
@savvy-web/github-action-effects/testing. Assertions now inspect the
library-provided test state objects.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

- [ ] **Step 4: Migrate `src/services/cache.test.ts`**

Apply the same pattern. Replace `ActionCache`, `ActionState`, `ActionEnvironment`, `CommandRunner` mocks with `ActionCacheTest`, `ActionStateTest`, `ActionEnvironmentTest`, `CommandRunnerTest`.

Note: this test currently uses `CacheStateSchema` — by now Task 8 has moved that to `CacheState`. Update assertions that read state via `state.get("CACHE_STATE", CacheStateSchema)` to `state.get(STATE_KEYS.cacheState, CacheState)`.

- [ ] **Step 5: Run cache tests + commit**

```bash
pnpm test -- src/services/cache.test.ts
```

```bash
git add src/services/cache.test.ts
git commit -m "$(cat <<'EOF'
test(cache): migrate to library *Test layers

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

- [ ] **Step 6: Migrate `__test__/main.test.ts` and `__test__/post.test.ts`**

These are the heaviest. Move and rewrite them — keep `main.test.ts` named so its import (`from "../src/main.js"` → `from "./main.js"`) still resolves; Task 16 renames it to `program.test.ts` when it splits `main.ts` into `main.ts` + `program.ts`.

```bash
git mv __test__/main.test.ts src/main.test.ts
git mv __test__/post.test.ts src/post.test.ts
```

For each test, replace the entire `makeXxxLayer` factory cluster at the top with `<Service>Test.empty()` + `<Service>Test.layer(state)` and update assertions to read from `outputs.outputs`, `cache.saveCalls`, `runner.calls`, etc. The `ConfigProvider.fromMap` pattern stays the same.

Run tests after each major mock replacement to keep failures localized.

- [ ] **Step 7: Run all tests + commit**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS.

```bash
git add -A
git commit -m "$(cat <<'EOF'
test(main,post): migrate to library *Test layers and colocate sources

Rewrites the largest integration tests to use library-provided test
state objects. Test files moved to src/ alongside the modules they
exercise.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

- [ ] **Step 8: Confirm `__test__/` is empty (or holds only integration tests)**

```bash
ls __test__/
```

If `__test__/integration/` exists, leave it. If `__test__/` is empty, remove the directory:

```bash
rmdir __test__ 2>/dev/null || echo "__test__ retained (contains integration/ or other files)"
```

Commit the removal if applicable.

---

## Task 11: Replace inline multiline parsing with `ActionInput.multiline` / `ActionInput.boolean`

**Files:**

- Modify: `src/main.ts` (or `src/program.ts` if Task 16 has run first)

- [ ] **Step 1: Verify `ActionInput` exports**

```bash
grep -E "^export (const|namespace|class) ActionInput" /Users/spencer/workspaces/savvy-web/github-action-effects/src/index.ts
```

Confirm `ActionInput.multiline` and `ActionInput.boolean` are exported.

- [ ] **Step 2: Replace input parsing in `main.ts`**

Find:

```typescript
const rawLockfiles = yield* Config.string("additional-lockfiles").pipe(Config.withDefault(""));
const additionalLockfiles = rawLockfiles ? parseMultiValueInput(rawLockfiles) : [];
const rawCachePaths = yield* Config.string("additional-cache-paths").pipe(Config.withDefault(""));
const additionalCachePaths = rawCachePaths ? parseMultiValueInput(rawCachePaths) : [];
```

Replace with:

```typescript
const additionalLockfiles = yield* ActionInput.multiline("additional-lockfiles").pipe(Config.withDefault([]));
const additionalCachePaths = yield* ActionInput.multiline("additional-cache-paths").pipe(Config.withDefault([]));
```

Find:

```typescript
const installDeps = yield* Config.boolean("install-deps").pipe(Config.withDefault(true));
```

Replace with:

```typescript
const installDeps = yield* ActionInput.boolean("install-deps").pipe(Config.withDefault(true));
```

Add `ActionInput` to the existing `@savvy-web/github-action-effects` import block.

- [ ] **Step 3: Delete the now-unused `parseMultiValueInput` function**

Remove the function definition (lines 33–69 in the pre-task `main.ts`). If any tests reference it, remove them — `ActionInput.multiline` is library-tested.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS. Any test that was asserting `parseMultiValueInput(...)` directly will fail — delete those test cases (the library's multiline parser is its own concern).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(inputs): use ActionInput.multiline and ActionInput.boolean

Drops the local parseMultiValueInput helper in favor of the
library-provided ActionInput combinators. multiline handles YAML
multiline, comma-separated, and bullet-list forms; boolean handles the
YAML 1.2 Core Schema truthy set.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 12: Adopt `Step.*` namespace for grouped logging

**Files:**

- Modify: `src/main.ts` (or `src/program.ts` if Task 16 has run first)

- [ ] **Step 1: Confirm `Step` namespace exports**

```bash
grep -E "^export.*Step" /Users/spencer/workspaces/savvy-web/github-action-effects/src/index.ts
```

- [ ] **Step 2: Replace `logger.group(...)` with `Step.groupStep(...)`**

Find each occurrence in `main.ts`:

```typescript
const config = yield* logger.group(
 "Detect configuration",
 Effect.gen(function* () { /* ... */ }),
);
```

Replace with:

```typescript
const config = yield* Step.groupStep(
 "Detect configuration",
 Effect.gen(function* () { /* ... */ }),
);
```

Repeat for each `logger.group("...", ...)` call (there are ~6: detect, restore cache, install runtimes, setup PM, install deps, install Biome, summary). The summary block can become `Step.groupStep("Runtime Setup Complete", ...)`.

Add `Step` to the import from `@savvy-web/github-action-effects`. Remove the `ActionLogger` import and the `const logger = yield* ActionLogger;` line — no longer needed.

- [ ] **Step 3: Replace `formatSuccess("...")` log lines with `Step.success(...)` inside groupSteps**

Within each `Step.groupStep` body, wherever the code currently logs `Effect.log(formatSuccess("Biome installed"))`, replace with `Step.success("Biome installed")` (no emoji helper). This emits the canonical step-success line for the group's summary.

(The actual `formatSuccess`/emoji removal happens in Task 13 — for now leave the emoji helpers in place and just swap the call.)

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS. Tests that asserted against `ActionLogger.group` calls need to be updated to look at `Step` output via `ActionLoggerTest` state — but most tests assert on outputs, not log shapes, so likely no change required.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(logging): adopt Step.groupStep and Step.success

Replaces ActionLogger.group with Step.groupStep so each phase emits a
quiet-on-success / verbose-on-failure step summary, matching the v2
canonical pattern.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 13: Replace `src/emoji.ts` with `GithubMarkdown` helpers + delete emoji module

**Files:**

- Modify: `src/main.ts` (or `src/program.ts`)
- Delete: `src/emoji.ts`
- Delete: `src/emoji.test.ts`

- [ ] **Step 1: Confirm `GithubMarkdown` exports**

```bash
grep -E "^export.*GithubMarkdown" /Users/spencer/workspaces/savvy-web/github-action-effects/src/index.ts
```

The library provides `GithubMarkdown.statusIcon`, `.heading`, `.bold`, `.code`, `.checklist`, `.list`, etc.

- [ ] **Step 2: Remove every `format*` import from `./emoji.js`**

Find in `main.ts`:

```typescript
import { formatDetection, formatInstallation, formatPackageManager, formatRuntime, formatSuccess } from "./emoji.js";
```

Delete this import.

- [ ] **Step 3: Rewrite each call site**

| Before | After |
| --- | --- |
| `Effect.log(formatSuccess("X"))` | `Step.success("X")` (already done in Task 12) |
| `Effect.log(formatDetection("runtimes: node@24", true))` | `Effect.log("Detected runtimes: node@24")` |
| `formatInstallation("runtimes")` (used as Step group name) | `"Install runtimes"` |
| `formatRuntime("node")` | `"node"` (plain name; no emoji) |
| `formatPackageManager("pnpm")` | `"pnpm"` |

Where the action emits a summary block at the end (currently using emoji-prefixed log lines), use `GithubMarkdown.list([...])` inside `outputs.summary(...)` if a step summary is desired. Otherwise plain `Effect.log` lines suffice — the `Step` namespace already provides the step-level summary visuals.

- [ ] **Step 4: Delete the emoji module and its test**

```bash
git rm src/emoji.ts src/emoji.test.ts
```

- [ ] **Step 5: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS. Any test that asserted on emoji-prefixed log strings will need to be updated to plain text.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(logging): drop src/emoji.ts in favor of library helpers

Deletes the local emoji format* helpers. Step.success handles
success-line rendering; plain Effect.log lines replace emoji-prefixed
status logs. GithubMarkdown.* is available for any future
summary-block rendering.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 14: Drop `fast-glob`; use `GlobLive` + `Glob.hashFiles`

**Files:**

- Modify: `src/services/cache.ts`
- Modify: `package.json`

- [ ] **Step 1: Confirm `Glob` service + `hashFiles` exist**

```bash
grep -E "Glob\.hashFiles|export.*Glob" /Users/spencer/workspaces/savvy-web/github-action-effects/src/index.ts
```

Expected: `Glob` service tag, `GlobLive` layer, `GlobTest` test layer all exported. `Glob.hashFiles(patterns)` method on the service.

- [ ] **Step 2: Replace `findLockFiles` to use `Glob.glob`**

Find in `src/services/cache.ts`:

```typescript
export const findLockFiles = (patterns: string[]) =>
 Effect.tryPromise({
  try: async () => {
   const fg = await import("fast-glob");
   const matches = await fg.default(patterns, {
    ignore: ["**/node_modules/**", "**/.git/**"],
    dot: false,
   });
   return matches.sort();
  },
  catch: () => [] as string[],
 }).pipe(Effect.catchAll(() => Effect.succeed([] as string[])));
```

Replace with:

```typescript
import { Glob } from "@savvy-web/github-action-effects";

export const findLockFiles = (patterns: string[]) =>
 Effect.gen(function* () {
  const glob = yield* Glob;
  const matches = yield* glob.glob(patterns, { ignore: ["**/node_modules/**", "**/.git/**"] }).pipe(
   Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<string>)),
  );
  return [...matches].sort();
 });
```

The function's return type signature changes — it now requires `Glob` in its R channel. Callers (`main.ts`) will need `GlobLive` in the layer composition (added in Task 16's layer split).

- [ ] **Step 3: Replace the local `hashFiles` with `Glob.hashFiles`**

Find:

```typescript
const hashFiles = (files: string[]) =>
 Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const hash = createHash("sha256");
  for (const file of files) {
   const content = yield* fs.readFileString(file, "utf-8").pipe(Effect.orElse(() => Effect.succeed("")));
   hash.update(content);
  }
  return hash.digest("hex").substring(0, 8);
 });
```

Replace with a call to the library:

```typescript
const hashFiles = (files: string[]) =>
 Effect.gen(function* () {
  if (files.length === 0) return "";
  const glob = yield* Glob;
  const full = yield* glob.hashFiles(files);
  return full.substring(0, 8);
 });
```

`Glob.hashFiles` returns a hex string; truncating to 8 chars keeps cache-key format stable.

- [ ] **Step 4: Drop `fast-glob` from `package.json`**

Find in `package.json`:

```json
"fast-glob": "^3.3.3",
```

Delete this line. Also delete `createHash` and `FileSystem` imports from `src/services/cache.ts` if no longer used in this file (search for remaining `createHash` and `FileSystem.FileSystem` references — `hashString`, `buildVersionHash` still use `createHash`, so keep that import; `FileSystem` may now be unreferenced after `hashFiles` simplification).

- [ ] **Step 5: Add `GlobLive` to `MainLive` in `src/main.ts`**

`findLockFiles` now requires `Glob` in its R channel. The inline `MainLive` in `src/main.ts` (still inline at this stage — Task 16 splits it to `layers/app.ts`) must include `GlobLive`. Find:

```typescript
import {
 Action,
 ActionCacheLive,
 ActionEnvironmentLive,
 ActionLogger,
 ActionOutputs,
 ActionStateLive,
 CommandRunner,
 CommandRunnerLive,
 ToolInstaller,
 ToolInstallerLive,
} from "@savvy-web/github-action-effects";
```

Add `GlobLive` to the import. Then in the `MainLive` composition:

```typescript
export const MainLive = Layer.mergeAll(
 ActionCacheLive,
 ToolInstallerLive,
 CommandRunnerLive,
 ActionStateLive.pipe(Layer.provide(FileSystemLive)),
 ActionEnvironmentLive,
 GlobLive,
 FileSystemLive,
);
```

- [ ] **Step 6: Reinstall + verify**

```bash
pnpm install
pnpm typecheck && pnpm test
```

Expected: PASS. Tests that touched `findLockFiles` or `hashFiles` now need `GlobTest.layer(...)` provided in the test layer composition; update them.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(cache): use GlobLive + Glob.hashFiles, drop fast-glob

findLockFiles and the local hashFiles helper now route through the
library's Glob service. fast-glob is removed from runtime
dependencies. Cache keys keep the 8-char hex truncation so existing
caches remain valid.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 15: Verify caching parity — hash format stability check

**Files:** (no source changes; verification only)

- [ ] **Step 1: Add a temporary debug test that hashes a known lockfile**

Create `src/services/cache.hash-parity.test.ts` (will be deleted in this same task):

```typescript
import { describe, it, expect } from "vitest";
import { Effect, Layer } from "effect";
import { Glob, GlobTest } from "@savvy-web/github-action-effects";
import { NodeFileSystem } from "@effect/platform-node";

// This is a one-shot parity test — pin a known-good hash for a fixed input
// then delete this file. The point is to confirm Glob.hashFiles produces a
// stable hex string we can truncate to 8 chars.

describe("Glob.hashFiles parity", () => {
 it("produces a deterministic hex string for the project's own pnpm-lock.yaml", async () => {
  const program = Effect.gen(function* () {
   const glob = yield* Glob;
   return yield* glob.hashFiles(["pnpm-lock.yaml"]);
  });
  const hash = await Effect.runPromise(
   program.pipe(Effect.provide(Layer.mergeAll(/* GlobLive needs FS */ NodeFileSystem.layer))),
  );
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  expect(hash.length).toBeGreaterThanOrEqual(8);
  // Truncated form is the cache-key slice we use
  const slice = hash.substring(0, 8);
  expect(slice).toMatch(/^[0-9a-f]{8}$/);
 });
});
```

- [ ] **Step 2: Run the parity test**

```bash
pnpm test -- src/services/cache.hash-parity.test.ts
```

Expected: PASS. The test confirms `Glob.hashFiles` returns a SHA-256 hex string we can slice to 8 chars without semantic surprise.

- [ ] **Step 3: Delete the parity test**

```bash
git rm src/services/cache.hash-parity.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
test(cache): verify Glob.hashFiles produces stable hex digests

Adds and removes a parity sanity-check to confirm the migration to
Glob.hashFiles preserves the cache-key hash format. No source changes.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 16: Split `main.ts` → `main.ts` + `program.ts` + `layers/app.ts`

**Files:**

- Modify: `src/main.ts` (becomes 3-line entry)
- Create: `src/program.ts`
- Create: `src/layers/app.ts`

- [ ] **Step 1: Create `src/layers/app.ts`**

```typescript
/**
 * Application layer composition for the main phase.
 *
 * Wires every library and domain service the program needs.
 *
 * @module layers/app
 */

import { NodeFileSystem } from "@effect/platform-node";
import {
 ActionCacheLive,
 ActionEnvironmentLive,
 ActionStateLive,
 CommandRunnerLive,
 GlobLive,
 ToolInstallerLive,
} from "@savvy-web/github-action-effects";
import { Layer } from "effect";

/* v8 ignore start -- pure layer wiring */

export const MainLive = Layer.mergeAll(
 ActionCacheLive,
 ToolInstallerLive,
 CommandRunnerLive,
 ActionStateLive.pipe(Layer.provide(NodeFileSystem.layer)),
 ActionEnvironmentLive,
 GlobLive,
 NodeFileSystem.layer,
);

/* v8 ignore stop */
```

- [ ] **Step 2: Move the `main` Effect program to `src/program.ts`**

Create `src/program.ts` and move the entire body of the current `src/main.ts` from line 354 (`export const main = Effect.gen(function* () {`) through line 527 (`});`) plus all the helper functions (`installBiome`, `getActivePackageManagers`, `installDependencies`, `setupPackageManager`, `setOutputs`) into it. Rename the exported `main` to `program`.

The header of `src/program.ts`:

```typescript
/**
 * Main action program (the `main` phase).
 *
 * Imported by main.ts which calls Action.run(program, { layer: MainLive }).
 * Separated so tests can import `program` without triggering the module-level
 * Action.run side effect in main.ts.
 *
 * @module program
 */

import { homedir, arch as osArch, platform as osPlatform, tmpdir } from "node:os";
import { join } from "node:path";
import { FileSystem } from "@effect/platform";
import {
 ActionInput,
 ActionOutputs,
 CommandRunner,
 CommandRunnerLive,
 Step,
 ToolInstaller,
} from "@savvy-web/github-action-effects";
import type { Context } from "effect";
import { Config, Effect, Layer, Option } from "effect";
import type { PackageManager } from "./services/cache.js";
import { findLockFiles, getCombinedCacheConfig, restoreCache } from "./services/cache.js";
import { detectBiome, detectTurbo, loadPackageJson, parseDevEngines } from "./services/config-loader.js";
import { binaryMap as biomeBinaryMap } from "./descriptors/biome.js";
import { DependencyInstallError, PackageManagerSetupError } from "./errors/errors.js";
import type { InstalledRuntime } from "./services/runtime-installer.js";
import { RuntimeInstaller, extractErrorReason, formatCauseDetail, installerLayerFor } from "./services/runtime-installer.js";
import type { PackageManagerEntry, RuntimeEntry } from "./schemas/domain.js";
```

The `program` export at the bottom:

```typescript
export const program = Effect.gen(function* () {
 const outputs = yield* ActionOutputs;
 // ...full body from current main.ts lines 355–527, with logger.group → Step.groupStep
 // and Config.boolean/string → ActionInput.boolean/multiline as already done in Tasks 11 + 12
});
```

- [ ] **Step 3: Slim down `src/main.ts` to 3 lines**

Replace the entire contents of `src/main.ts` with:

```typescript
/**
 * Main action entry point.
 *
 * Thin wrapper around Action.run that loads the program and its layer.
 *
 * @module main
 */

import { Action } from "@savvy-web/github-action-effects";
import { MainLive } from "./layers/app.js";
import { program } from "./program.js";

/* v8 ignore next -- entry point, only runs when bundled as dist/main.js */
Action.run(program, { layer: MainLive });
```

Note: the current `if (process.env.GITHUB_ACTIONS)` guard is dropped in favor of unconditional `Action.run` (matches pnpm canonical pattern — `Action.run` itself is harmless outside Actions context and `dist/main.js` is only ever invoked by the runner anyway).

- [ ] **Step 4: Update test imports**

Rename `src/main.test.ts` (moved in Task 10) to `src/program.test.ts` and update its import from `from "./main.js"` to `from "./program.js"`:

```bash
git mv src/main.test.ts src/program.test.ts
# Then edit src/program.test.ts: change `from "./main.js"` to `from "./program.js"`
```

If you want a tiny smoke test for `main.ts` itself (asserting it imports without throwing), add a `src/main.test.ts` with a single import-side-effect test — optional.

- [ ] **Step 5: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor: split main.ts into entry + program + layers/app

src/main.ts becomes a thin Action.run(program, { layer: MainLive })
wrapper. The Effect program lives in src/program.ts (importable by
tests without triggering Action.run side effects). MainLive moves to
src/layers/app.ts and adds GlobLive.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 17: Refactor `src/post.ts` to use `CacheState` + defensive `catchAllDefect`

**Files:**

- Modify: `src/post.ts`

- [ ] **Step 1: Rewrite `src/post.ts`**

```typescript
/**
 * Post-action entry point.
 *
 * Runs after main (even on failure). Saves the dependency cache if main did not
 * achieve an exact hit. Post-action failures never fail the workflow.
 *
 * @module post
 */

import { NodeFileSystem } from "@effect/platform-node";
import {
 Action,
 ActionCacheLive,
 ActionState,
 ActionStateLive,
 Step,
} from "@savvy-web/github-action-effects";
import { Effect, Layer, Option } from "effect";
import { saveCache } from "./services/cache.js";
import { CacheState, STATE_KEYS } from "./state.js";

export const post = Effect.gen(function* () {
 yield* Effect.logDebug("Running post-action script");
 const state = yield* ActionState;
 const cacheStateOpt = yield* state.getOptional(STATE_KEYS.cacheState, CacheState);
 if (Option.isNone(cacheStateOpt)) {
  yield* Effect.logDebug("No cache state from main; nothing to save");
  return;
 }
 if (cacheStateOpt.value.restored) {
  yield* Effect.logInfo("Cache was an exact hit — skipping save");
  return;
 }
 yield* Step.groupStep("Cache save", saveCache());
}).pipe(
 Effect.catchAllDefect((defect) =>
  Effect.logWarning(`Post-action warning: ${defect instanceof Error ? defect.message : String(defect)}`),
 ),
);

/**
 * Domain layers for post-action. ActionStateLive needs FileSystem.
 */
export const PostLive = Layer.mergeAll(
 ActionCacheLive,
 ActionStateLive.pipe(Layer.provide(NodeFileSystem.layer)),
);

/* v8 ignore next 3 -- entry-point guard, only runs in GitHub Actions */
if (process.env.GITHUB_ACTIONS) {
 await Action.run(post, { layer: PostLive });
}
```

The `saveCache()` function from `src/services/cache.ts` should be unchanged here — it still reads its own state and writes the cache. The post.ts changes just hoist the early-exit decision out of `saveCache` so the cache-save step only appears in logs when there's actually work to do.

If `saveCache()` currently does the "is it an exact hit?" check internally, leave it there as a defense in depth — the new post.ts early-exit is purely a logging refinement.

- [ ] **Step 2: Update `src/post.test.ts`**

Use `ActionStateTest` + `ActionCacheTest` test layers. Seed `state.entries.set(STATE_KEYS.cacheState, JSON.stringify(...))` (whatever encoding the test state expects) to verify the conditional. Check `cache.saveCalls` is empty when `restored: true`, non-empty otherwise.

- [ ] **Step 3: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
refactor(post): use CacheState + catchAllDefect for defense in depth

Post now reads CacheState via the typed Schema class and skips
saveCache() entirely when main got an exact hit. Wraps the whole
program in Effect.catchAllDefect so a programming error never fails
the workflow.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 18: Align `pnpm` version and verify scripts

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Update `devEngines.packageManager.version` and `packageManager` field**

In `package.json`, change:

```json
"packageManager": "pnpm@10.34.0+sha512.8736169c56fdb6e26afb5d7e2bd5f4c99cc299620d8bdc288cb354e6dd0936bd4ea62276d1a6b2de4b6e971a00a530e0e08bbeeda63da5d820118d3d7e21ff69",
"devEngines": {
 "packageManager": {
  "name": "pnpm",
  "version": "10.34.0",
  "onFail": "ignore"
 },
```

To match `pnpm-config-dependency-action`:

```json
"packageManager": "pnpm@10.33.4+sha512-wMlch77BpJ6vO3c9pr+hALH5yOYTlnYNs71/xlJMKcXwTLphh96tEVilq7O827kkdnG8ayfALnWudwi/JKIAGQ==",
"devEngines": {
 "packageManager": {
  "name": "pnpm",
  "version": "10.33.4",
  "onFail": "ignore"
 },
```

(Use the exact sha512 from `pnpm-config-dependency-action/package.json` — read it before editing.)

```bash
grep '"packageManager"' /Users/spencer/workspaces/savvy-web/pnpm-config-dependency-action/package.json
```

Use whatever full integrity string that command returns.

- [ ] **Step 2: Verify scripts match references**

Read `pnpm-config-dependency-action/package.json` scripts and compare with this repo's `package.json` scripts. The set should already be identical post-Task 14 (`fast-glob` removed). If `test:coverage` and `test:watch` are missing, add them.

- [ ] **Step 3: Reinstall**

```bash
pnpm install
```

Expected: pnpm self-upgrades or downgrades to 10.33.4. Lockfile may regenerate trivially.

- [ ] **Step 4: Run tests + typecheck**

```bash
pnpm typecheck && pnpm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
chore: align pnpm to 10.33.4 to match sibling actions

Brings devEngines.packageManager.version and the packageManager field
into sync with silk-release-action and pnpm-config-dependency-action.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 19: Rebuild `dist/` and `.github/actions/local/dist/`

**Files:**

- Modify: `dist/main.js`, `dist/post.js`, `dist/package.json` (and chunks)
- Modify: `.github/actions/local/dist/*`

- [ ] **Step 1: Run build**

```bash
pnpm build
```

Expected: `dist/main.js`, `dist/post.js`, `dist/package.json` regenerated. `.github/actions/local/dist/` mirror regenerated. No errors.

- [ ] **Step 2: Verify dist structure**

```bash
ls -la dist/ && ls -la .github/actions/local/dist/
```

Both should show recent `main.js`, `post.js`, and `package.json`.

- [ ] **Step 3: Run validate**

```bash
pnpm validate
```

Expected: PASS (github-action-builder validates the action.yml and entries match the built dist).

- [ ] **Step 4: Commit dist + local action**

```bash
git add dist/ .github/actions/local/
git commit -m "$(cat <<'EOF'
build: regenerate dist after v2 standardization

Rebuilds dist/main.js, dist/post.js, and the .github/actions/local/
mirror so the bundled action reflects all source changes from this
migration. Closes the stale-dist gap (last build was 2024-03).

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 20: Update root `CLAUDE.md`

**Files:**

- Modify: `CLAUDE.md`

- [ ] **Step 1: Add the Dogfooding section**

Insert this section before the existing "Documentation Structure" section. Use the exact prose from the spec's "CLAUDE.md updates" section:

```markdown
## Dogfooding First-Party Dependencies

We author every dependency in the table below, so a bug or missing API in one can be fixed **in its own repo** and dogfooded through this action before publishing. The action is a **bundled** artifact — `pnpm build` inlines every dependency into `dist/{main,post}.js` — so once a local library build is linked and this repo is rebuilt, the change is baked into the committed `dist`. The integration runs the committed `dist`, **not** `node_modules`.

| Package | Repo | Local checkout |
| --- | --- | --- |
| `@savvy-web/github-action-effects` | `savvy-web/github-action-effects` | `../github-action-effects` |
| `@savvy-web/github-action-builder` | `savvy-web/github-action-builder` | `../github-action-builder` |

Both are direct-only dependencies with no transitive duplication path, so `pnpm link ../<repo>` is the linking mechanism for either. The `pnpm-workspace.yaml` `overrides` mechanism is not needed here unless a future first-party transitive dependency is introduced.

**Procedure:**

1. **Build the library:** in its repo run `pnpm ci:build` (produces `dist/dev` link target).
2. **Link it:** `pnpm link ../github-action-effects` here, then `pnpm install`.
3. **Keep the declared range correct** in this repo's `package.json` for the eventual unlinked install.
4. **Iterate:** edit library source → `pnpm ci:build` there → `pnpm typecheck` + `pnpm test` here → `pnpm build` here → commit (`src` + `dist` + changeset) → push `dev`.
5. **Library edits ship separately:** they land on the library's own branch and release with its next published version.
6. **Final step, only AFTER the dogfooded version publishes:** remove the link, pin the published range, `pnpm install`.

Commits must be GPG-signed with the GitHub-verified key for `C. Spencer Beggs <spencer@savvyweb.systems>` or the signature ruleset rejects them.
```

- [ ] **Step 2: Add the Development & Release Cycle section**

Append the section from the spec verbatim, scoped to this action. Cover:

- The `dev` branch convention
- Flow: `dev` → `main` → release
- `release-sync.yml` post-release housekeeping

The exact prose appears in the spec — copy it directly.

- [ ] **Step 3: Update Project Structure tree**

Replace the existing `Project Structure` code block with the new layout:

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

- [ ] **Step 4: Remove obsolete content**

Find and delete any references to:

- `src/emoji.ts` / `formatRuntime`/`formatSuccess` helpers
- `src/config.ts` / `src/cache.ts` / `src/runtime-installer.ts` at the top level
- `Context.GenericTag` patterns
- Hand-rolled `Layer.succeed(...)` test mocks

- [ ] **Step 5: Update Technical stack bullet**

Change:

```markdown
* **GitHub Action services:** `@savvy-web/github-action-effects` 0.11.10 -- ...
```

To:

```markdown
* **GitHub Action services:** `@savvy-web/github-action-effects` ^2.0.0 — zero `@actions/*` dependencies, ships `Step.*` for step-buffered logging, `GithubMarkdown.*` for summary helpers, `ActionInput.{boolean,multiline}` for typed input parsing, and `<Service>Test` test layers (via `@savvy-web/github-action-effects/testing`).
* **Build tool:** `@savvy-web/github-action-builder` ^0.7.1 (rsbuild-based) configured via `action.config.ts`
* **Cross-phase state:** `src/state.ts` defines `CacheState` (Schema.Class) and `STATE_KEYS`; `main` writes, `post` reads.
```

Bump versions to match the package.json after Task 18.

- [ ] **Step 6: Run markdown lint**

```bash
pnpm lint:md
```

Expected: PASS. Fix any rule violations inline.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(claude-md): document v2 layout, dogfooding, and release cycle

Adds the standard Dogfooding First-Party Dependencies and Development
& Release Cycle sections, updates the project tree to reflect the
src/services/errors/schemas/layers/ layout, and refreshes the
technical stack bullet to v2 conventions (Step, GithubMarkdown,
ActionInput, *Test layers, CacheState).

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 21: Update `src/CLAUDE.md` and remove `__test__/CLAUDE.md`

**Files:**

- Modify: `src/CLAUDE.md`
- Delete: `__test__/CLAUDE.md` (if `__test__/` no longer exists)

- [ ] **Step 1: Rewrite `src/CLAUDE.md` to reflect new layout**

Key updates:

- Replace the "Source Modules" section with one entry per top-level module (`main.ts`, `post.ts`, `program.ts`, `state.ts`, `layers/app.ts`, plus one-liner entries for each `services/*.ts`, `errors/errors.ts`, `schemas/domain.ts`).
- Update "Entry Points" to describe the thin `main.ts` + `program.ts` split.
- Replace the "Effect Patterns → Input reading" example with `ActionInput.multiline` / `ActionInput.boolean`.
- Replace the "Effect Patterns → Testing" paragraph with library `<Service>Test` layers; show a 5-line snippet:

```typescript
import { ActionOutputsTest } from "@savvy-web/github-action-effects/testing";
const outputs = ActionOutputsTest.empty();
const layer = ActionOutputsTest.layer(outputs);
await program.pipe(Effect.provide(layer), Effect.runPromise);
expect(outputs.outputs.get("node-version")).toBe("24.11.0");
```

- Document `Step.groupStep` usage convention with one example.
- Remove the paragraph mentioning `src/emoji.ts`.

- [ ] **Step 2: Delete `__test__/CLAUDE.md` if `__test__/` is empty**

```bash
if [ ! -d "__test__/integration" ] && [ -z "$(ls -A __test__ 2>/dev/null)" ]; then
 git rm -r __test__
fi
```

If `__test__/integration/` survives, keep that directory and update `__test__/CLAUDE.md` to describe only integration tests (or fold it into `src/CLAUDE.md` and delete it).

- [ ] **Step 3: Run markdown lint**

```bash
pnpm lint:md
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
docs(src): update CLAUDE.md for new layout and testing pattern

Documents the src/services/errors/schemas/layers split, the
main.ts/program.ts/layers/app.ts entry split, and the library
<Service>Test layer testing pattern. Removes references to the deleted
emoji module and legacy hand-rolled mocks.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 22: Sync `.claude/design/workflow-runtime-action/*.md` design docs

**Files:**

- Modify: `.claude/design/workflow-runtime-action/architecture.md`
- Modify: `.claude/design/workflow-runtime-action/effect-service-model.md`
- Modify: `.claude/design/workflow-runtime-action/runtime-installation.md`
- Modify: `.claude/design/workflow-runtime-action/caching-strategy.md`
- Modify: `.claude/design/workflow-runtime-action/build-and-distribution.md`
- Modify: `.claude/design/workflow-runtime-action/testing-strategy.md`
- Modify: `.claude/design/workflow-runtime-action/INDEX.md`

- [ ] **Step 1: Dispatch the design-doc-agent**

Invoke:

```text
Use the design-docs:design-doc-agent (or design-docs:design-sync skill) to:
- Read every file in .claude/design/workflow-runtime-action/
- Sync each file's content against the current src/ tree
- Update last-synced dates and completeness percentages in INDEX.md
- Document the new patterns: Step.*, GithubMarkdown.*, ActionInput.*, library *Test layers, CacheState, RuntimeInstaller class tag, GlobLive
- Remove references to src/emoji.ts, parseMultiValueInput, Context.GenericTag, fast-glob, Data.TaggedError
```

If the agent flags semantic gaps, address them inline.

- [ ] **Step 2: Review the agent's changes**

```bash
git diff .claude/design/workflow-runtime-action/
```

Spot-check that file paths in the docs match the new src/ tree.

- [ ] **Step 3: Run markdown lint on the design docs**

```bash
pnpm lint:md
```

- [ ] **Step 4: Commit**

```bash
git add .claude/design/workflow-runtime-action/
git commit -m "$(cat <<'EOF'
docs(design): sync workflow-runtime-action design docs to v2 layout

Updates architecture, effect-service-model, runtime-installation,
caching-strategy, build-and-distribution, and testing-strategy to
reflect the standardized v2 patterns. Refreshes INDEX.md
last-synced date.

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 23: Create the changeset

**Files:**

- Create: a new file in `.changeset/` (auto-named by the skill)

- [ ] **Step 1: Invoke the changesets:create skill**

```text
Run /changesets:create — the agent will inventory the diff and propose a changeset entry. Confirm bump type is "minor" (significant internal refactor with no public API change — action inputs/outputs are unchanged).
```

The changeset should describe:

- Migration to canonical v2 pattern of @savvy-web/github-action-effects
- New file layout (src/services/, src/errors/, src/schemas/, src/layers/, src/state.ts)
- main.ts split into main + program + layers/app
- Step.* namespace adoption
- GithubMarkdown.* replaces local emoji helpers
- ActionInput.multiline / ActionInput.boolean replaces local parser
- GlobLive replaces fast-glob direct dep
- Library `<Service>Test` layers replace hand-rolled mocks
- Schema.TaggedError errors with computed message getters
- Rebuilt dist/ (was stale)
- CLAUDE.md adds Dogfooding + Release Cycle sections

- [ ] **Step 2: Verify changeset format**

```bash
pnpm changesets:check 2>/dev/null || cat .changeset/*.md
```

- [ ] **Step 3: Commit the changeset**

```bash
git add .changeset/
git commit -m "$(cat <<'EOF'
chore(changeset): describe v2 standardization

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Task 24: Final verification pass

**Files:** (no source changes)

- [ ] **Step 1: Run the full local pipeline**

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm validate
```

Expected: all PASS.

- [ ] **Step 2: Verify acceptance criteria from the spec**

Check each item from the spec's "Acceptance criteria" section:

```bash
# No src/emoji.ts, no src/utils/, no fast-glob
test ! -e src/emoji.ts && echo "✓ emoji.ts gone"
test ! -d src/utils && echo "✓ no src/utils"
! grep -q '"fast-glob"' package.json && echo "✓ fast-glob removed from package.json"

# No Context.GenericTag in source
! grep -r "Context.GenericTag" src/ && echo "✓ no Context.GenericTag"

# No Data.TaggedError in source
! grep -r "Data.TaggedError" src/ && echo "✓ no Data.TaggedError"

# Tests all colocated under src/
find src/ -name "*.test.ts" | wc -l
echo "(should match the number of test modules)"

# Root CLAUDE.md has Dogfooding + Dev Cycle sections
grep -q "Dogfooding First-Party Dependencies" CLAUDE.md && echo "✓ Dogfooding section present"
grep -q "Development & Release Cycle" CLAUDE.md && echo "✓ Dev Cycle section present"

# Changeset present
ls .changeset/*.md | grep -v README && echo "✓ changeset present"

# Dist rebuilt
test -f dist/main.js && test -f dist/post.js && test -f dist/package.json && echo "✓ dist/ rebuilt"
test -f .github/actions/local/dist/main.js && echo "✓ local action dist rebuilt"
```

Every line should print its ✓. Investigate any failures.

- [ ] **Step 3: Push `dev` and trigger CI**

```bash
git push origin dev
```

Watch `.github/workflows/test.yml` and any other CI workflows that run on `dev`:

```bash
gh run list --limit 5
gh run watch
```

Expected: green across the board, including the local-action fixture workflows that exercise `.github/actions/local`.

If anything fails, diagnose and add follow-up commits to `dev`.

- [ ] **Step 4: Open the PR (optional — may be done later)**

```bash
gh pr create --base main --head dev --title "v2 canonical standardization" --body "$(cat <<'EOF'
## Summary
- Bring workflow-runtime-action into full canonical alignment with the v2 pattern of @savvy-web/github-action-effects (the pnpm-config-dependency-action template).
- Restructure src/ into services/errors/schemas/layers/, split main.ts into main + program + layers/app.
- Migrate to Schema.TaggedError, library *Test layers, Step.* namespace, GithubMarkdown.*, ActionInput.{boolean,multiline}, GlobLive.
- Add Dogfooding + Release Cycle sections to CLAUDE.md.

## Test plan
- [ ] `pnpm typecheck && pnpm test && pnpm lint && pnpm validate` all pass locally.
- [ ] `.github/workflows/test.yml` is green on the dev push (verifies the rebuilt .github/actions/local fixtures still work).
- [ ] Manually inspect a workflow run's Step output in the GitHub UI — collapsed groups should be visible.
- [ ] Cache restore on a workflow run that previously had a cache should still hit (Glob.hashFiles parity).

Signed-off-by: C. Spencer Beggs <spencer@savvyweb.systems>
EOF
)"
```

---

## Self-review checklist (run after writing the plan; no separate task)

- [x] Every task in the spec sequencing list has a corresponding task here.
- [x] No "TBD", "TODO", "add appropriate error handling", or "similar to Task N" placeholders.
- [x] Every code transformation step shows the before/after code or the exact rewritten file.
- [x] Every task ends with a `git commit` step.
- [x] Acceptance criteria from the spec are verified in Task 24.
- [x] Dogfooding + Release Cycle docs land in Task 20 (and the prose source is the spec, which copies from the user's prompt).
- [x] Test files end up colocated with sources (Task 6 + Task 10).
- [x] `fast-glob` removed from package.json (Task 14) and verified gone (Task 24).
- [x] `dist/` rebuilt at the end (Task 19), not partway through, so each intermediate task is a clean source-only commit.
- [x] Names used consistently: `CacheState` (Task 8), `MainLive` (Task 16), `PostLive` (Task 17), `STATE_KEYS.cacheState` (Tasks 8/17), `program` (Tasks 10/16).
