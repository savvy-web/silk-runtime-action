---
status: current
module: silk-runtime-action
category: integration
created: 2026-03-21
updated: 2026-08-02
last-synced: 2026-08-02
completeness: 92
related:
  - ./architecture.md
  - ./testing-strategy.md
  - ./turbo-remote-cache.md
dependencies: []
---

# Build and distribution

Build pipeline, bundle configuration, the committed `dist/`, the dependency topology, and the dogfood loop's verification rule.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Dependency topology](#dependency-topology)
4. [Rationale](#rationale)
5. [Implementation details](#implementation-details)
6. [Related documentation](#related-documentation)

---

## Overview

The action is built with `@savvy-web/github-action-builder` (rsbuild-based, `^2.1.1`) and produces compiled JavaScript bundles that are **committed to git**. GitHub Actions loads the action from the checked-out ref with no build step in the runtime, so the compiled output must be present in the repository.

**Key features:**

- Three ES-module bundles: `main.js`, `post.js` and the `turbo-server.js` worker.
- Minification enabled.
- An automatic local testing copy at `.github/actions/local/`.
- An ES-module marker (`dist/package.json` with `{ "type": "module" }`).
- Every dependency inlined — the deployed action never resolves `node_modules`.

**When to load this doc:**

- Modifying build configuration or adding an entry point.
- Debugging a bundle issue in CI.
- Linking, unlinking or bumping a first-party dependency.

---

## Current state

### Build configuration

```ts
// action.config.ts
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

The `workers` entry produces `dist/turbo-server.js`, the detached embedded turbo remote-cache server that main spawns at runtime. It is **not** a lifecycle hook — `action.yml` names only `main` and `post`. Main resolves it as a sibling of its own bundle through `import.meta.url`, which is why that resolution is meaningful only in the built artifact. See [turbo remote cache](./turbo-remote-cache.md).

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
| `pnpm build` | Build through Turbo (runs `build:prod`) |
| `pnpm build:prod` | Direct `github-action-builder build` |
| `pnpm ci:build` | CI build with full output logs |
| `pnpm validate` | `github-action-builder validate` — checks the action definition |

### Action runtime configuration (`action.yml`)

```yaml
runs:
  using: node24
  main: dist/main.js
  post: dist/post.js
```

`action.yml` is also **parity surface under test**: `INPUT_NAMES` and `OUTPUT_NAMES` in `src/schema/` are checked against the file itself, so the declared inputs and outputs cannot drift from the code. See [testing strategy](./testing-strategy.md#the-parity-guards).

---

## Dependency topology

### Production (bundled into `dist/`)

| Package | Role |
| --- | --- |
| `effect` (`catalog:effect` → `4.0.0-beta.101`) | The framework. In v4 the former `@effect/platform` is dissolved into core `effect` |
| `@effect/platform-node` | Node platform layers (`NodeFileSystem`, `NodeHttpClient.layerUndici`) |
| `@effected/github-actions` (`^0.3.0`) | Every GitHub Actions runtime interaction |
| `@effected/npm` (`^0.7.0`) | `PackageManagerPin` |
| `@effected/semver` (`^0.3.0`) | `SemVer.ExactVersionString`, which backs `AbsoluteVersion` |
| `@effected/jsonc` (`^0.5.1`) | `Jsonc.parse` for `biome.jsonc` |

Other `@effected/*` entries are declared in `package.json` but **not imported by `src/` today**: `commands`, `git`, `github`, `glob`, `lockfiles`, `markdown`, `package-json`, `runtimes`, `sbom`, `workspaces`, `yaml`. Notably `@effected/glob` left the code path when lockfile discovery and hashing moved onto `CacheKey.matchingFiles` / `CacheKey.hashFiles`. Nothing is bundled that is not imported, so an unused declaration costs install time rather than bundle size.

### Dev (not bundled)

- `@savvy-web/github-action-builder` (`^2.1.1`) — the build tool.
- `@savvy-web/silk` (`^3.2.11`) — the Biome preset and the `savvy` CLI used by `ci:version`.
- `@vitest-agent/plugin` — test tooling and coverage levels.
- `@effect/vitest` — Effect-aware test harness (declared as a runtime dependency, used only by tests).

No pnpm overrides, no patches, no links. Every range is a published caret.

### The dogfood loop and its verification rule

Every first-party dependency is authored in-house, so a bug or missing API is fixed **in its own repo** and dogfooded here before publishing:

| Package | Repo | Local checkout |
| --- | --- | --- |
| `@effected/*` | `spencerbeggs/effected` | `../../spencerbeggs/effected/packages/<name>` |
| `@savvy-web/github-action-builder` | `savvy-web/systems` | `../systems/packages/github-action-builder` |

Iteration runs through the dogfood mailbox protocol (`.claude/dogfood/`, the `silk:dogfood` skill). A link is added **lazily**, only for the duration of a loop round, and removed before any push.

> **Rule: a `file:`-linked package that is *same-version, different-content* against the registry makes `pnpm install` succeed while the code no longer typechecks once unlinked.**

The rebuild ran on four such overrides. Unlinking them produced a green install and a **red typecheck**: the registry versions at those same version numbers had none of `ExactVersionString`, `PackageManagerInstaller`/`PackageManagerPin`, `ActionOutputs.layerDetached` or `CacheKey.withoutRestoreKeys`. Worse, a **warm pnpm store can mask it locally** — the store still holds the linked content, so a local reinstall reproduces the working tree that CI will not.

The honest check is therefore narrow:

1. Upstream publishes a **release wave at bumped versions**.
2. Bump the ranges here to those versions.
3. Unlink and remove any `overrides:` entry.
4. Verify with a **cold registry install in CI** — not a warm local one.

That is how the rebuild's loop closed on 2026-08-03, against `@effected/github-actions@0.3.0`, `@effected/npm@0.7.0`, `@effected/package-json@0.7.0` and `@effected/semver@0.3.0`. Ranges are now caret-floored at that wave.

Two related hazards from the same loop, worth carrying:

- **Never push while linked.** Unlink, pin the published range, `pnpm install`, then push.
- **A branch's built artifacts can be older than the registry.** During round 8 an upstream branch's sibling `dist/prod` outputs were behind published versions and would have violated that branch's own dependency ranges. Verify versions with `npm view`, not with a pipeline's own report.

Because the action is a **bundled** artifact, a linked library's change is only real here after `pnpm build`: the integration runs the committed `dist`, not `node_modules`.

---

## Rationale

### Commit `dist/` to git

GitHub Actions loads the action directly from the repository at the specified ref. There is no build step in the Actions runtime, so the compiled JavaScript must be present. This applies to every JavaScript GitHub Action.

### rsbuild via `github-action-builder`

rsbuild gives tree shaking, dead code elimination and ES-module output compatible with Node 24. The builder wraps it with the defaults an action needs: entry configuration through `defineConfig`, the module marker, the local copy and clean builds. Its `build.nativeDynamicImports` option is deliberately unset — the production bundle contains no dynamic-import packages, and the build emits zero rspack critical-dependency warnings.

### Local testing copy

`.github/actions/local/` separates test artifacts from the production build. The `test-fixture` composite action references `.github/actions/local` rather than the repository root, so fixture tests run against the built action without interfering with `dist/`.

### The `ignore` list

`ignore` rewrites an import to a throwing stub, which is correct for a package that is genuinely never installed; `externals` would mean "available at runtime", which is the opposite of true.

The three entries (`xmlbuilder2`, `libxmljs2`, `ajv-formats-draft2019`) are optional plugins of `@cyclonedx/cyclonedx-library`, whose `_optPlug` wrapper try/catches the stub throw and falls through. They were needed when `@savvy-web/github-action-effects` pulled cyclonedx in transitively.

**That dependency is gone.** `@cyclonedx/cyclonedx-library` is no longer anywhere in the tree — `@effected/sbom` does not depend on it, and none of the three names appears in any built bundle. The list is currently **vestigial**: harmless, and cheap insurance if a future `@effected/sbom` version reintroduces cyclonedx, but it no longer describes a real transitive dependency. The comment beside it in `action.config.ts` still cites `@savvy-web/github-action-effects` and is stale.

### Three entries, one of them not a hook

Bundling the worker with the same tool and into the same directory is what makes the sibling-path resolution in `startTurboCache` work, and what keeps the worker's dependency set consistent with main's.

---

## Implementation details

### Build process

1. `github-action-builder build` reads `action.config.ts`.
2. Cleans `dist/` and `.github/actions/local/dist/`.
3. Compiles the three entry points through rsbuild.
4. Applies the `ignore` list.
5. Writes minified bundles to `dist/`.
6. Creates `dist/package.json` with `{ "type": "module" }`.
7. Copies bundles to `.github/actions/local/dist/` (per `persistLocal`).

**Always commit both directories.** A change that is not rebuilt is a change CI does not run.

### TypeScript configuration

`module: "ESNext"`, `moduleResolution: "bundler"`, `target: "ES2022"`, `strict: true`, `noEmit: true`, `exactOptionalPropertyTypes` (which is why the optional S3 fields in `server-config.ts` are spread rather than assigned). All imports carry `.js` extensions and Node builtins use the `node:` protocol, both enforced by Biome. Type checking runs on `@typescript/native-preview` (tsgo).

### Release process

1. `pnpm changeset` records the change.
2. The changesets workflow opens a release PR; version application runs through the `savvy` CLI (`ci:version`), which affects release tooling only, never the action source or bundles.
3. Merging bumps `package.json` and `CHANGELOG.md` and creates a GitHub release with tags.
4. `release-sync.yml` moves the `v<major>` alias tag and resets `dev` to `main`.
5. Consumers reference by tag (`savvy-web/silk-runtime-action@v1`).

Commits must be GPG-signed with the GitHub-verified key for `C. Spencer Beggs <spencer@savvyweb.systems>`, or the signature ruleset rejects them.

### Machine-local dev script

`package.json`'s `claude` script points at a sibling checkout (`../../spencerbeggs/effected/plugin`). It is a local developer convenience only — nothing in build, test or CI depends on it, and it is expected to be absent on any other machine.

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) — entry topology and what each bundle contains.
- [Turbo remote cache](./turbo-remote-cache.md) — what the `turbo-server` bundle does and how main finds it.
- [Testing strategy](./testing-strategy.md) — how the local copy is exercised, and the `action.yml` parity guards.

**Source files:**

- `action.config.ts` — build configuration and the `ignore` list.
- `action.yml` — the action definition and the parity contract.
- `package.json` — dependencies, scripts and the `devEngines` pins this repository uses on itself.
