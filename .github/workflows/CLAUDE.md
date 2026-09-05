# .github/workflows/CLAUDE.md

How this repository tests itself against real runners, and the composite actions that make
that legible.

**See also:** [Root CLAUDE.md](../../CLAUDE.md) |
[**fixtures**/CLAUDE.md](../../__fixtures__/CLAUDE.md) for the fixtures each job runs.

## The workflows

| Workflow | What it does |
| --- | --- |
| [test.yml](test.yml) (`Fixtures`) | The fixture matrix — four jobs plus an aggregating summary |
| [test-turbo-cache.yml](test-turbo-cache.yml) | The embedded turbo remote-cache server, end to end |
| [release.yml](release.yml) (`Silk`) | Delegates to `savvy-web/.github`'s shared release workflow at `@main` |
| [branch-sync.yml](branch-sync.yml) | Keeps the `dev` / `main` pair coherent; moves the `v<major>` tag |
| [silk-update.yml](silk-update.yml) | Config-dependency updates (schedule commented out; dispatch only) |
| [dco.yml](dco.yml), [claude.yml](claude.yml), [project-listener.yml](project-listener.yml) | House automation |
| [act-test.yml](act-test.yml) | `workflow_dispatch` only — see [act](#a-note-on-act) |

`test.yml` runs on `workflow_dispatch` and on pull requests into `main`, `dev` and
`changeset-release/main`. **That third branch name is spelled the way changesets spells
it** — singular `changeset`, matching `release.yml`. It was `changesets-release/main` here
for a while, which silently meant the fixture matrix never ran on a release PR: a wrong
branch name in an `on:` filter produces no error, no skipped job and no annotation, just
absence.

## `test.yml` — the fixture matrix

Four jobs, then a summary that aggregates them.

| Job | Axes | Proves |
| --- | --- | --- |
| `test-node-create-cache` | `os` × `pm` (`npm`, `pnpm`, `yarn`, `multi`, `bun`, `bats`) | A cold run installs and populates the cache |
| `test-node-restore-cache` | the same | The second run restores what the first wrote |
| `test-feature-detection` | `os` × `fixture` (`biome-enabled`, `turbo-enabled`) | Biome auto-detection and turbo detection |
| `test-additional-inputs` | `format` | `additional-lockfiles` / `additional-cache-paths` reach the key and the restore |
| `summary` | — | Aggregates every uploaded result; `if: always()` |

The `os` axis is `ubuntu-latest`, `macos-latest` and `windows-latest`; `bats` is excluded on
Windows. Every job sets `fail-fast: false`, so one broken combination does not hide the rest.

**The matrix carries expectations as data.** A row names its fixture, its title, and the
`expected-*` values; the step body is the same in every row. Adding a case is adding a row,
not adding a step.

```yaml
matrix:
  os: [ubuntu-latest, macos-latest, windows-latest]
  fixture: [biome-enabled, turbo-enabled]
  include:
    - fixture: biome-enabled
      install-deps: "false"
      expected-package-manager: npm
      expected-biome-enabled: "true"
      expected-biome-version: 2.4.9
      title: 🔧 Biome Auto-Detect
```

Each job's steps are the same four: run `test-fixture` with `continue-on-error: true`, save
its result through `save-test-results`, upload that as an artifact, then fail the job through
`fail-if-test-failed`. The indirection exists so a failing fixture still uploads its result
and still reaches the summary — a job that simply failed at the fixture step would leave the
aggregate blind to it.

## `test-turbo-cache.yml`

Exercises the embedded remote-cache server end to end: a within-job double build on the
GitHub backend, a cross-job cache hit, an S3 backend run against MinIO, and a real-S3 job
gated on the `TURBO_S3_*` secrets being present. Fixtures install their own dependencies in
`run:` steps (`install-deps: "false"`) because `uses:` steps always execute at the repository
root.

## The composite actions

### [test-fixture](../actions/test-fixture/action.yml)

Sets up a fixture, runs the action, and verifies its outputs — one step instead of three.

1. **Compute cache bust** (bash) — resolves the `cache-bust` input.
2. **Setup fixture** (python) — clears the workspace except `.github`, `.git` and
   `__fixtures__`, copies the fixture to the root, then removes `__fixtures__` so its
   contents cannot match the action's own globs.
3. **Run the action** — `uses: ./.github/actions/local`, the mirrored bundle `pnpm build`
   writes. Under `test-cache: "true"` this becomes a first run, a dependency check, a
   `node_modules` wipe, and a second run that must restore.
4. **Verify outputs** (python) — compares actual against every `expected-*` input and writes
   the results section.

Its inputs are the action's own inputs (`biome-version`, `install-deps`, `bats`, `kcov`,
`turbo-token`, `turbo-team`, `cache-bust`, `additional-lockfiles`, `additional-cache-paths`)
plus `fixture`, `title`, `test-cache`, and one `expected-*` per assertion. **Read
`action.yml` for the current list rather than a list written here** — the two drift, and the
manifest is the one CI reads.

Outputs: `test-passed`, `test-results` (JSON), `setup-error`.

### [save-test-results](../actions/save-test-results/action.yml)

Writes one job's `test-results` JSON to `test-results/` with its name, os, title and fixture
attached, so the summary job can group across the matrix.

### [fail-if-test-failed](../actions/fail-if-test-failed/action.yml)

Fails the job when `test-passed` is `false` **or empty** — the empty case is the one that
matters, because a `test-fixture` that died before producing an output would otherwise
report green.

### [local](../actions/local/)

The compiled action, mirrored out of `dist/` by `persistLocal` in
[`action.config.ts`](../../action.config.ts). It is committed, and it is what `test-fixture`
runs — a workflow cannot `uses:` a path that is only built at job time. **Rebuild and commit
it with every source change** (`pnpm build`, then `git add src/ dist/ .github/actions/local/`)
or CI tests stale code and says nothing about it.

## Adding a test

1. **A new case for an existing job** — add a row to that job's `matrix.include`.
2. **A new fixture** — create `__fixtures__/<name>/` with a `package.json` carrying
   `devEngines.packageManager` and `devEngines.runtime`, then reference it from a matrix row.
   See [**fixtures**/CLAUDE.md](../../__fixtures__/CLAUDE.md).
3. **A new job** — copy an existing job's four steps verbatim and add it to `summary.needs`.
   A job missing from `needs` runs but never blocks the summary, which is the same silence
   the branch-name bug produced.

## Debugging a failure

The aggregated summary names the failing combination; the job log has the action's own
run-context block, its per-step lines, and its `Result` block. `expected X but got Y` from
the verify step means either the action regressed or the expectation is stale — check the
fixture's `package.json` before changing the action.

| Message | Cause | Fix |
| --- | --- | --- |
| `Fixture 'X' not found` | No such directory | Create it in `__fixtures__/` |
| `Expected X but got Y` | Output mismatch | Check the action, then the expectation |
| Command not found | Runtime never landed on PATH | Check the install step's log |

## A note on `act`

`act-test.yml` exists and targets `.github/actions/local`, but **`act` is not part of the
normal loop in this repository** — nobody runs it locally, and the `local` mirror is
committed because `test-fixture` needs it, not because `act` does. Treat the workflow as a
dormant escape hatch: do not build new tooling around it, and do not cite it as the reason
something is committed.
