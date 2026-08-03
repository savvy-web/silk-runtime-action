# **fixtures**/CLAUDE.md

Self-contained project configurations used as integration tests for the action.

**See also:** [Root CLAUDE.md](../CLAUDE.md) |
[.github/workflows/CLAUDE.md](../.github/workflows/CLAUDE.md)

## What a fixture is

A directory whose contents are copied to the repository root, replacing everything else,
before the action runs against it. Each holds the minimum needed for one scenario: a
`package.json` with `devEngines.packageManager` and `devEngines.runtime` (**required** —
the action reads nothing else for versions), plus whatever lockfile or config file the
scenario is about. Installed `node_modules` are never committed.

## The fixtures

| Fixture | What it pins |
| --- | --- |
| `node-npm` | node + npm, `package-lock.json` |
| `node-pnpm` | node + pnpm, `pnpm-lock.yaml` |
| `node-yarn` | node + yarn 4, `yarn.lock` + `.pnp.cjs` + `.yarn/` |
| `node-multi` | three runtimes (node, bun, deno) with pnpm as manager; workspace with `pkgs/pkg-{node,bun,deno}` |
| `bun-bun` | bun as **both** runtime and package manager, `bun.lock` |
| `biome-enabled` | `biome.jsonc` — version auto-detected from the `$schema` |
| `turbo-enabled` | `turbo.json` + a seeded `.turbo/cache/` — detection plus an explicit `biome-version` input |
| `additional-inputs` | `custom.lock` / `vendor.lock` and `build/` / `dist/` for the `additional-lockfiles` and `additional-cache-paths` inputs |
| `turbo-monorepo` | a real pnpm + turbo workspace with a buildable package — used only by the turbo remote-cache e2e |

## How they run

**[test.yml](../.github/workflows/test.yml)** (`Fixtures`) — on `workflow_dispatch`,
pushes to `main` and PRs touching `src/`, `dist/`, `action.yml`, `__fixtures__/` or the
test actions. Four matrix jobs plus an aggregating `summary`:

* `test-node-create-cache` — npm/pnpm/yarn/multi/bun × ubuntu/macos/windows, cache miss
* `test-node-restore-cache` — the same minus bun, `needs:` the create job, expects a hit
* `test-feature-detection` — `biome-enabled` and `turbo-enabled` × 3 OS, `install-deps: false`
* `test-additional-inputs` — ubuntu only; **newline-separated** multiline inputs are the
  only supported format (bullets, commas and JSON arrays were dropped in the v2 migration)

Each matrix row passes a per-row `cache-bust` (`${pm}-${os}-${run_id}`) so runs cannot
contaminate each other, and every step is `continue-on-error` so `save-test-results`,
`upload-artifact` and `fail-if-test-failed` always run.

**[test-turbo-cache.yml](../.github/workflows/test-turbo-cache.yml)** — `turbo-monorepo`
only, on PRs and dispatch. Within-job double build (GitHub backend), cross-job cache hit on
a cold runner, an S3 double build against MinIO, and the same against real S3 behind a
secrets-presence gate job so forks skip rather than fail. Each asserts the reported
`turbo-cache-backend` and `turbo-cache-port` before proving the cache hit.

## The harness

[`.github/actions/test-fixture`](../.github/actions/test-fixture/action.yml) is one
composite action doing setup, execution and verification:

1. **Setup** (Python) — delete everything except `.github`, `.git` and `__fixtures__`; copy
   the fixture to the root; delete `__fixtures__` so its globs cannot interfere.
2. **Run** `./.github/actions/local` (the committed build — run `pnpm build` first, or the
   test exercises stale code). `test-cache: "true"` instead runs it twice around a
   `node_modules` wipe.
3. **Verify** (Python) — `check_value` for scalars, `check_contains` for the comma-listed
   `lockfiles` / `cache-paths`, emitting `test-passed` and a `test-results` JSON blob.

**Assertion semantics, deliberately hardened:** an empty `expected-*` is the opt-out and
still skips (a non-empty actual is recorded as `info`). An **empty actual against a
non-empty expected now fails.** Both checks used to return early on an empty actual, so a
fixture asserting an output the action had stopped publishing recorded nothing at all —
the exact regression these assertions exist to catch passed as quietly as a match.

## Adding a fixture

1. `mkdir __fixtures__/<name>/` and add a `package.json` with both `devEngines` fields,
   plus only the files the scenario needs.
2. Add a matrix row in `test.yml`: `fixture`, `title` (with emoji), any feature inputs, and
   an `expected-*` for **every** output the scenario should pin. Leave an expectation out
   only when you mean "don't care" — empty means skipped.
3. Commit the fixture; keep it minimal, realistic, secret-free and platform-agnostic.
