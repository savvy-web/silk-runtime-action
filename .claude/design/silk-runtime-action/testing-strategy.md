---
status: current
module: silk-runtime-action
category: testing
created: 2026-03-21
updated: 2026-05-28
last-synced: 2026-05-28
completeness: 90
related:
  - ./architecture.md
  - ./effect-service-model.md
  - ./build-and-distribution.md
dependencies: []
---

# Testing strategy

Two tiers: library-provided Effect test layers for unit tests and fixture-based workflow tests for integration.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Rationale](#rationale)
4. [Implementation details](#implementation-details)
5. [Related documentation](#related-documentation)

---

## Overview

Unit tests run in Vitest with library-provided Effect Test layers from `@savvy-web/github-action-effects/testing`. Fixture tests run inside real GitHub Actions workflow jobs against the built action.

**Key features:**

- Tests are co-located with their source modules (no `__test__/` directory).
- Library Test layers expose a state object (`*Test.empty()`) and a layer factory (`*Test.layer(state)`). Tests assert against the state.
- Hand-rolled `Layer.succeed(Tag, {...})` mocks are reserved for failure-injection cases.
- Config inputs are injected via `ConfigProvider.fromMap`.
- Fixture tests run on Ubuntu, macOS and Windows.

**When to load this doc:**

- Writing new tests.
- Adding a fixture configuration.
- Debugging test failures specific to the layer composition.

---

## Current state

### Test organization

Tests live next to the source they cover:

```text
src/
  state.test.ts
  program.test.ts
  post.test.ts
  errors/errors.test.ts
  schemas/domain.test.ts
  services/cache.test.ts
  services/config-loader.test.ts
  services/runtime-installer.test.ts
  descriptors/descriptors.test.ts
```

The previous `__test__/` directory has been removed.

### Library Test layers

`@savvy-web/github-action-effects/testing` exports paired `empty()` + `layer(state)` helpers for every service used by this action:

| Test export | Backs |
| --- | --- |
| `ActionOutputsTest` | `ActionOutputs` |
| `ActionStateTest` | `ActionState` |
| `ActionCacheTest` | `ActionCache` |
| `ActionEnvironmentTest` | `ActionEnvironment` |
| `ActionLoggerTest` | `ActionLogger` |
| `CommandRunnerTest` | `CommandRunner` |
| `ToolInstallerTest` | `ToolInstaller` |
| `GlobTest` | `Glob` |

Each `empty()` returns a mutable state object that captures method calls. Each `layer(state)` returns the corresponding `Layer.Layer<Tag>` to provide to the effect under test.

### Coverage requirements

- Branches: 85%.
- Functions / lines / statements: 90%.

### Fixture organization

`__fixtures__/` holds one directory per supported configuration (Node minimal, Node + pnpm, Node + yarn, Node + bun, Node + Deno, Bun only, Deno only). Each fixture contains a `package.json` with valid `devEngines.packageManager` and `devEngines.runtime`.

---

## Rationale

### Library Test layers as default

Earlier iterations defined mock layers inline with `Layer.succeed(Tag, { ... } as unknown as ...)`. Those casts were brittle and required tests to enumerate every method on every service. The library Test layers:

- Capture all method calls into a state object so assertions read like real expectations (`expect(state.outputs).toContainEqual({ name: "node-version", value: "24.11.0" })`).
- Stay in sync with library service shapes automatically.
- Make test code dramatically shorter.

The hand-rolled mock pattern is still acceptable but should be reserved for failure-injection cases (see below).

### When hand-rolled mocks are acceptable

A hand-rolled `Layer.succeed(Tag, { ... })` mock is the right tool when the test needs to **inject a specific failure** that the library Test layer cannot reproduce. Concrete examples:

- Simulating `ActionCache.save` failing mid-write.
- Simulating `CommandRunner.exec` throwing a non-Error value.
- Simulating `Glob.hashFiles` returning `None`.

For success-path testing, use the library Test layer.

### Co-located tests

Co-locating tests with source removes the cognitive overhead of mapping `__test__/foo.test.ts` back to `src/foo.ts`. It also makes it harder for a refactor to leave the test file behind.

### Dual testing

Unit tests catch logic errors fast during development. Fixture tests catch integration issues (actual runtime downloads, platform-specific behavior, cache protocol interactions) that unit tests cannot. Both tiers are required for confidence.

---

## Implementation details

### Library Test layer pattern

```ts
import { ActionOutputsTest } from "@savvy-web/github-action-effects/testing";

const state = ActionOutputsTest.empty();
await program.pipe(
  Effect.provide(ActionOutputsTest.layer(state)),
  Effect.runPromise,
);
expect(state.outputs.find((o) => o.name === "node-version")?.value).toBe("24.11.0");
```

The state object exposes mutated arrays/sets per service. Assertion ergonomics match Vitest's `toContainEqual`/`toEqual` style.

### Full pipeline test composition

`src/program.test.ts` composes all library Test layers plus an inline `FileSystem` mock (driven by an in-memory file map). Tests assert against the captured output state and exported variables. The pattern is:

```ts
const outputs = ActionOutputsTest.empty();
const layer = Layer.mergeAll(
  ActionOutputsTest.layer(outputs),
  ActionLoggerTest.layer(ActionLoggerTest.empty()),
  ActionCacheTest.layer(/* ... */),
  ActionStateTest.layer(ActionStateTest.empty()),
  ActionEnvironmentTest.layer(/* ... */),
  CommandRunnerTest.layer(/* ... */),
  ToolInstallerTest.layer(ToolInstallerTest.empty()),
  GlobTest.layer(/* ... */),
  makeFileSystemLayer(files),
);
await program.pipe(Effect.provide(layer), Effect.runPromise);
```

### Hand-rolled failure mocks

Reserved for tests that need to inject a specific error. Example shape:

```ts
const cacheLayerSavingFails = Layer.succeed(ActionCache, {
  restore: () => Effect.succeed(Option.none()),
  save: () => Effect.fail(new ActionCacheError(...)),
} as unknown as Context.Tag.Service<typeof ActionCache>);
```

Use the `as unknown as` cast only when the mock genuinely cannot satisfy the full service shape.

### Config input injection

Inputs are read via `Config`/`ActionInput.*` against the `ConfigProvider`. Tests override values via `ConfigProvider.fromMap`:

```ts
const configLayer = Layer.setConfigProvider(
  ConfigProvider.fromMap(new Map([
    ["install-deps", "false"],
    ["biome-version", "2.3.14"],
  ])),
);
```

### Fixture test infrastructure

`.github/actions/test-fixture/` (composite action) does setup, execute and verify:

1. Clean workspace and copy fixture files to the repo root.
2. Run `.github/actions/local` (the built action).
3. Python script compares actual outputs vs. expected values.
4. Generate step summary with results.

Fixture tests use a matrix with `fail-fast: false` to surface every failure in a single run.

### Cache testing pattern

Cache fixtures run as a pair of dependent jobs:

1. **Create cache** -- first run installs everything and saves the cache.
2. **Restore cache** -- second run should restore from cache and emit `cache-hit=true`.

### Common issues

| Issue | Cause | Fix |
| --- | --- | --- |
| "Effect service not found" | Missing layer in `Layer.mergeAll` | Add the corresponding `*Test.layer(state)` |
| Config values not picked up | No `ConfigProvider` layer | Add `Layer.setConfigProvider(ConfigProvider.fromMap(...))` |
| Test passes locally, fails in CI | Platform-specific behavior | Check `process.platform` branching |
| Hash-of-hashes mismatch with old fixtures | Hash algorithm changed (see caching-strategy.md) | Regenerate expected hashes |

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) -- pipeline shape under test.
- [Effect service model](./effect-service-model.md) -- service tag definitions and layer composition.
- [Build and distribution](./build-and-distribution.md) -- how the local copy used by fixture tests is produced.

**Context files:**

- [src/CLAUDE.md](../../../src/CLAUDE.md) -- per-module testing guidance.
- [**fixtures**/CLAUDE.md](../../../__fixtures__/CLAUDE.md) -- fixture inventory.
- [.github/workflows/CLAUDE.md](../../../.github/workflows/CLAUDE.md) -- workflow test wiring.
