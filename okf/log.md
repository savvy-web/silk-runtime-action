# Log

## 2026-11-02

* Updated Dependency honesty

## 2026-11-01

* Updated A `Closes #N` trailer merged into `dev` does not close the issue
* Updated A detached worker never gets the real ActionOutputs layer
* Updated A green tsc, Biome, unit suite and two reviews still shipped a dead bundle
* Updated A hand-written test double is more permissive than the runner it replaces
* Updated A typed CacheKey carries the restore-ladder policy, never a bare string
* Updated A workflow trigger filter that matches no branch fails open into silence
* Updated ACTIONS_RUNTIME_TOKEN expires under a long-running embedded Turbo server
* Updated Action contract — inputs, outputs, and exported environment
* Updated Add a runtime
* Updated An "exact hit" that installs from the network anyway is a poisoned cache, not a fast one
* Updated An embedded, detached Turbo remote-cache server over a Vercel account
* Updated BATS helper libraries go to $HOME/.local/share, the one location two consumers agree on
* Updated Cache config — key formats, ladders, lockfile patterns, and archived paths
* Updated Commit source and dist together
* Updated Cross-phase state — STATE_KEYS and the four Schema.Class bundles
* Updated Cross-phase state's encoded form must be plain JSON
* Updated Debug a cache miss or partial hit
* Updated Dependency honesty
* Updated Inputs decoded once, outputs folded once
* Updated Kit test layers over hand-rolled mocks, and a real in-memory filesystem
* Updated Legacy / v1 / oracle N / ruling N / quirk N citations
* Updated Log levels and buffering
* Updated One embedded Turbo cache server per runner
* Updated Optional work never fails the job
* Updated PATH publication rules
* Updated Parity surface
* Updated Per-step error taxonomy, no central error union
* Updated Prose is parity surface
* Updated Re-running the fixture matrix fails every "create cache" job
* Updated Release dev to main
* Updated Runtime descriptors are pure, total data — no host reads, no service
* Updated Runtime descriptors — the per-tool download plans installs derive from
* Updated Seam
* Updated Seams as defaulted parameters, not services
* Updated The pinned package manager leads the child PATH, with no ambient exception
* Updated The step-contract rule
* Updated Three pipeline orderings are load-bearing
* Updated Turbo artifacts wire protocol — routes, auth, keys, and metadata
* Updated Turbo credentials are masked unconditionally, declassified only through Secret.*
* Updated Turbo worker environment — the main-to-worker handoff contract
* Updated Two BATS detection signals, neither a fallback for the other
* Updated Two cache entries — the workspace archive and the package-manager store — keyed independently
* Updated Unit test conventions
* Updated Verification means the built artifact
* Updated Windows launches every manager through a shell; POSIX never does
* Updated `Secret.adopt` looks like the right member for the turbo server's config reader, and is wrong twice over
* Updated `addPath` looks like it updates `PATH`; it only reaches later steps
* Updated `defaults.run.working-directory` does not reach a `uses:` step
* Updated dev/main sync resets by content comparison, never by commit-level history
* Updated devEngines manifest — the config shape consumers must satisfy
* Updated devEngines-only configuration, no version inputs
* Updated dist/ is committed, bundled and minified, with a mirrored local testing copy
* Updated kcov collects no coverage on macOS, and none at all on Windows
* Updated kcov gets its own Actions cache entry, key ladder, and verify probe
* Updated kcov is built from source because nothing usable is prebuilt
* Updated post can seal a half-populated dependency cache after a failed install
* Updated silk-runtime-action
* Updated spencerbeggs/effected
* Updated spencerbeggs/vitest-bats
* Updated test-harness
* Updated turbo-cache-server

## 2026-10-05

* Updated Cache config — key formats, ladders, lockfile patterns, and archived paths
* Updated Three pipeline orderings are load-bearing
* Updated Two cache entries — the workspace archive and the package-manager store — keyed independently
* Updated silk-runtime-action
* Updated turbo-cache-server

## 2026-09-25

* Updated test-harness

## 2026-09-24

* Updated devEngines manifest — the config shape consumers must satisfy

## 2026-09-21

* Added Re-running the fixture matrix fails every "create cache" job

## 2026-09-19

* Updated test-harness

## 2026-09-13

* Initialized the bundle with the software-project profile
* Added A `Closes #N` trailer merged into `dev` does not close the issue
* Added A detached worker never gets the real ActionOutputs layer
* Added A green install after unlinking a dogfooded package does not mean the code still typechecks
* Added A green tsc, Biome, unit suite and two reviews still shipped a dead bundle
* Added A hand-written test double is more permissive than the runner it replaces
* Added A typed CacheKey carries the restore-ladder policy, never a bare string
* Added A workflow trigger filter that matches no branch fails open into silence
* Added ACTIONS_RUNTIME_TOKEN expires under a long-running embedded Turbo server
* Added Action contract — inputs, outputs, and exported environment
* Added Add a runtime
* Added Adopt a first-party release after a dogfood round
* Added An "exact hit" that installs from the network anyway is a poisoned cache, not a fast one
* Added An embedded, detached Turbo remote-cache server over a Vercel account
* Added BATS helper libraries go to $HOME/.local/share, the one location two consumers agree on
* Added Cache config — key formats, ladders, lockfile patterns, and archived paths
* Added Commit source and dist together
* Added Cross-phase state — STATE_KEYS and the four Schema.Class bundles
* Added Cross-phase state's encoded form must be plain JSON
* Added Debug a cache miss or partial hit
* Added Dependency honesty
* Added Effect v4 over the @effected suite, zero @actions/* dependencies
* Added Inputs decoded once, outputs folded once
* Added Kit test layers over hand-rolled mocks, and a real in-memory filesystem
* Added Legacy / v1 / oracle N / ruling N / quirk N citations
* Added Log levels and buffering
* Added One embedded Turbo cache server per runner
* Added Optional work never fails the job
* Added PATH publication rules
* Added Parity surface
* Added Per-step error taxonomy, no central error union
* Added Prose is parity surface
* Added Release dev to main
* Added Runtime descriptors are pure, total data — no host reads, no service
* Added Runtime descriptors — the per-tool download plans installs derive from
* Added Seam
* Added Seams as defaulted parameters, not services
* Added The pinned package manager leads the child PATH, with no ambient exception
* Added The step-contract rule
* Added Three pipeline orderings are load-bearing
* Added Turbo artifacts wire protocol — routes, auth, keys, and metadata
* Added Turbo credentials are masked unconditionally, declassified only through Secret.*
* Added Turbo worker environment — the main-to-worker handoff contract
* Added Two BATS detection signals, neither a fallback for the other
* Added Two cache entries — the workspace archive and the package-manager store — keyed independently
* Added Unit test conventions
* Added Verification means the built artifact
* Added Windows launches every manager through a shell; POSIX never does
* Added `Secret.adopt` looks like the right member for the turbo server's config reader, and is wrong twice over
* Added `addPath` looks like it updates `PATH`; it only reaches later steps
* Added `defaults.run.working-directory` does not reach a `uses:` step
* Added dev/main sync resets by content comparison, never by commit-level history
* Added devEngines manifest — the config shape consumers must satisfy
* Added devEngines-only configuration, no version inputs
* Added dist/ is committed, bundled and minified, with a mirrored local testing copy
* Added kcov collects no coverage on macOS, and none at all on Windows
* Added kcov gets its own Actions cache entry, key ladder, and verify probe
* Added kcov is built from source because nothing usable is prebuilt
* Added post can seal a half-populated dependency cache after a failed install
* Added silk-runtime-action
* Added silk-runtime-action
* Added spencerbeggs/effected
* Added spencerbeggs/vitest-bats
* Added turbo-cache-server
