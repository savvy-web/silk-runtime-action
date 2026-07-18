---
status: current
module: silk-runtime-action
category: integration
created: 2026-03-21
updated: 2026-07-17
last-synced: 2026-07-17
completeness: 88
related:
  - ./architecture.md
  - ./testing-strategy.md
  - ./turbo-remote-cache.md
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

The action is built using `@savvy-web/github-action-builder` (v2 line, rsbuild-based; `package.json` is authoritative for the exact range) and produces compiled JavaScript bundles that are committed to git. GitHub Actions runs the action from the checked-out source -- there is no build step in the Actions runtime -- so the compiled output must be present in the repo.

**Key features:**

- Three entry points compiled to ES module bundles: `main.js`, `post.js` and the `turbo-server.js` worker bundle.
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
  entries: {
    main: "src/main.ts",
    post: "src/post.ts",
    workers: { "turbo-server": "src/turbo-server.ts" },
  },
  build: {
    minify: true,
    ignore: ["xmlbuilder2", "libxmljs2", "ajv-formats-draft2019"],
  },
  persistLocal: { enabled: true, path: ".github/actions/local" },
});
```

The `workers` entry produces `dist/turbo-server.js`, the detached embedded turbo remote-cache server that main spawns at runtime. It is not a GitHub Actions lifecycle hook (only `main` and `post` are referenced in `action.yml`). See [turbo remote cache](./turbo-remote-cache.md).

### Build output

```text
dist/                            # Production build (committed)
  main.js
  post.js
  turbo-server.js
  package.json                   # { "type": "module" }

.github/actions/local/dist/      # Local testing copy (committed)
  main.js
  post.js
  turbo-server.js
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

### Builder version (v2 line)

The builder tracks the published `@savvy-web/github-action-builder` line (currently the v2 major, alongside the Effect v4 migration); `package.json` is authoritative for the exact range. The builder exposes a `build.nativeDynamicImports` option for bundles that must preserve native dynamic imports — it is deliberately not set here because the production bundle contains no dynamic-import packages (the build emits zero rspack critical-dependency warnings).

### `ignore` list for cyclonedx optional plugins

`@savvy-web/github-action-effects` pulls in `@cyclonedx/cyclonedx-library` transitively. That library ships optional plugins -- XML serializers and validators (`xmlbuilder2`, `libxmljs2`) and a draft-2019 JSON validator (`ajv-formats-draft2019`) -- that the action never invokes. They are not declared as dependencies at all and are never installed, so the bundler must not try to resolve them.

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
3. Compiles TypeScript via rsbuild with the three entry points (`main`, `post`, `turbo-server`).
4. Applies the `ignore` list (stubs the three cyclonedx optional plugins).
5. Writes minified bundles to `dist/`.
6. Creates `dist/package.json` with `{ "type": "module" }`.
7. Copies bundles to `.github/actions/local/dist/` (per `persistLocal`).

### Dependencies

`package.json` is authoritative for exact ranges. Topology:

Production (bundled into `dist/`):

- `@savvy-web/github-action-effects` -- GitHub Actions runtime protocol (v4 line).
- `effect` -- Effect framework, resolved to `effect@4.0.0-beta.98` via `catalog:effect`. In v4 the former `@effect/platform` is dissolved into core `effect`; only `@effect/platform-node` (the Node platform layers, also `catalog:effect`) remains a separate package. `@effect/cluster`, `@effect/rpc` and `@effect/sql` were removed (unused).
- `@effect/platform-node` -- Node platform layers (`NodeFileSystem`, `NodeHttpClient`).
- `@effected/jsonc` -- Biome config parsing (`Jsonc.parse`; replaces the v3-era `jsonc-effect`).

Dev (not bundled):

- `@savvy-web/github-action-builder` -- build tool (v2 line).
- `@savvy-web/silk` -- release/CI tooling providing the `savvy` CLI used by `ci:version`.
- `@vitest-agent/plugin` -- test tooling.

The cyclonedx optional plugins (`xmlbuilder2`, `libxmljs2`, `ajv-formats-draft2019`) are not declared as dependencies; the `ignore` list stubs their imports at build time.

### TypeScript configuration

- `module: "ESNext"`, `moduleResolution: "bundler"`, `target: "ES2022"`, `strict: true`, `noEmit: true`.
- All imports require `.js` extensions (enforced by Biome).
- `node:` protocol required for built-in modules (enforced by Biome).
- Type checking via `@typescript/native-preview` (tsgo).

### Release process

1. `pnpm changeset` to record changes.
2. Changesets workflow opens a release PR. Version application runs through the `savvy` CLI (`ci:version` script) from `@savvy-web/silk` (v3 line) -- this affects only release tooling, never the action source or bundles.
3. Merging the PR bumps `package.json` and `CHANGELOG.md`, then creates a GitHub release with tags.
4. Users reference by tag (e.g., `savvy-web/silk-runtime-action@v1`).

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) -- entry topology.
- [Turbo remote cache](./turbo-remote-cache.md) -- what the `turbo-server` bundle does at runtime.
- [Testing strategy](./testing-strategy.md) -- how the local copy is exercised by fixture tests.

**Source files:**

- `action.config.ts` -- build configuration including the `ignore` list.
- `action.yml` -- action definition.
- `package.json` -- dependencies and scripts.
