---
status: current
module: silk-runtime-action
category: integration
created: 2026-03-21
updated: 2026-09-04
last-synced: 2026-09-04
completeness: 92
related:
  - ./architecture.md
  - ./testing-strategy.md
  - ./turbo-remote-cache.md
dependencies: []
---

# Build and distribution

Build pipeline, bundle configuration, the committed `dist/`, the dependency topology, the dogfood loop's verification rule, and what the minifier can do to a string.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [Dependency topology](#dependency-topology)
4. [Verification means the built artifact](#verification-means-the-built-artifact)
5. [Keeping dev and main coherent](#keeping-dev-and-main-coherent)
6. [Rationale](#rationale)
7. [Implementation details](#implementation-details)
8. [Related documentation](#related-documentation)

---

## Overview

The action is built with `@savvy-web/github-action-builder` (rsbuild-based) and produces compiled JavaScript bundles that are **committed to git**. GitHub Actions loads the action from the checked-out ref with no build step in the runtime, so the compiled output must be present in the repository.

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
- Writing any string literal that has to reach disk verbatim — see [verification means the built artifact](#verification-means-the-built-artifact).

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
| `effect` | The framework. In v4 the former `@effect/platform` is dissolved into core `effect` |
| `@effect/platform-node` | Node platform layers (`NodeFileSystem`, `NodeHttpClient.layerUndici`) |
| `@effected/github-actions` | Every GitHub Actions runtime interaction |
| `@effected/npm` | `PackageManagerPin`, `PackageManagerCache.defaultDirectory` |
| `@effected/lockfiles` | `filenamesFor` — the lockfile names a package manager can produce |
| `@effected/workspaces` | `WorkspaceRoot` / `WorkspaceDiscovery`, behind `restore-cache` |
| `@effected/semver` | `SemVer.ExactVersionString`, which backs `AbsoluteVersion` |
| `@effected/jsonc` | `Jsonc.parse` for `biome.jsonc` |
| `@effected/commands` | `Run.succeeds` / `Run.collect` — the `jq` and `kcov --version` probes, and kcov's build commands |
| `@effected/yaml` | Not imported by `src/`; a required peer of `@effected/lockfiles` |

`@effected/commands` was a declared-but-unimported entry until the BATS/kcov work; `install-bats` and `install-kcov` are its first importers, and kcov's source build is the first time this action spawns a build subprocess at all.

**Every declared dependency but `@effected/yaml` is now imported.** The #348 canon pass deleted seven runtime entries that `src/` had never imported — `@effected/git`, `github`, `glob`, `markdown`, `package-json`, `runtimes` and `sbom`. `@effected/glob` had left the code path when lockfile discovery and hashing moved onto `CacheKey.matchingFiles` / `CacheKey.hashFiles`; `@effected/package-json` left it when `devEngines` decoding moved into `steps/load-config.ts`. None of them cost bundle size — nothing unimported is bundled — but they cost install time, and more importantly they made the manifest a false statement about what the action depends on. A dependency list that includes things nobody imports cannot be used to reason about blast radius when an upstream package breaks.

**No version numbers appear in this doc, deliberately.** Every `@effected/*` range is `catalog:effected` and both `effect` entries are `catalog:effect`, resolved by the `@effected/pnpm-plugin-effect` config dependency. The catalog definitions do not live in this repository; the versions actually installed are in `pnpm-lock.yaml`'s `catalogs:` block. Re-derive them from there rather than trusting prose — a pinned number written here is wrong the first time the plugin publishes.

### Dev (not bundled)

- `@savvy-web/github-action-builder` — the build tool.
- `@savvy-web/silk` — the Biome preset and the `savvy` CLI used by `ci:version`.
- `@vitest-agent/plugin` — test tooling and coverage levels.
- `@effect/vitest` — the Effect-aware test harness.
- `@effected/memfs` — `MemoryFileSystem`, the filesystem double the whole unit suite runs on. See [testing strategy](./testing-strategy.md#the-filesystem-is-a-real-volume).

No pnpm overrides, no patches, no links.

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
2. Take the new versions here — today that means the `effected` catalog moving under `@effected/pnpm-plugin-effect`, not a range edited in this repository's `package.json`.
3. Unlink and remove any `overrides:` entry.
4. Verify with a **cold registry install in CI** — not a warm local one.

That is how the rebuild's loop closed on 2026-08-03, against a four-package release wave. Since then the per-package carets have been replaced by catalog references, which moves the pin one level out: bumping a first-party dependency is a config-dependency bump, and the resolved version is only visible in `pnpm-lock.yaml`.

Two related hazards from the same loop, worth carrying:

- **Never push while linked.** Unlink, pin the published range, `pnpm install`, then push.
- **A branch's built artifacts can be older than the registry.** During round 8 an upstream branch's sibling `dist/prod` outputs were behind published versions and would have violated that branch's own dependency ranges. Verify versions with `npm view`, not with a pipeline's own report.

Because the action is a **bundled** artifact, a linked library's change is only real here after `pnpm build`: the integration runs the committed `dist`, not `node_modules`. That is the same fact, in its dependency-shaped form, as [verification means the built artifact](#verification-means-the-built-artifact) — where it bites source this repository owns.

---

## Verification means the built artifact

> **Rule: this action is bundled and minified, and CI runs the committed `dist`. A string that survives `tsc`, Biome and the unit tests has not thereby been verified. Anything that must reach disk *verbatim* has to be checked against the built bundle.**

This is not a caution. It shipped a production crash that failed **before the action did anything at all**, and it was reviewed clean twice on the way in.

### A string that survives `tsc` is not a string that reaches disk

`install-bats` synthesizes a `load.bash` for `bats-mock` when the tarball ships none. Its content must be exactly:

```bash
source "$(dirname "${BASH_SOURCE[0]}")/stub.bash"
```

Here `${BASH_SOURCE[0]}` is **bash** interpolation, evaluated by the installed script at its own load time. It is not a placeholder for JavaScript to fill in, and it must land on disk unevaluated.

It was originally written as a template literal spelled `` `…$${"{BASH_SOURCE[0]}"}…` `` — an escaped `$` followed by a substitution producing the literal brace text. That construction **evaluates correctly in source**: it was verified by hand, verified independently by a reviewer, and passed the unit suite, which exercises the synthesis path directly. The minifier then **constant-folded the substitution back into a live template substitution**, so `dist/main.js` carried a real `${BASH_SOURCE[0]}` inside a template literal. Every run of the built action died at module load with:

```text
ReferenceError: BASH_SOURCE is not defined
```

Before input parsing. Before the first log group. A green source-level review, a green typecheck and a green test run, and a completely dead action.

The fix is a **plain single-quoted string literal**, inside which `${…}` is inert text that no JavaScript stage can evaluate:

```ts
// biome-ignore lint/suspicious/noTemplateCurlyInString: shell interpolation for the installed script, not a JS template
const BATS_MOCK_LOADER = 'source "$(dirname "${BASH_SOURCE[0]}")/stub.bash"\n';
```

Biome's `noTemplateCurlyInString` exists to catch a `${…}` that *was* meant to be a template. This one was not, and the rule cannot tell the difference — so it is **suppressed rather than worked around, because the workaround is what broke**. Concatenating `"$" + "{BASH_SOURCE[0]}"` invites exactly the same folding and is not an escape either.

Three things generalize out of it, and they are the reason this lives in a design doc rather than only in a code comment:

1. **The minifier is part of the semantics of any literal that must reach disk.** Source-level equivalence is not output-level equivalence. Anything clever enough to need reasoning about is exactly what a folder will reason about too.
2. **A unit test proves the source, not the bundle.** The synthesis test passed the whole time. Only a check against `dist/*.js` — or a fixture running the built action — could have caught this.
3. **Review cannot substitute.** Two people read the escaped form and both concluded, correctly, that it evaluated to the right string *in source*. The wrongness was downstream of what they were reading.

The practical check is one grep against the built bundle after `pnpm build`, for any literal that has to survive verbatim. The `bats-kcov` fixture is the standing structural version of it: it runs the built action, and a loader synthesized wrong takes `bats_load_library` down with it.

---

## Keeping dev and main coherent

`release-sync.yml` is gone. Its replacement is `.github/workflows/branch-sync.yml`, which owns three concerns that all mutate the `dev`/`main` relationship and therefore share one `branch-sync` concurrency group so they cannot race: `sync-dev` evens `dev` out with `main`, `major-tag` moves the `v<major>` alias tag on a published stable release, and `promote` opens (or refreshes) the `dev -> main` PR after a `pnpm/config-deps` merge. Read the workflow for the mechanics — it is heavily commented and it is the source of truth.

Two decisions in it are worth carrying here, because both replace something that was wrong.

**`sync-dev` keys off a push to `main`, not off a published release.** A push to `main` that produces no release — a dependency promotion with no changeset, the common case now that config-dependency bumps flow through `promote` — still has to even the branches out, and the release trigger missed exactly that class. Merging `changeset-release/main` is itself a push to `main`, so the release path is still covered by the broader trigger.

**`dev` is never blindly clobbered.** The old behaviour was a hard reset justified by "dev work always lands in main first"; that is a claim about process, not a check. The workflow now asks the only question that matters — *would resetting lose work?* — by merging `dev` into `main` **in memory** with `git merge-tree --write-tree` and comparing the resulting tree to `main`'s. Equal trees mean `dev` holds no content `main` lacks, and the reset is a content no-op. A `dev` that genuinely is ahead gets rebased instead, and a rebase that conflicts leaves `dev` untouched with a warning.

The subtlety that forces the tree comparison is **squash merges destroy patch-id equality**. `git cherry` and every other commit-level "is this merged?" test compares patch-ids one commit at a time, so N `dev` commits squashed into one commit on `main` match nothing and read as unmerged work — which would have made the safe path never fire on this repository, where `main`'s ruleset allows only squash merges. Content is the source of truth for this question; commits are not.

Every push in the workflow is `--force-with-lease`d against the head it read, so a concurrent push to `dev` aborts the sync rather than losing to it.

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

`module: "ESNext"`, `moduleResolution: "bundler"`, `target: "ES2022"`, `strict: true`, `noEmit: true`, `exactOptionalPropertyTypes` (which is why the optional S3 fields in `server-config.ts` are spread rather than assigned). All imports carry `.js` extensions and Node builtins use the `node:` protocol, both enforced by Biome. Type checking is plain `tsc --noEmit` (`types:check`, run through Turbo by `pnpm typecheck`) against TypeScript 7 — there is no `@typescript/native-preview` dependency, and prose here claimed one until #348.

### Release process

1. `pnpm changeset` records the change.
2. The changesets workflow opens a release PR; version application runs through the `savvy` CLI (`ci:version`), which affects release tooling only, never the action source or bundles.
3. Merging bumps `package.json` and `CHANGELOG.md` and creates a GitHub release with tags.
4. `.github/workflows/branch-sync.yml` moves the `v<major>` alias tag and evens `dev` out with `main` — see [keeping dev and main coherent](#keeping-dev-and-main-coherent).
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
- `pnpm-lock.yaml` — the `catalogs:` block, the only honest record of which `effect` and `@effected/*` versions are installed.
- `.github/workflows/branch-sync.yml` — the `sync-dev` / `major-tag` / `promote` jobs.
