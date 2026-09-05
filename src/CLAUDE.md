# src/

Effect v4 + `@effected/*`. Every step is implemented, tested and composed end to end.

## File map

```text
main.ts                  # thin: program import + the GITHUB_ACTIONS entry guard
post.ts                  # the post Effect + the same guard, over PostLive
program.ts               # main pipeline: inputs → steps → outputs, plus the joins
                         # that need two steps' results at once. No I/O, no formatting.
turbo-server.ts          # detached cache-server entry: http plumbing only, imported
                         # by nothing; every decision lives in turbo-cache/
state.ts                 # STATE_KEYS + four Schema.Class bundles — CacheState,
                         # StoreCacheState, KcovCacheState, TurboServerState
layers/app.ts            # MainLive (ActionCache + ToolInstaller +
                         # PackageManagerInstaller) / PostLive (ActionCache) — only
                         # what ActionServices lacks
schema/domain.ts         # RuntimeName, PackageManagerName, AbsoluteVersion
                         # (@effected/semver ExactVersionString), RuntimeSpec,
                         # PackageManagerSpec, RuntimeConfig, ConfigError
schema/inputs.ts         # INPUT_NAMES + Inputs + loadInputs (ActionInput Config)
schema/outputs.ts        # OUTPUT_NAMES + OutputsModel + initialOutputs + emitOutputs
summary/format.ts        # every string this action renders — see below
turbo-cache/             # activation (the backend-selection table), meta
                         # (TurboArtifactMeta envelope schema), handler
                         # (routes/auth/keys), server-config (TURBOGHA_* env →
                         # backend layer)
descriptors/             # descriptor.ts (RuntimePlan/RuntimeDescriptor) + node, bun,
                         # deno, biome, bats, kcov — pure per-host URL/archive/subpath
                         # resolution
steps/                   # one contract module per pipeline step, in runner order:
                         # load-config, detect-biome, detect-turbo, detect-bats,
                         # cache-config, restore-cache, install-runtimes,
                         # setup-package-manager, install-dependencies, install-biome,
                         # install-bats, install-kcov, turbo-cache, summary
```

Detection precedes the cache restore, and the restore precedes every install. The cache key
is derived from the resolved Biome version and turbo's presence, and a restore that lands is
what makes the installs after it cheap.

`cache-config.ts` is the pure half of the cache step: `lockfilePatterns`, `cachePaths`,
`keySegments`, `RESTORE_DEPTHS`, `TURBO_LOCAL_CACHE_PATHS`. `restore-cache.ts` is the
effectful half that hashes, restores and writes `CacheState`.

## Entry points are uniform

`main.ts` and `post.ts` both end in the same idiom — `if (process.env.GITHUB_ACTIONS) {
await Action.run(…) }` — so importing either module never executes the action. One idiom on
both entries, not one for main and another for post.

The guard only holds while the **test process** does not look like a runner, and under
`pnpm ci:test` on GitHub Actions it otherwise would. `vitest.setup.ts` strips
`GITHUB_ACTIONS`, every `INPUT_*` and every `STATE_*` from the environment before the fork
pool is created; `__test__/unit/environment.test.ts` asserts that from inside a worker,
because a setup file that quietly stopped being wired up is invisible otherwise. If you add
a third entry, it gets the same guard.

## `summary/` — the parity surface

`summary/format.ts` is pure and service-free: `formatDetectLine` (the one-line "Detected …"
headline), `formatTurboLine` (backend + port), `cacheCell` and `buildRuntimeSummary` (the
job-summary panel, via `GitHubMarkdown`). Its prose is what a consumer sees in their
workflow log and job summary, so it is pinned **codepoint-verbatim** in
`__test__/unit/summary/format.test.ts`. Two separator conventions coexist on purpose (ruling
54): the detect line and panel join name to version with a **space**, the log groups and
`Detected …` info lines use `@`. Do not harmonize them.

Everything effectful about the summary — reading `ActionOutputs`, writing the panel —
stays in `steps/summary.ts`.

## The step-contract rule

Per `steps/` module, each a contract change if touched: a declared **result type**, a
**`Data.TaggedError`** with a `reason` literal union (`load-config` reuses `ConfigError`
from `schema/domain.ts`; `cache-config` is pure and has none), and an **explicitly
annotated `R`** — never let `R` be inferred. `program.ts`'s `R` is the union of every
step's; `MainLive` supplies only what `ActionServices` lacks. The module doc states the
failure posture beside the error channel — fail-the-job, degrade-to-warning, or
double-netted — so a kit upgrade that widens a member's channel is a build error at that
line rather than a silently failed job.

## The `oracle N` / `ruling N` / `quirk N` citations

Roughly sixty of these appear in module docs and comments. They are **stable labels for
decisions, not live cross-references**: the v1 source they were derived from and the
rulings ledger that numbered them lived under `docs/superpowers/`, which is a local-only
working tree this repository does not carry (see `.gitignore`). Chasing a number in a clean
checkout finds nothing.

That is deliberate and it is also the whole rule for reading them: **the sentence beside the
citation is the authority, and the number is only provenance.** Every one of them sits next
to a prose statement of the decision it labels, because the tree was already going away when
they were written. If a citation ever appears without that statement, the statement is what
is missing — write it from the code and the tests, do not go looking for the tree.

Do not add new numbered citations. A new decision gets prose and, where it cost something,
the incident that forced it.

## Conventions

- **Tests live in `__test__/unit/`**, mirroring this tree — never co-located.
- **The filesystem double is `@effected/memfs`**, never a hand-rolled `FileSystem.layerNoop`
  over a map. A real volume answers absence honestly, so a read nothing seeded fails the way
  the platform fails it instead of returning whatever a stub's author remembered. Faults —
  a permission error, a recorder that observes a path and delegates — go through
  `MemoryFileSystem.layerFaulty`, whose handlers delegate by default when they return
  `undefined`.
- **`it.effect` plus `assert.*`** from `@effect/vitest`. `expect` is not used.
- **`ProcessId.make`, never `makeUnsafe`** — `makeUnsafe` typechecks through test doubles
  then dies at runtime where `catchDefect` goes blind.
- **API authority:** the installed `.d.ts` under `node_modules/@effected/*`, then
  `.repos/effect` (read-only, pinned to the `effect` version in the catalog). The v4 surface
  diverges from the v3 docs on the website; do not answer from memory.
