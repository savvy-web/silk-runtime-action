---
title: Three pipeline orderings are load-bearing
type: Decision
status: draft
description: Detection precedes cache restore, kcov is gated on bats actually landing rather than the decision alone, and the turbo cache server starts last — each a deliberate ordering with a specific reason it must not move.
tags: [architecture, caching]
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: f9520daf00d6c50987e6224253e24a871a69eaa8b0bd5116a7c943b905db1ac2
sources:
  - id: program
    resource: ../../src/program.ts
---

# Three pipeline orderings are load-bearing

## Context

`program.ts` runs its thirteen steps sequentially inside one `Effect.gen`.
Sequential code invites reordering during a refactor — moving a step "closer
to where it's used" reads as a harmless cleanup unless the reason for its
current position is written down.

## Decision

Three orderings are deliberate and must not move.

**Detection precedes the cache restore.** `detectBiome`, `detectTurbo` and
`detectBats` all run before `restoreCache` (`src/program.ts:200-220`), because
the resolved Biome version and turbo's presence both feed the cache key and
the archived path set — this is the legacy ordering, carried forward
unchanged. `detectBats` joins that same block even though its result feeds
*neither* the key nor the path set, for a narrower reason: the one-line
"Detected configuration" headline is assembled from all four detections at
once (`src/program.ts:208-219`), and splitting `detectBats` off into its
install-adjacent step would move a fact out from under the very headline that
reports it.

**kcov is gated on bats actually having landed, not on the decision that
asked for it.** The call is
`installKcov(batsDecision.installKcov && Option.isSome(bats), { bust:
inputs.cacheBust })` (`src/program.ts:276-283`) — the boolean passed in is a
conjunction of the *decision* and the *installed BATS result*, not the
decision alone. A coverage tool for a toolchain that failed to install has
nothing to cover, and paying a multi-minute source build for it would be the
worst possible response to an install that already went wrong.

**The turbo cache server starts last.** `startTurboCache` is step 13 of 13
(`src/program.ts:284-287`), a deliberate deviation from v1, which started it
before the cache restore. Nothing earlier in the pipeline consumes the turbo
environment, and a later start shortens the window during which a detached
child process holds the runner's short-lived `ACTIONS_RUNTIME_TOKEN`. Ruled
neutral-to-better; do not "fix it back" to match v1's ordering or to look more
symmetric with the detection block.

Before step 1, the program sets four environment variables **on this process
only** — `NPM_CONFIG_UPDATE_NOTIFIER`, `NPM_CONFIG_FUND`, `HUSKY`,
`COREPACK_ENABLE_DOWNLOAD_PROMPT` (`src/program.ts:189-194`) — to quiet tool
chatter its own installs provoke. They are set via `process.env` directly and
never `exportVariable`d, so none of it leaks into the consumer's own later
workflow steps. `COREPACK_ENABLE_DOWNLOAD_PROMPT` outlives corepack's removal
from this action's own dependency-install path deliberately: it costs nothing
to keep set, and it still quiets a corepack the consumer's *own* steps might
invoke.

## Alternatives rejected

- **Move `detectBats` next to `installBats`.** Reads as tidier — detection and
  install for the same feature, adjacent — but breaks the "Detected
  configuration" headline, which needs all four detection results available
  at once before it can render a single line.
- **Gate kcov purely on the `kcov` input/decision.** Would let a coverage
  build run — and potentially fail slowly on an unusual runner image — for a
  BATS toolchain that never actually installed, wasting minutes to build a
  tool with nothing to instrument.
- **Start the turbo server earlier, symmetrically with detection.** This was
  v1's ordering and is not wrong on correctness grounds, but it widens the
  window a detached child holds the runner's `ACTIONS_RUNTIME_TOKEN` for no
  benefit, since nothing in the pipeline between detection and the current
  step 13 position ever reads the turbo environment.

## Consequences

- A future step that needs to feed the cache key or the archived path set
  must land before `restoreCache`, matching the same reasoning that already
  governs `detectBiome`/`detectTurbo`.
- The `installKcov` call site's boolean argument is not a simple echo of the
  `kcov` input — a future edit that "simplifies" it back to `decision.installKcov`
  alone silently reintroduces a wasted build path on a failed BATS install.
- The turbo server's late position means its `ACTIONS_RUNTIME_TOKEN` exposure
  window is already minimized within this pipeline; any future increase in
  the number of steps after it directly re-widens that window and should be
  weighed against this reasoning before being accepted.
