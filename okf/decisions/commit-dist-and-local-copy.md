---
title: dist/ is committed, bundled and minified, with a mirrored local testing copy
description: Why the compiled action ships as committed, minified bundles rather than building at runtime, what the ignore list is for, and why a second, identical copy lives under .github/actions/local.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 0d14068dd34f23654e095751aa90663ea15668527aab2fc780044e633c864a6b
sources:
  - id: action-config
    resource: ../../action.config.ts
  - id: action-yml
    resource: ../../action.yml
tags:
  - bundle
  - release
  - ci
---

# dist/ is committed, bundled and minified, with a mirrored local testing copy

## Context

GitHub Actions loads a JavaScript action directly from the checked-out ref, with no build
step in the runtime. Whatever code runs in a consumer's workflow has to already be present
in the repository at that ref, in a form Node can execute without a `node_modules` resolve
step of its own.

## Decision

The action is built with `@savvy-web/github-action-builder` (rsbuild-based) into three
ES-module bundles, minified, and the output is **committed to git**:

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

`action.yml` declares only two runtime entries — main and post:

```yaml
runs:
  using: node24
  main: dist/main.js
  post: dist/post.js
```

The `workers.turbo-server` entry produces `dist/turbo-server.js`, the detached embedded
Turbo remote-cache server that `main` spawns at runtime. It is **not** a lifecycle hook —
`action.yml` names nothing beyond `main`/`post` — and `main` resolves it as a sibling of its
own bundle through `import.meta.url`, which is meaningful only once the two files sit
side by side in `dist/`.[^action-config][^action-yml]

**rsbuild via `github-action-builder`** gives tree shaking, dead code elimination, and
ES-module output compatible with the pinned Node runtime. The builder wraps rsbuild with the
defaults an action needs: entry configuration through `defineConfig`, the `dist/package.json`
module marker (`{ "type": "module" }`), the local copy, and clean builds before every
run.[^action-config] Its `build.nativeDynamicImports` option is deliberately left unset — the
production bundle contains no dynamic-import packages, and the build emits zero rspack
critical-dependency warnings as a result.

**A mirrored local testing copy at `.github/actions/local/`** separates test artifacts from
the production build. `persistLocal` writes the same three bundles there, and the
`test-fixture` composite action references that directory rather than the repository root,
so fixture tests run against the built action without interfering with `dist/`.[^action-config]

**The `ignore` list is a stub, not an `externals` declaration.** `ignore` rewrites an import
to a throwing stub — correct for a package genuinely never installed — while `externals`
would mean "available at runtime," the opposite of true for anything in this list. The three
entries (`xmlbuilder2`, `libxmljs2`, `ajv-formats-draft2019`) are optional plugins of
`@cyclonedx/cyclonedx-library`, needed when a prior dependency pulled cyclonedx in
transitively. That dependency is gone from the tree today, so the list is currently
**vestigial**: harmless, and cheap insurance if a future dependency reintroduces cyclonedx,
but it no longer describes a real transitive dependency.[^action-config]

**Three build entries, one of them not a hook.** Bundling the worker with the same tool and
into the same output directory as `main`/`post` is what makes the worker's sibling-path
resolution work, and what keeps its dependency set consistent with `main`'s rather than
drifting as a separately built artifact.[^action-config]

**Build process**, in order: read `action.config.ts`; clean `dist/` and
`.github/actions/local/dist/`; compile the three entry points through rsbuild; apply the
`ignore` list; write minified bundles to `dist/`; write `dist/package.json`; copy bundles to
`.github/actions/local/dist/`.[^action-config]

**TypeScript configuration** targets `ESNext`/`bundler`-resolution/`ES2022`, with `strict`
and `exactOptionalPropertyTypes` enabled — the reason optional fields assembled from
environment reads are spread into an object literal rather than assigned, so an absent
optional value is genuinely omitted rather than set to `undefined`. Type checking is plain
`tsc --noEmit` through Turbo's `types:check` task, not a separate native-preview
toolchain.

**Always commit both directories.** A change that is not rebuilt is a change CI does not
run — see [`../conventions/verify-against-the-built-artifact.md`](../conventions/verify-against-the-built-artifact.md)
for what can go wrong when a literal that must reach disk verbatim is verified only against
source.

## Alternatives rejected

- **Building at workflow-run time.** GitHub Actions has no build step for a JavaScript
  action; every consumer's run would need its own build toolchain, defeating the point of a
  distributable action.
- **`externals` instead of `ignore` for the vestigial cyclonedx plugin names.** `externals`
  asserts the package is available at runtime, which is false for all three — none is
  installed, and none should be assumed present in a consumer's environment.
- **Deleting the vestigial `ignore` entries now that cyclonedx is gone.** Kept as cheap
  insurance against a future dependency reintroducing the same optional-plugin shape; the
  cost of leaving them is three inert stub aliases.
- **Running fixture tests against `dist/` directly, without a separate local copy.** Would
  make fixture runs and production build output the same artifact, so a fixture-only change
  could not be tested without touching the shipped bundle.

## Consequences

Every commit that changes `src/` must also carry a rebuilt `dist/` and
`.github/actions/local/`, or CI runs stale code with no error to say so — the discipline
`verify-against-the-built-artifact` names outright. The committed bundles are the actual
contract a consuming workflow runs; source review alone cannot verify behavior that depends
on what the minifier did to a literal.

[^action-config]: action-config
[^action-yml]: action-yml
