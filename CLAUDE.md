# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Repository Overview

A **JavaScript runtime setup GitHub Action**, entirely driven by `package.json`:

* **Multi-runtime** — `node`, `bun`, `deno`, downloaded from official sources into the tool cache
* **Absolute versions only** — semver ranges are rejected, so builds are reproducible
* **Package manager** — provisioned by `PackageManagerInstaller` (corepack was removed;
  `bun`/`deno` are no-ops, being their own package managers)
* **Dependency caching** — key derived from detected lockfiles, Biome version, turbo presence
* **Optional Biome** — auto-detected from `biome.jsonc` / `biome.json` `$schema`
* **Turbo** — detection plus an embedded remote cache server (Actions cache or S3), or
  passthrough to Vercel

## Requirements

Consuming repositories **MUST** have a root `package.json` with:

1. **`devEngines.packageManager`** — `name` (`npm`|`pnpm`|`yarn`|`bun`|`deno`) + absolute
   `version` ([Corepack devEngines format](https://github.com/nodejs/corepack)).
2. **`devEngines.runtime`** — one object or a non-empty array, each with `name`
   (`node`|`bun`|`deno`) + absolute `version`
   ([pnpm format](https://pnpm.io/package_json#devenginesruntime)).

`onFail` is optional on both (parsed, not acted upon). Versions must be exact
(`"24.11.0"`), never ranges. A top-level corepack `packageManager` pin is ignored —
`devEngines` is the only source of truth.

```json
{
  "name": "my-project",
  "devEngines": {
    "packageManager": { "name": "pnpm", "version": "10.20.0", "onFail": "error" },
    "runtime": [
      { "name": "node", "version": "24.11.0", "onFail": "error" },
      { "name": "bun", "version": "1.3.3", "onFail": "error" }
    ]
  }
}
```

## Technical Stack

* **Framework:** [Effect](https://effect.website) **v4** (`effect@4.0.0-beta.101` via
  `catalog:effect`, supplied by the `@effected/pnpm-plugin-effect` config dependency). In v4
  `@effect/platform` is dissolved into core `effect` (`FileSystem`, `Path`, `HttpClient`
  live there); only Node platform layers ship separately, in `@effect/platform-node`.
  Services are class-based `Context.Service` with exported `*Shape` companion types.
* **Action services:** `@effected/github-actions` (`^0.3.0`) — zero `@actions/*` deps.
  Imported: `Action`, `ActionCache`, `ActionEnvironment`, `ActionInput`, `ActionLogger`,
  `ActionOutputs` (incl. `layerDetached`), `ActionState`, `BlobStore` /
  `GitHubCacheBlobStore`, `CacheKey`, `DetachedProcess`, `GitHubMarkdown`,
  `PackageManagerInstaller`, `ProcessId`, `Secret`, `ToolInstaller`.
* **Other first-party imports:** `@effected/npm` (`PackageManagerPin`), `@effected/semver`
  (`SemVer.ExactVersionString`, backs `AbsoluteVersion`), `@effected/jsonc` (`Jsonc.parse`).
  Remaining `@effected/*` entries (`commands`, `git`, `github`, `glob`, `lockfiles`,
  `markdown`, `package-json`, `runtimes`, `sbom`, `workspaces`, `yaml`) are declared but not
  imported by `src/` — `devEngines` is decoded locally in `steps/load-config.ts`. Every
  range is a published caret; no overrides, links or patches.
* **Build:** `@savvy-web/github-action-builder` (rsbuild) via `action.config.ts`.
* **Cross-phase state:** `src/state.ts` — `CacheState`, `TurboServerState` (`Schema.Class`),
  `STATE_KEYS`; `main` writes, `post` reads.
* **Action type:** compiled Node action (`node24`, see `action.yml`); pnpm and Node pinned
  exactly in `package.json`.
* **Tooling:** Biome extending `@savvy-web/silk`; Vitest + `@effect/vitest` +
  `@vitest-agent/plugin` (unit tests in `__test__/`, plus fixture workflow tests);
  `@typescript/native-preview` for typechecking.

The `claude` script in `package.json` points at a machine-local sibling checkout
(`../../spencerbeggs/effected/plugin`) — a local dev convenience only; nothing in build,
test or CI depends on it.

## Common Commands

```bash
pnpm install
pnpm typecheck          # tsc --noEmit, via turbo
pnpm test               # Vitest (test:watch, test:coverage)
pnpm lint / lint:fix    # Biome (lint:md for markdown)
pnpm build              # REQUIRED before commit
pnpm changeset
```

Always commit source **and** compiled output together
(`git add src/ dist/ .github/actions/local/`). Commits must be GPG-signed with the
GitHub-verified key for `C. Spencer Beggs <spencer@savvyweb.systems>` or the signature
ruleset rejects them.

## Dogfooding First-Party Dependencies

Every dependency below is authored in-house, so a bug or missing API can be fixed **in its
own repo** and dogfooded here before publishing. The action is **bundled** — `pnpm build`
inlines everything into `dist/{main,post,turbo-server}.js`, and the integration runs the
committed `dist`, **not** `node_modules`.

| Package | Repo | Local checkout |
| --- | --- | --- |
| `@effected/*` | `spencerbeggs/effected` | `../../spencerbeggs/effected/packages/<name>` |
| `@savvy-web/github-action-builder` | `savvy-web/systems` | `../systems/packages/github-action-builder` |

**Current state: nothing is linked.** `pnpm-workspace.yaml` carries no `overrides:` entry
and every range is a published caret. The rebuild's dogfood loop closed **2026-08-03** with
the effected release wave — `github-actions@0.3.0`, `npm@0.7.0`, `package-json@0.7.0`,
`semver@0.3.0`.

Cross-repo iteration runs through the **dogfood mailbox protocol** (`.claude/dogfood/`, the
`silk:dogfood` skill): a request goes upstream, the upstream session builds and hands back,
this repo adopts. Links are added lazily, for one round, and removed before push.

**Procedure:** build the library in its own repo
(`cd packages/<name> && node savvy.build.ts --target dev`); link it — `pnpm link
../systems/packages/github-action-builder` for the builder, the `silk:dogfood` protocol for
anything `@effected/*`; iterate (edit → rebuild there → `pnpm typecheck` + `pnpm test` +
`pnpm build` here); keep the declared range correct for the eventual unlinked install.
Library edits ship separately on their own branch. **Never push while linked** — unlink, pin
the published range, `pnpm install`, then push.

**Effect v4 API authority:** `.repos/effect` is a vendored, read-only submodule pinned to
`effect@4.0.0-beta.101` — the source of truth for v4 APIs, whose surface diverges from the
v3 docs on the website. Managed via `savvy repos` / `silk:repos`; do not edit.

### Turbo file caching: `**/.turbo/cache` only

The remote cache server (or Vercel passthrough) is the primary cache. As a complementary
local-restore layer, only `**/.turbo/cache` goes into the Actions file cache.
`**/.turbo/runs`, `.turbo/cookies` and `.turbo/daemon` are deliberately excluded — a
restored stale run summary breaks "latest run = current run" detection in tooling that
parses `turbo --summarize`. See `TURBO_LOCAL_CACHE_PATHS` in `src/steps/cache-config.ts`.

### Known limitation: `ACTIONS_RUNTIME_TOKEN` lifetime

The embedded GitHub backend captures `ACTIONS_RUNTIME_TOKEN` at server spawn time. That
token is a short-lived JWT, so on very long jobs late cache writes may get `401
Unauthorized`. The S3 backend is unaffected — it uses its own credentials.

## Development & Release Cycle

All in-progress work lands on the long-lived **`dev`** branch, never directly on `main`;
`main` always reflects the last released state. `release.yml` pins the shared workflow
(`savvy-web/.github`) at `@dev` so it exercises workflow changes early.

**Flow: `dev` → `main` → release**

1. Work accumulates on `dev`; merge into `main` when ready.
2. The push to `main` triggers **Phase 1** — changeset detection creates/updates
   `changeset-release/main` and the release PR.
3. Pushes to that branch trigger **Phase 2** validation (build, publish dry-runs,
   release-notes preview, sticky comment).
4. Merging the release PR triggers **Phase 3** — publish, Git tags, GitHub release.
5. The published release fires `release-sync.yml`.

**`release-sync.yml`** — on `release: [published]` (plus `workflow_dispatch` with `tag` +
`dry-run`), as the GitHub App bot so its pushes bypass protection without recursing. On a
**stable SemVer release `>= 1.0.0`** (bare `MAJOR.MINOR.PATCH`) it moves the **`v<major>`**
alias tag to the released commit and **hard-resets `dev` to `main` HEAD** — a genuine
clobber, safe because `dev` work always lands in `main` first. Pushes are skipped when the
remote already matches; prerelease, build-metadata and sub-`1.0.0` tags no-op.

## Documentation Structure

* **[src/CLAUDE.md](src/CLAUDE.md)** — source layout, step-contract conventions
* **[**fixtures**/CLAUDE.md](__fixtures__/CLAUDE.md)** — integration test fixtures
* **[.github/workflows/CLAUDE.md](.github/workflows/CLAUDE.md)** — workflow test patterns

### Design Documentation

* **Architecture:** `@./.claude/design/silk-runtime-action/architecture.md`
  Load for system design, entry points, or layer composition.
* **Effect Service Model:** `@./.claude/design/silk-runtime-action/effect-service-model.md`
  Load for services, error handling, or dependency injection.
* **Runtime Installation:** `@./.claude/design/silk-runtime-action/runtime-installation.md`
  Load when modifying runtime descriptors, PM setup, or Biome installation.
* **Caching Strategy:** `@./.claude/design/silk-runtime-action/caching-strategy.md`
  Load for cache keys, lockfiles, or cross-phase state.
* **Build and Distribution:** `@./.claude/design/silk-runtime-action/build-and-distribution.md`
  Load when modifying build config, dist management, or the release process.
* **Turbo Remote Cache:** `@./.claude/design/silk-runtime-action/turbo-remote-cache.md`
  Load for the embedded cache server, backend selection, the artifact codec/handler, or
  server lifecycle and teardown.
* **Testing Strategy:** `@./.claude/design/silk-runtime-action/testing-strategy.md`
  Load when writing tests, mock patterns, or fixture setup.

## Project Structure

```text
.
├── src/
│   ├── main.ts                # Action.run(program, { layer: MainLive })
│   ├── post.ts                # post Effect + Action.run(…, { layer: PostLive })
│   ├── program.ts             # main pipeline: inputs → steps → outputs
│   ├── turbo-server.ts        # detached cache-server entry (third bundle)
│   ├── state.ts               # STATE_KEYS + CacheState + TurboServerState
│   ├── layers/app.ts          # MainLive / PostLive
│   ├── schema/                # domain.ts, inputs.ts, outputs.ts
│   ├── steps/                 # one contract module per pipeline step, in order
│   ├── summary/format.ts      # pure log/panel formatters
│   ├── turbo-cache/           # activation, handler, meta, server-config
│   └── descriptors/           # descriptor.ts + node / bun / deno / biome
├── __test__/unit/             # Vitest suites, mirroring src/ (never co-located)
├── __fixtures__/              # workflow integration test fixtures
├── dist/                      # main.js / post.js / turbo-server.js / package.json
├── .github/actions/local/     # mirrored bundled action for local testing
├── action.config.ts
├── action.yml
└── package.json
```

Step order: `load-config` → `detect-biome` → `detect-turbo` → `restore-cache` →
`install-runtimes` → `setup-package-manager` → `install-dependencies` → `install-biome` →
`turbo-cache` → `summary`; `cache-config` supplies the key/path derivation.

## Action Inputs

All inputs are **optional** and auto-detected when omitted. Runtime and package manager
versions come only from `devEngines` — there are no version inputs.

| Input | Default | Purpose |
| --- | --- | --- |
| `biome-version` | `""` | Override; empty auto-detects from the `$schema`, or skips |
| `install-deps` | `"true"` | Install dependencies |
| `turbo-cache` | `"auto"` | `auto` \| `off`. `auto` starts the embedded server when `turbo.json` exists and no Vercel creds are set |
| `turbo-cache-prefix` | `""` | Key namespace for embedded cache artifacts |
| `turbo-token` / `turbo-team` | `""` | Both together select Vercel passthrough and disable the embedded server |
| `turbo-s3-bucket` | `""` | Presence selects the S3 backend |
| `turbo-s3-region` | `""` | S3 region |
| `turbo-s3-endpoint` | `""` | Custom endpoint (R2/MinIO/Spaces); empty means AWS |
| `turbo-s3-access-key-id` / `-secret-access-key` | `""` | S3 credentials |
| `turbo-s3-session-token` | `""` | For temporary credentials |
| `turbo-s3-prefix` | `""` | Key prefix within the bucket |
| `additional-lockfiles` | `""` | Extra lockfile globs for the cache key; newline-separated |
| `additional-cache-paths` | `""` | Extra paths to cache/restore; newline-separated |
| `cache-bust` | `"false"` | Appended to the cache key, to force a miss. **Testing only** |

## Action Outputs

| Output | Value |
| --- | --- |
| `node-version` / `bun-version` / `deno-version` | Installed version, or empty |
| `node-enabled` / `bun-enabled` / `deno-enabled` | `"true"` \| `"false"` |
| `package-manager` / `package-manager-version` | e.g. `pnpm` / `"10.20.0"` |
| `biome-version` / `biome-enabled` | Installed version (empty if not) / `"true"` \| `"false"` |
| `turbo-enabled` | Whether `turbo.json` was detected |
| `turbo-cache-backend` | `"github"` (embedded Actions cache) \| `"s3"` (embedded S3) \| `"remote"` (Vercel passthrough) \| `"none"` |
| `turbo-cache-port` | Port the embedded server bound to; empty when not started |
| `cache-hit` | `"true"` \| `"partial"` \| `"false"` |
| `lockfiles` / `cache-paths` | Comma-separated, as used for the key / restore |

`biome-enabled` reflects a **successful install**, not detection — a Biome that could not be
fetched degrades to a warning and reports disabled.

## Code Quality Standards

`biome.jsonc` extends `@savvy-web/silk/biome`. **The preset is authoritative** — where this
list and the preset disagree, the preset wins.

* **Indentation:** tabs, width 2; **line width** 120
* **Imports:** lexicographic order, separated type imports, forced `.js` extensions,
  `node:` protocol for builtins
* **Type definitions:** `useConsistentTypeDefinitions` is an **error** and the preset
  enforces **`interface`** — prefer `interface` over `type` for object shapes
* **No unused variables:** error
* **TypeScript:** ESNext + bundler resolution, ES2022, strict, `.js` import extensions

## Build Process

Configured by [`action.config.ts`](action.config.ts), run by
`@savvy-web/github-action-builder`. It bundles three entries — `main.ts`, `post.ts`, and
`turbo-server.ts` (via `entries.workers`) — into `dist/*.js`, minified, with unused optional
cyclonedx plugins (`xmlbuilder2`, `libxmljs2`, `ajv-formats-draft2019`) aliased to throwing
stubs; writes `dist/package.json` (`{ "type": "module" }`); and mirrors everything to
`.github/actions/local/` (`persistLocal`), the copy `test-fixture` runs.

Both directories are committed and cleaned before each build. Rebuild after **any** source
change or CI runs stale code.

## Common Issues

| Issue | Fix |
| --- | --- |
| Changes don't take effect in CI | `pnpm build`, commit `dist/` + `.github/actions/local/` |
| "Module not found" on import | Use `.js` extensions and the `node:` protocol |
| "package.json not found" / "invalid devEngines" | Add both `devEngines` fields |
| "Must be an absolute version … not a semver range" | Drop `^ ~ > < = * x X` — the Schema rejects them |

## Contributing

1. Edit source in `src/` (see [src/CLAUDE.md](src/CLAUDE.md))
2. Add/update unit tests in `__test__/unit/`, mirroring the `src/` path — never co-located
3. Add/update fixtures and workflows if needed
4. `pnpm build`, then commit source + `dist/` + `.github/actions/local/`
5. `pnpm changeset`, push, and verify all tests pass in GitHub Actions
