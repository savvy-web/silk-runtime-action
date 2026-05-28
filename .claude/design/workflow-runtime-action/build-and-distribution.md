---
status: current
module: workflow-runtime-action
category: integration
created: 2026-03-21
updated: 2026-05-28
last-synced: 2026-05-28
completeness: 88
related:
  - ./architecture.md
  - ./testing-strategy.md
dependencies: []
---

# Build and distribution

Build pipeline, bundle configuration, distribution strategy and the local testing copy.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Rationale](#rationale)
4. [Implementation details](#implementation-details)
5. [Related documentation](#related-documentation)

---

## Overview

The action is built using `@savvy-web/github-action-builder` (^0.7.1, rsbuild-based) and produces compiled JavaScript bundles that are committed to git. GitHub Actions runs the action from the checked-out source -- there is no build step in the Actions runtime -- so the compiled output must be present in the repo.

**Key features:**

- Two entry points compiled to ES module bundles (`main.js`, `post.js`).
- Minification enabled.
- Automatic local testing copy at `.github/actions/local/`.
- ES module marker (`dist/package.json` with `"type": "module"`).
- `ignore` list in `action.config.ts` for optional cyclonedx plugins that ship with `@cyclonedx/cyclonedx-library` (transitive via `@savvy-web/github-action-effects`).

**When to load this doc:**

- Modifying build configuration.
- Debugging bundle issues in CI.
- Understanding why `dist/` is committed.
- Adding new entry points.

---

## Current state

### Build configuration

See `action.config.ts`:

```ts
export default defineConfig({
  entries: { main: "src/main.ts", post: "src/post.ts" },
  build: {
    minify: true,
    ignore: ["xmlbuilder2", "libxmljs2", "ajv-formats-draft2019"],
  },
  persistLocal: { enabled: true, path: ".github/actions/local" },
});
```

### Build output

```text
dist/                            # Production build (committed)
  main.js
  post.js
  package.json                   # { "type": "module" }

.github/actions/local/dist/      # Local testing copy (committed)
  main.js
  post.js
  package.json
```

### Build commands

| Command | Purpose |
| --- | --- |
| `pnpm build` | Build via Turbo (runs `build:prod`) |
| `pnpm build:prod` | Direct `github-action-builder build` |
| `pnpm ci:build` | CI build with full output logs |

### Action runtime configuration (`action.yml`)

```yaml
runs:
  using: node24
  main: dist/main.js
  post: dist/post.js
```

---

## Rationale

### Commit `dist/` to git

GitHub Actions loads the action directly from the repository at the specified ref. There is no build step in the Actions runtime, so the compiled JavaScript must be present in the repository. This applies to every JavaScript GitHub Action.

### Builder version (^0.7.1)

The builder was upgraded from 0.5.0 to ^0.7.1 as part of the v2 standardization. 0.7.1 supports the `build.ignore` list and matches the rsbuild plugin contract expected by the rest of the savvy-web action stack.

### `ignore` list for cyclonedx optional plugins

`@savvy-web/github-action-effects` pulls in `@cyclonedx/cyclonedx-library` transitively. That library ships optional plugins -- XML serializers and validators (`xmlbuilder2`, `libxmljs2`) and a draft-2019 JSON validator (`ajv-formats-draft2019`) -- that the action never invokes. They are not installed in production (declared as `optionalDependencies`), so the bundler must not try to resolve them.

`ignore` is the right knob here, not `externals`. `ignore` rewrites the import to a throwing stub; cyclonedx's `_optPlug` wrapper try/catches that throw and falls through to its non-XML/non-draft-2019 code path. `externals` would mean "available at runtime" -- which is the opposite of true.

### rsbuild via `github-action-builder`

rsbuild gives tree shaking, dead code elimination and ES module output compatible with Node 24. The builder wraps it with sensible defaults: entry point configuration via `defineConfig`, automatic local-copy generation and clean builds.

### Local testing copy

`.github/actions/local/` separates test artifacts from the production build. The `test-fixture` composite action references `.github/actions/local` rather than the repo root, letting fixture tests run against the built action without interfering with `dist/`.

---

## Implementation details

### Build process

1. `github-action-builder build` reads `action.config.ts`.
2. Cleans `dist/` and `.github/actions/local/dist/`.
3. Compiles TypeScript via rsbuild with two entry points.
4. Applies the `ignore` list (stubs the three cyclonedx optional plugins).
5. Writes minified bundles to `dist/`.
6. Creates `dist/package.json` with `{ "type": "module" }`.
7. Copies bundles to `.github/actions/local/dist/` (per `persistLocal`).

### Dependencies

Production (bundled):

- `@savvy-web/github-action-effects` ^2.0.0 -- GitHub Actions runtime protocol.
- `effect`, `@effect/platform`, `@effect/platform-node` -- Effect framework.
- `jsonc-effect` -- Biome config parsing.
- Related Effect packages transitively.

Dev (not bundled):

- `@savvy-web/github-action-builder` ^0.7.1 -- build tool.
- `@savvy-web/vitest`, `@savvy-web/changesets`, `@savvy-web/commitlint`, `@savvy-web/lint-staged` -- tooling.

Optional (declared in `optionalDependencies`, never installed and ignored at build time):

- `xmlbuilder2`, `libxmljs2`, `ajv-formats-draft2019`.

### TypeScript configuration

- `module: "ESNext"`, `moduleResolution: "bundler"`, `target: "ES2022"`, `strict: true`, `noEmit: true`.
- All imports require `.js` extensions (enforced by Biome).
- `node:` protocol required for built-in modules (enforced by Biome).
- Type checking via `@typescript/native-preview` (tsgo).

### Release process

1. `pnpm changeset` to record changes.
2. Changesets workflow opens a release PR.
3. Merging the PR bumps `package.json` and `CHANGELOG.md`, then creates a GitHub release with tags.
4. Users reference by tag (e.g., `savvy-web/workflow-runtime-action@v1`).

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) -- entry topology.
- [Testing strategy](./testing-strategy.md) -- how the local copy is exercised by fixture tests.

**Source files:**

- `action.config.ts` -- build configuration including the `ignore` list.
- `action.yml` -- action definition.
- `package.json` -- dependencies and scripts.
