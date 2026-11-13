---
type: Convention
title: Dependency honesty
description: Every declared @effected/* dependency must be imported by src/ or be a required peer of one that is, and no resolved version ever gets written into prose.
tags: [deps, bundle]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-11-13T18:50:00Z
sources:
  - id: package-json
    resource: ../../package.json
  - id: pnpm-lock-catalogs
    resource: ../../pnpm-lock.yaml
  - id: restore-cache-src
    resource: ../../src/steps/restore-cache.ts
  - id: install-bats-src
    resource: ../../src/steps/install-bats.ts
  - id: install-kcov-src
    resource: ../../src/steps/install-kcov.ts
  - id: root-claude-deps
    resource: ../../CLAUDE.md
integrity:
  generated:
    body: 9c005644fd71af3b
---

# Dependency honesty

Every declared `@effected/*` dependency in `package.json` is either imported by `src/`, or is
a required peer of one that is. Resolve the full peer closure before deleting anything that
looks unused — an import-walker that stops at "not imported" will delete a package the tree
genuinely needs.

## Production dependency table

| Package | Role |
| --- | --- |
| `effect` | The framework. In v4 the former `@effect/platform` is dissolved into core `effect` |
| `@effect/platform-node` | Node platform layers (`NodeFileSystem`, `NodeHttpClient.layerUndici`) |
| `@effected/github-actions` | Every GitHub Actions runtime interaction |
| `@effected/npm` | `PackageManagerPin`, `PackageManagerCache.defaultDirectory` |
| `@effected/lockfiles` | `filenamesFor` — the lockfile names a package manager can produce |
| `@effected/workspaces` | `WorkspaceRoot` / `WorkspaceDiscovery`, imported behind `restore-cache`[^restore-cache-src] |
| `@effected/semver` | `SemVer.ExactVersionString`, which backs `AbsoluteVersion` |
| `@effected/jsonc` | `Jsonc.parse` for `biome.jsonc` |
| `@effected/commands` | `Run.succeeds` / `Run.collect` — the `jq` and `kcov --version` probes, and kcov's build commands[^install-bats-src][^install-kcov-src] |
| `@effected/pnpm` | **Not imported by `src/`** — a required peer of `@effected/lockfiles` |
| `@effected/bun` | **Not imported by `src/`** — a required peer of `@effected/lockfiles` |
| `@effected/glob` | **Not imported by `src/`** — a required peer of `@effected/lockfiles` |

`@effected/commands` was a declared-but-unimported entry until the BATS/kcov work;
`install-bats` and `install-kcov` are its first importers, and kcov's source build is the
first time this action spawns a build subprocess at all.

## Dev dependencies (not bundled)

- `@savvy-web/silk` — the Biome preset and the `savvy` CLI used by `ci:version`.
- `@vitest-agent/plugin` — test tooling and coverage levels.
- `@effect/vitest` — the Effect-aware test harness.
- `@effected/plugin` — the build tool: its `effected` bin runs `effected action build`, and it
  ships the `tsconfig/action.json` preset `tsconfig.json` extends. It also carries the
  `effected-mcp` server for local agent use. Never imported by `src/`; declare the carrier,
  never its internals (`@effected/cli`, `@effected/mcp`, `@effected/engine`,
  `@effected/bundler`).
- `@effected/memfs` — `MemoryFileSystem`, the filesystem double the whole unit suite runs on.

No pnpm overrides, no patches, no links, outside a temporary dogfood loop.

## The rule the #348 pass established

**Every declared dependency but the peer-justified ones must be imported.** The #348 canon pass
deleted seven runtime entries that `src/` had never imported — `@effected/git`, `github`,
`glob`, `markdown`, `package-json`, `runtimes` and `sbom`. `@effected/glob` had left the code
path when lockfile discovery and hashing moved onto `CacheKey.matchingFiles` /
`CacheKey.hashFiles`; `@effected/package-json` left it when `devEngines` decoding moved into
`steps/load-config.ts`. None of the seven cost bundle size — nothing unimported is bundled —
but they cost install time, and more importantly **a dependency list that includes things
nobody imports cannot be used to reason about blast radius when an upstream package
breaks.** A false manifest is not a cosmetic problem: it is the one document a maintainer
reaches for to answer "does this upstream incident affect us," and every unimported entry is
a false positive in that answer.[^package-json]

`@effected/glob`, `@effected/pnpm` and `@effected/bun` are the deliberate exceptions, and
they stay for a documented reason rather than an oversight: nothing in `src/` imports any of
them, and `@effected/lockfiles` requires all three as peers. `@effected/yaml` was one until
`@effected/lockfiles` 0.26.0 dropped it as a peer, and it was removed with that bump. `@effected/glob` is declared again for exactly
that reason, not because the code path came back. An import-walker that stops at "not
imported" deletes exactly these packages — resolve the peer closure first.

## No version numbers in this doc, deliberately

Every Effect-family and `@effected/*` range in `package.json` is `catalog:effected`, resolved
by the `@effected/pnpm-plugin-effected` config dependency.[^package-json] The catalog definitions do not live in this repository; the
versions actually installed are only in `pnpm-lock.yaml`'s `catalogs:` block.[^pnpm-lock-catalogs]
**Never write a resolved version into prose** — a pinned number written here, or in any
other concept, is wrong the first time the plugin publishes. Re-derive the installed version
from `pnpm-lock.yaml` when a version is actually needed for a diagnosis; do not trust or
repeat a number carried in a design note or a chat transcript. Root `CLAUDE.md` restates the
same rule for `@effected/*` broadly: "do not cite a version here."[^root-claude-deps]

[^restore-cache-src]: ../../src/steps/restore-cache.ts
[^install-bats-src]: ../../src/steps/install-bats.ts
[^install-kcov-src]: ../../src/steps/install-kcov.ts
[^package-json]: ../../package.json
[^pnpm-lock-catalogs]: ../../pnpm-lock.yaml
[^root-claude-deps]: ../../CLAUDE.md
