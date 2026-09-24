---
type: Module
title: test-harness
description: The fixture matrix and composite actions that exercise the built action on real runners.
status: draft
kind: harness
resource: ../../.github/actions/test-fixture
generated:
  by: okfit/claude-code
  at: 2026-09-24T01:43:00Z
  body_sha256: 41687abf5ccabaac3f6787c2661e64ee4047b2bc0d766acc84852f114b56c2bd
sources:
  - id: test-fixture-action
    resource: ../../.github/actions/test-fixture/action.yml
  - id: fixtures-claude
    resource: ../../__fixtures__/CLAUDE.md
  - id: workflows-claude
    resource: ../../.github/workflows/CLAUDE.md
  - id: test-yml
    resource: ../../.github/workflows/test.yml
  - id: test-turbo-yml
    resource: ../../.github/workflows/test-turbo-cache.yml
  - id: vitest-config
    resource: ../../vitest.config.ts
---

# test-harness

Fixture-based workflow tests that run the **built** action (`.github/actions/local`, the
mirror `pnpm build` writes) on real GitHub Actions runners — the tier unit tests cannot
reach: the Windows tool-cache layout, the `.cmd` shell launch, lifecycle-script `PATH`
resolution, the cache round trip against the real service, and `bats_load_library`
resolving through an exported environment variable in a later workflow step. Never
published; exists only to exercise artifacts CI already built.

## Fixtures

`__fixtures__/` holds one directory per supported configuration, each a `package.json`
carrying `devEngines.packageManager` and `devEngines.runtime` plus whatever lockfile or
config file the scenario is about — installed `node_modules` are never
committed.[^fixtures-claude]

| Fixture | What it pins |
| --- | --- |
| `node-npm` | node + npm, `package-lock.json` |
| `node-npm-12` | node 26 + npm 12, `package-lock.json` — the "current" npm case; `node-npm` stays "one back" |
| `node-pnpm` | node + pnpm, `pnpm-lock.yaml` |
| `node-pnpm-12` | node 26 + pnpm 12 with a hash-pinned version and `onFail: "download"` on both entries, two-document `pnpm-lock.yaml` — the only fixture exercising pnpm's `download` value |
| `node-yarn` | node + yarn 4, `yarn.lock` + `.pnp.cjs` + `.yarn/` |
| `node-multi` | three runtimes (node, bun, deno) with pnpm as manager; workspace with `pkgs/pkg-{node,bun,deno}` |
| `bun-bun` | bun as **both** runtime and package manager, `bun.lock` |
| `biome-enabled` | `biome.jsonc` — version auto-detected from the `$schema` |
| `turbo-enabled` | `turbo.json` + a seeded `.turbo/cache/` — detection plus an explicit `biome-version` input |
| `bats-kcov` | `hello.sh` + `test/hello.bats` — the `*.bats` glob detection signal, and `bats_load_library` resolving against the exported `BATS_LIB_PATH` |
| `additional-inputs` | `custom.lock` / `vendor.lock` and `build/` / `dist/` for the `additional-lockfiles` and `additional-cache-paths` inputs |
| `turbo-monorepo` | a real pnpm + turbo workspace with a buildable package — used only by the turbo remote-cache e2e |

## The two workflow matrices

| Workflow | Jobs | Covers |
| --- | --- | --- |
| `test.yml` (`Fixtures`) | `test-node-create-cache`, `test-node-restore-cache`, `test-feature-detection`, `test-additional-inputs`, plus an aggregating `summary` | Cold install + cache save; cache restore on a second run; Biome/turbo auto-detection; `additional-lockfiles`/`additional-cache-paths` (newline-separated is the only supported multiline format) |
| `test-turbo-cache.yml` | `double-build`, `dependent-job-hit`, `s3-double-build`, `real-s3-configured`, `real-s3-double-build` | Within-job double build (GitHub backend), a cross-job cache hit via `needs:`, a MinIO-backed S3 double build, a real-S3 secrets-presence gate, and a real-S3 double build[^test-turbo-yml] |

Both `on: pull_request` filters watch `main`, `dev` and `changeset-release/main` — the
third spelled the way changesets spells it, singular `changeset`. It read
`changesets-release/main` for a period, which produced no error and no skipped job, just a
matrix that silently never ran on a release PR; the filter is fixed at
`.github/workflows/test.yml:8-10`. Every job sets `fail-fast: false`, so one broken
combination never hides the rest.[^test-yml]

## Cache pair / double-build patterns

`test-node-create-cache` and `test-node-restore-cache` run as a dependent pair: the first
installs and saves, `needs:` the second and asserts `cache-hit`. Each matrix row passes a
per-row `cache-bust` so runs cannot contaminate each other. `test-turbo-cache.yml`'s jobs
use a double-build pattern instead: run `turbo run` twice inside or across jobs and assert
the second build reports a remote-cache hit rather than a local one.

## What the `bats-kcov` fixture is for

The fixture holds `hello.sh` and `test/hello.bats`, run as `bats --version && bats test/`.
The second half is the whole point: it proves `bats_load_library` resolving through the
exported `BATS_LIB_PATH`, end to end, on a real runner — a claim spanning a process
boundary, a runner-published `GITHUB_ENV`, and a third-party shell builtin that no unit
test can reach.

Two deliberate scoping decisions:

- **Windows is excluded from the matrix.** kcov refuses `win32` outright and the bats
  install path is POSIX-shaped and unvalidated there; an excluded row is honest, where a
  row asserting `false` everywhere would look like coverage.
- **`kcov: "false"` on this fixture's row, even though `auto` would follow the bats
  decision.** The matrix scopes its `cache-bust` to `github.run_id`, so a kcov build here
  could never be restored — every PR would pay a multi-minute source build for a result
  nothing reuses, and because kcov failures degrade to warnings a broken build would not
  even turn the job red: the row would cost minutes and prove nothing. kcov's end-to-end
  validation belongs on a downstream consumer's CI, where the warm-cache path is
  observable. With kcov uniformly off, `expected-kcov-enabled: "false"` is assertable as a
  literal, where following `auto` would make the expected value differ per OS.

## The fixture harness's four steps

`.github/actions/test-fixture/action.yml` is a composite action:[^test-fixture-action]

1. **Compute cache bust** (bash) — resolves the `cache-bust` input (`"true"` generates
   `${{ github.run_id }}-${{ github.run_attempt }}`, `"false"`/empty disables it, anything
   else is used verbatim).
2. **Setup fixture** (python, `action.yml:180-` onward) — deletes everything in the
   workspace except `.github`, `.git` and `__fixtures__`, copies the named fixture to the
   repository root, then deletes `__fixtures__` itself so its contents cannot match the
   action's own lockfile/cache-path globs.
3. **Run the action** — `uses: ./.github/actions/local`, the mirrored bundle `pnpm build`
   writes. Under `test-cache: "true"` this becomes a first run, a dependency check, a
   `node_modules` wipe, and a second run that must restore.
4. **Verify outputs** (python) — `check_value` (`action.yml:443-473`) and `check_contains`
   (`action.yml:475-` onward) compare actual outputs against every `expected-*` input, then
   the step writes a results section.

## The e2e harness must fail on an empty answer

Both `check_value` and `check_contains` used to *return early* on an empty actual, so a
fixture that asserted a value and got back an empty output recorded a pass. Both now fall
through to the comparison when `expected` is non-empty: `check_value`
(`action.yml:458-461`) treats an empty actual as unequal to a non-empty expected;
`check_contains` (`action.yml:489-497`) treats an empty actual's item list as missing every
expected item by definition. An empty **expected** is still a deliberate skip — recorded as
`info` rather than compared — because most `expected-*` inputs default to empty
(`action.yml:445-456`, `:477-487`).

## Runner facts

**A `uses:` step runs at `GITHUB_WORKSPACE` regardless of `defaults.run.working-directory`.**
A `run:` step honours the default; a `uses:` step does not. `test-turbo-cache.yml`'s jobs
set `install-deps: "false"` on every fixture-scoped `uses: ./.github/actions/local` step
(for example `.github/workflows/test-turbo-cache.yml:18-27`) and let a `run:` step — which
does honour the working directory — install the fixture's own dependencies instead. See
[uses-step-ignores-working-directory](../gotchas/uses-step-ignores-working-directory.md)
for the gotcha this fact produces when it is missed.

`ACTIONS_STEP_DEBUG=true` is what surfaces the cache key, the restore ladder, the resolved
path set and the lockfile list — the four things worth reading when a fixture's cache
assertion fails.

## Coverage config

`vitest.config.ts` configures `@vitest-agent/plugin`'s **strict** thresholds with:

```ts
// vitest.config.ts:21-28
coverage: {
  enabled: true,
  provider: "v8",
  thresholds: AgentPlugin.COVERAGE_LEVELS.strict.thresholds,
  include: ["src/**/*.ts"],
  exclude: [],
},
```

`include` is what makes a never-imported source file score **0%** instead of being
silently omitted from the report.

`/* v8 ignore */` is reserved for code only a real runner can execute: `main.ts`'s
`Action.run` call (`src/main.ts:20-23`), `post.ts`'s entry-point guard
(`src/post.ts:396-399`), and the whole body of `turbo-server.ts`
(`src/turbo-server.ts:26-146`). Each of those is covered by the e2e matrices instead.

**Tooling note:** the vitest-agent coverage tool needs the project named explicitly
(`@savvy-web/silk-runtime-action`); the no-argument default reports nothing and looks like
a dead gate.

## Common issues

| Issue | Cause | Fix |
| --- | --- | --- |
| "Service not found" | A layer missing from the composition | Add the matching `X.layerTest({ … })` |
| A double dies mid-test | An unstubbed member was called | Stub it — or ask whether the code should be calling it |
| Input reads as absent | A hand-written `INPUT_*` spelling | Key by input name through `ActionInput.layer` |
| Green unit test, red runner | A state or envelope schema whose encoded form is not JSON | Round-trip it through the real `ActionState` harness |
| Passes locally, fails in CI | Platform branching | Pass an explicit `host` / `platform` and pin both |
| An e2e assertion passes suspiciously | Empty actual against a non-empty expected | Already fixed in the harness; if it recurs, fix the harness first |
| Green suite, fails on a second run in one job | An operation the old double permitted and the platform does not (`copy` onto an existing destination) | Re-check against `@effected/memfs`, which implements the platform's rules |
| `assert.deepStrictEqual` fails on identical-looking values | Prototype mismatch — a decoded `Schema.Class` against an object literal | Assert the fields, not the instance |
| A workflow "runs" but produces no jobs | A `branches:` filter matching nothing | Check the branch name against whatever tool creates it |
| `Fixture 'X' not found` | No such directory | Create it in `__fixtures__/` |
| `Expected X but got Y` | Output mismatch | Check the action, then the expectation |
| Command not found | Runtime never landed on `PATH` | Check the install step's log |

## Related concepts

- [uses-step-ignores-working-directory](../gotchas/uses-step-ignores-working-directory.md)
- [branch-filter-fails-open](../gotchas/branch-filter-fails-open.md)
- [in-memory-doubles-are-more-permissive](../gotchas/in-memory-doubles-are-more-permissive.md)
- [kit-test-layers-and-real-volume](../decisions/kit-test-layers-and-real-volume.md)
- [unit-test-conventions](../conventions/unit-test-conventions.md)
- [verify-against-the-built-artifact](../conventions/verify-against-the-built-artifact.md)

[^fixtures-claude]: ../../\_\_fixtures\_\_/CLAUDE.md
[^test-yml]: ../../.github/workflows/test.yml
[^test-turbo-yml]: ../../.github/workflows/test-turbo-cache.yml
[^test-fixture-action]: ../../.github/actions/test-fixture/action.yml
