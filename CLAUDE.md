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

* **Framework:** [Effect](https://effect.website) **v4**, via `catalog:effect` — an exact
  pin supplied by the `@effected/pnpm-plugin-effect` config dependency, so read the version
  out of `pnpm-lock.yaml`'s `catalogs:` block rather than from here. In v4
  `@effect/platform` is dissolved into core `effect` (`FileSystem`, `Path`, `HttpClient`
  live there); only Node platform layers ship separately, in `@effect/platform-node`.
  Services are class-based `Context.Service` with exported `*Shape` companion types.
* **Action services:** `@effected/github-actions` — zero `@actions/*` deps.
  Imported: `Action`, `ActionCache`, `ActionEnvironment`, `ActionInput`, `ActionLogger`,
  `ActionOutputs` (incl. `layerDetached`), `ActionState`, `BlobStore` /
  `GitHubCacheBlobStore`, `CacheKey` (incl. `digest`), `ChildEnv`, `DetachedProcess`,
  `GitHubMarkdown`, `PackageManagerInstaller`, `ProcessId`, `Secret`, `ToolInstaller`.
  `GitHubContext.branch` (off `ActionEnvironment.github`) is the branch fallback chain.
  **Do not cite a version here** — every `@effected/*` range is `catalog:effected`, resolved
  by the `@effected/pnpm-plugin-effect` config dependency, so the installed version is in
  `pnpm-lock.yaml`'s `catalogs:` block and nowhere else. Re-derive it; a number written into
  this file is stale by the next bump, and kit-surface claims are re-verified against the
  installed version on every bump, not against this paragraph.
* **Other first-party imports:** `@effected/npm` (`PackageManagerPin`,
  `PackageManagerCache.defaultDirectory` — the cited default-cache-directory table),
  `@effected/lockfiles` (`filenamesFor`), `@effected/semver` (`SemVer.ExactVersionString`,
  backs `AbsoluteVersion`), `@effected/jsonc` (`Jsonc.parse`), `@effected/commands` (`Run`,
  used by the `install-bats` and `install-kcov` steps), `@effected/workspaces`
  (`WorkspaceDiscovery`, `WorkspaceRoot`).
* **Dependency honesty.** Every declared `@effected/*` dependency is either imported by
  `src/` **or** a required peer of one that is. Today the one peer-only entry is
  `@effected/yaml`, which `@effected/lockfiles` requires; everything else in the list is
  imported. **Resolve the peer closure before deleting anything that looks unused.** Eight
  declarations had no import in `src/` at the #348 reconciliation; seven were genuinely dead
  and were removed, and the eighth was `@effected/yaml`, which nothing here imports and
  `@effected/lockfiles` requires. An import-walker that stops at "not imported" deletes it.
* **Test doubles:** `@effected/memfs` (devDependency) is the filesystem double —
  `MemoryFileSystem.layerWith` for a seeded volume, `layerFaulty` for an injected failure or
  a delegating recorder. `FileSystem.layerNoop` is not used anywhere in the suite.
* **Build:** `@savvy-web/github-action-builder` (rsbuild) via `action.config.ts`.
* **Cross-phase state:** `src/state.ts` — `STATE_KEYS` plus four `Schema.Class` bundles:
  `CacheState`, `StoreCacheState`, `KcovCacheState`, `TurboServerState`. `main` writes,
  `post` reads, and each branch in `post` absorbs its own failure so no one of them can cost
  another its save.
* **Action type:** compiled Node action (`node24`, see `action.yml`); pnpm and Node pinned
  exactly in `package.json`.
* **Tooling:** Biome extending `@savvy-web/silk`; Vitest + `@effect/vitest` +
  `@vitest-agent/plugin` (unit tests in `__test__/unit/`, plus fixture workflow tests);
  `tsc --noEmit` for typechecking, through turbo's `types:check` task. Tests use `it.effect`
  and `assert.*`; `expect` is not used.

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
```

There is **no `changeset` script**. Changesets are authored through the `/silk:changeset`
skill; `pnpm exec savvy changeset` covers the rest of the lifecycle (`lint`, `check`,
`deps`, `version`) and has no `add` subcommand. `pnpm ci:version` is what the release
workflow runs.

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

**To find out whether anything is linked, read the tree, not this paragraph:**
`pnpm-workspace.yaml` carries an `overrides:` entry while a link is live and none when it is
not. Every published range is `catalog:effected` / `catalog:effect`, resolved by the
`@effected/pnpm-plugin-effect` config dependency — there are no hand-written carets to read
a link out of.

Cross-repo iteration runs through the **dogfood mailbox protocol** (the `silk:dogfood`
skill): a request goes upstream, the upstream session builds and hands back, this repo
adopts. Links are added lazily, for one round, and removed before push. The mailbox lives at
`.claude/dogfood/`, which is **gitignored local-only state** created by the skill when a loop
starts — a clean checkout has no such directory, and that is correct rather than missing.

**Procedure:** build the library in its own repo
(`cd packages/<name> && node savvy.build.ts --target dev`); link it — `pnpm link
../systems/packages/github-action-builder` for the builder, the `silk:dogfood` protocol for
anything `@effected/*`; iterate (edit → rebuild there → `pnpm typecheck` + `pnpm test` +
`pnpm build` here); keep the declared range correct for the eventual unlinked install.
Library edits ship separately on their own branch. **Never push while linked** — unlink, pin
the published range, `pnpm install`, then push.

**Effect v4 API authority:** `.repos/effect` is a vendored, read-only submodule pinned to
the `effect` version in the catalog — the source of truth for v4 APIs, whose surface
diverges from the v3 docs on the website. Managed via `savvy repos` / `silk:repos`; do not
edit. The pin is re-verified on every `effect` bump; where the submodule and `node_modules`
disagree, `node_modules` wins and the pin is what is stale.

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
`main` always reflects the last released state. `release.yml` delegates to the shared
workflow (`savvy-web/.github/.github/workflows/release.yml`) pinned at **`@main`**.

**Flow: `dev` → `main` → release**

1. Work accumulates on `dev`; merge into `main` when ready.
2. The push to `main` triggers **Phase 1** — changeset detection creates/updates
   `changeset-release/main` and the release PR.
3. Pushes to that branch trigger **Phase 2** validation (build, publish dry-runs,
   release-notes preview, sticky comment).
4. Merging the release PR triggers **Phase 3** — publish, Git tags, GitHub release.
5. `branch-sync.yml` puts the branch pair back in order (below).

**`Closes #N` does not fire on a merge into `dev`.** GitHub auto-closes a linked issue only
when the PR merges into the **default branch**, and ordinary work here targets `dev` — so
close the issue by hand after merging, with a pointer to the merge commit. Keep the trailer
in the PR body anyway: it still links the issue in the UI, and it is what fires later when
`dev` reaches `main`. Two issues were left silently open this way before it was noticed.

**`branch-sync.yml`** — three jobs, one concurrency group, each running as the GitHub App bot
so its pushes bypass protection without recursing. It replaced the old `release-sync.yml`,
and two of the differences are load-bearing:

* **`sync-dev`** keys off **`main` moving** (`push: [main]`), not off a release being
  published. A push to `main` that produces no release — a dependency promotion with no
  changeset — still has to even the branches out, and keying on `release` missed exactly
  that case.
* **`dev` is never blindly clobbered.** The job merges `dev` into `main` *in memory*
  (`git merge-tree --write-tree`) and resets only when the resulting tree equals `main`'s —
  content, not commits, because a squash merge destroys patch-id equality and would read as
  unmerged work. A `dev` that genuinely holds something `main` lacks is **rebased**; if the
  rebase conflicts, nothing is touched and the job warns. Every push is
  `--force-with-lease`d against the `dev` head it read, so a concurrent push aborts the sync
  rather than losing to it.
* **`major-tag`** moves the `v<major>` alias tag on `release: [published]`.
* **`promote`** opens or refreshes the `dev` → `main` PR when a `pnpm/config-deps` branch
  merges into `dev`.

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
│   ├── main.ts                # program import + the GITHUB_ACTIONS entry guard
│   ├── post.ts                # post Effect + the same guard, over PostLive
│   ├── program.ts             # main pipeline: inputs → steps → outputs
│   ├── turbo-server.ts        # detached cache-server entry (third bundle)
│   ├── state.ts               # STATE_KEYS + CacheState / StoreCacheState /
│   │                          # KcovCacheState / TurboServerState
│   ├── layers/app.ts          # MainLive / PostLive
│   ├── schema/                # domain.ts, inputs.ts, outputs.ts
│   ├── steps/                 # one contract module per pipeline step, in order
│   ├── summary/format.ts      # pure log/panel formatters
│   ├── turbo-cache/           # activation, handler, meta, server-config
│   └── descriptors/           # descriptor.ts + node / bun / deno / biome / bats / kcov
├── __test__/unit/             # Vitest suites, mirroring src/ (never co-located)
├── __fixtures__/              # workflow integration test fixtures
├── lib/configs/               # markdownlint-cli2, commitlint, lint-staged
├── dist/                      # main.js / post.js / turbo-server.js / package.json
├── .github/actions/local/     # mirrored bundled action, the target test-fixture runs
├── .repos/effect              # vendored, read-only Effect v4 source (submodule)
├── action.config.ts
├── action.yml
├── biome.json
├── vitest.config.ts
├── vitest.setup.ts            # strips GITHUB_ACTIONS / INPUT_* / STATE_* from the
│                              # test process, which is what keeps the entry guards honest
└── package.json
```

Step order: `load-config` → `detect-biome` → `detect-turbo` → `detect-bats` →
`restore-cache` → `install-runtimes` → `setup-package-manager` → `install-dependencies` →
`install-biome` → `install-bats` → `install-kcov` → `turbo-cache` → `summary`;
`cache-config` supplies the key/path derivation.

## Action Inputs

All inputs are **optional** and auto-detected when omitted. Runtime and package manager
versions come only from `devEngines` — there are no version inputs.

| Input | Default | Purpose |
| --- | --- | --- |
| `biome-version` | `""` | Override; empty auto-detects from the `$schema`, or skips |
| `install-deps` | `"true"` | Install dependencies |
| `ignore-scripts` | `"false"` | Skip lifecycle scripts during the install — `--ignore-scripts` (npm/pnpm/bun), `--mode=skip-build` (yarn Berry). Inert when `install-deps` is `false` or the manager is deno. Part of the cache key |
| `bats` | `"auto"` | `auto` \| `true` \| `false`. `auto` installs bats-core, bats-support, bats-assert, bats-file and bats-mock when a `*.bats` file or a `vitest-bats` dependency is present |
| `kcov` | `"auto"` | `auto` \| `true` \| `false`. `auto` follows the bats decision; built from source and cached, never installed when bats is off |
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
| `bats-version` / `bats-enabled` | Installed bats-core version (empty if not) / `"true"` \| `"false"` |
| `bats-lib-path` | Exported `BATS_LIB_PATH`, or empty when bats was not installed |
| `kcov-version` / `kcov-enabled` | Installed kcov version (empty if not) / `"true"` \| `"false"` |
| `kcov-cache-hit` | Whether kcov was restored from the Actions cache rather than built |
| `turbo-enabled` | Whether `turbo.json` was detected |
| `turbo-cache-backend` | `"github"` (embedded Actions cache) \| `"s3"` (embedded S3) \| `"remote"` (Vercel passthrough) \| `"none"` |
| `turbo-cache-port` | Port the embedded server bound to; empty when not started |
| `cache-hit` | `"true"` \| `"partial"` \| `"false"` — the workspace archive |
| `store-cache-hit` | `"true"` \| `"partial"` \| `"false"` — the package-manager store, keyed independently |
| `lockfiles` / `cache-paths` | Comma-separated, as used for the key / restore (both entries) |

`biome-enabled` reflects a **successful install**, not detection — a Biome that could not be
fetched degrades to a warning and reports disabled.

## Code Quality Standards

`biome.json` extends `@savvy-web/silk/biome`. **The preset is authoritative** — where this
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
2. Add/update unit tests in `__test__/unit/`, mirroring the `src/` path — never co-located.
   `it.effect` + `assert.*`, and `@effected/memfs` for anything filesystem-shaped
3. Add/update fixtures and workflows if needed
4. `pnpm build`, then commit source + `dist/` + `.github/actions/local/`
5. Write a changeset with `/silk:changeset`, push, and verify all tests pass in GitHub
   Actions
