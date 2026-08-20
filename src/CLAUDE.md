# src/

Effect v4 + `@effected/*`. The rebuild is complete: every step is implemented, tested and
composed end to end.

## File map

```text
main.ts                  # Action.run(program, { layer: MainLive })
post.ts                  # post Effect + guarded Action.run(…, { layer: PostLive })
program.ts               # main pipeline: inputs → steps → outputs, plus the joins
                         # that need two steps' results at once. No I/O, no formatting.
turbo-server.ts          # detached cache-server entry: http plumbing only, imported
                         # by nothing; every decision lives in turbo-cache/
state.ts                 # STATE_KEYS + CacheState + TurboServerState (Schema.Class)
layers/app.ts            # MainLive (ActionCache + PackageManagerInstaller over
                         # ToolInstaller) / PostLive (ActionCache) — only what
                         # ActionServices lacks
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
                         # deno, biome — pure per-host URL/archive/subpath resolution
steps/                   # one contract module per pipeline step, in runner order:
                         # load-config, detect-biome, detect-turbo, cache-config,
                         # restore-cache, install-runtimes, setup-package-manager,
                         # install-dependencies, install-biome, turbo-cache, summary
```

Detection precedes the cache restore, and the restore precedes every install —
the legacy ordering (`legacy-v1/program.ts:382-411,476`). The cache key is derived from the
resolved Biome version and turbo's presence, and a restore that lands is what makes the
installs after it cheap.

`cache-config.ts` is the pure half of the cache step: `lockfilePatterns`, `cachePaths`,
`keySegments`, `RESTORE_DEPTHS`, `TURBO_LOCAL_CACHE_PATHS`. `restore-cache.ts` is the
effectful half that hashes, restores and writes `CacheState`.

## `summary/` — the parity surface

`summary/format.ts` is pure and service-free: `formatDetectLine` (the one-line "Detected …"
headline), `formatTurboLine` (backend + port), `cacheCell` and `buildRuntimeSummary` (the
job-summary panel, via `GitHubMarkdown`). Its prose is what a consumer sees in their
workflow log and job summary, so it is pinned **codepoint-verbatim** against the legacy
surface in `__test__/unit/summary/format.test.ts`. Two separator conventions coexist on
purpose (ruling 54): the detect line and panel join name to version with a **space**, the
log groups and `Detected …` info lines use `@`. Do not harmonize them.

Everything effectful about the summary — reading `ActionOutputs`, writing the panel —
stays in `steps/summary.ts`.

## The step-contract rule

Per `steps/` module, each a contract change if touched: a declared **result type**, a
**`Data.TaggedError`** with a `reason` literal union (`load-config` reuses `ConfigError`
from `schema/domain.ts`; `cache-config` is pure and has none), and an **explicitly
annotated `R`** — never let `R` be inferred. `program.ts`'s `R` is the union of every
step's; `MainLive` supplies only what `ActionServices` lacks.

## Conventions

- **Tests live in `__test__/unit/`**, mirroring this tree — never co-located.
- **`ProcessId.make`, never `makeUnsafe`** — `makeUnsafe` typechecks through test doubles
  then dies at runtime where `catchDefect` goes blind.
- **API authority:** `docs/superpowers/reference/effected-api-dossier.md`, then the
  installed `.d.ts`, then `.repos/effect` (read-only, pinned to rc.109).
- **Design:** `docs/superpowers/specs/2026-07-28-effected-rebuild-design.md`.
- **Legacy oracle:** `docs/superpowers/reference/legacy-v1/` — cite it for behavior
  questions; **never import from it**.
