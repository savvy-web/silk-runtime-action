---
type: Convention
title: Log levels and buffering
description: Which Effect.log* level a line belongs at, how the pipeline's phases and steps fold its log, and why warnings are never held.
tags: [observability]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-11-21T22:19:28Z
sources:
  - id: program-src
    resource: ../../src/program.ts
  - id: install-runtimes-src
    resource: ../../src/steps/install-runtimes.ts
  - id: install-dependencies-src
    resource: ../../src/steps/install-dependencies.ts
  - id: setup-package-manager-src
    resource: ../../src/steps/setup-package-manager.ts
  - id: restore-cache-src
    resource: ../../src/steps/restore-cache.ts
  - id: format-src
    resource: ../../src/summary/format.ts
integrity:
  generated:
    body: dc5b2d27b33bd784
---

# Log levels and buffering

Run every pipeline step as `ActionLogger.step(name, effect)` under an `ActionLogger.phase`
heading, so the workflow log is a short list of result lines a reader can scan rather than
an undifferentiated stream. Do not use `ActionLogger.group` for pipeline work: a step opened
inside a group cannot fold, and `@effected/github-actions` 0.36 made the step log the one
shape the kit is built around.

## What each level carries

- `Effect.logInfo` — the lines a normal run shows: one per installed tool, the detect
  headline, the cache verdict, the final group.
- `Effect.logWarning` — every degradation. **Never buffered**, so a warning reaches the log
  even on a green run — `PackageManagerInstaller`'s missing-integrity notice is the running
  example.
- `Effect.logError` — a turbo server that never became ready (the run continues regardless).
- `Effect.logDebug` — the cache key, the restore ladder, the resolved path set, the lockfile
  list, resolved URLs, tool-cache roots, and pids. Visible only with
  `ACTIONS_STEP_DEBUG=true`.

A new log line's level is a decision about who needs to see it and when, not a stylistic
choice: if a human debugging a red run needs it and a green run should not show it, it is
`logDebug`; if it is a degradation the consumer should know about even when nothing failed,
it is `logWarning`, which a step never holds.

## Phases and steps

`program.ts` opens two phases, `Detect` and `Install`, and runs each pipeline step as a step
beneath them.[^program-src] A phase is one bold line that is never folded and holds nothing,
so its steps follow it at the top level. A step holds its detail (every line below `Warn`)
for its window, 30 seconds by default, then ends in one result line,
`<mark> <name> · <duration>`:

- `✓`: a success. Its detail folds into a group titled by that line.
- `⚠`: a success that logged a warning, or in which a nested step failed and was recovered
  from. A Biome, BATS or kcov install that degrades to a warning lands here.
- `✗`: a failure. Never folded: the line, the detail unfolded beneath it, then the failure.

A step that outlasts its window goes live and streams the rest; `RUNNER_DEBUG=1` makes every
window zero. The `Detected …` headline is logged in the `Detect` phase itself, outside any
step, so it is an ordinary line that is never folded away. `writeSummary` closes the run
with its own `Runtime Setup Complete` phase, whose lines print unfolded.

`install-runtimes.ts` nests one step per runtime
(`logger.step(spec.name, installOne(spec, host))`) inside the pipeline's `Install runtimes`
step. A nested step opens no group of its own: its result line and detail are lines of the
outer step's detail.[^install-runtimes-src] `setup-package-manager.ts` opens no step of its
own; the pipeline's `Install <manager>` step holds its transcript.[^setup-package-manager-src]

## The install's transcript goes through the logger

`install-dependencies.ts` pipes **both** of the install child's streams and drains them
concurrently, logging every line, so the whole transcript is the `Install dependencies`
step's detail. An inherited `stdout` would write straight to the runner log and defeat the
fold. Draining both at once is also what stops a chatty install from filling one pipe while
the other is read. It spawns for itself rather than through `ActionLogger.command`, because
it keeps the last stderr lines for the failure message and `command` returns stdout
only.[^install-dependencies-src]

**Warnings are never held.** A `logWarning` inside a step still reaches the log on a
successful run and marks the result line `⚠`.

## Debug logging: the cache-bust line is logged either way

At `ACTIONS_STEP_DEBUG=true`, `restore-cache.ts` logs the primary key, the restore ladder (or
`(none — exact match only)`), the resolved path set with its count, the lockfile list with
its count, and the cache bust — the last **whether or not one is set**.[^restore-cache-src]
A run that restored nothing is exactly the run where "was a bust in play?" is the first
question a debugger asks, so its absence has to be a logged answer rather than a missing
line. The same principle generalizes: a debug line whose omission is ambiguous between "not
logged" and "value was empty" is worse than no line at all, and every debug emission in this
action logs the negative case explicitly rather than skipping it.

## The cache verdict line

`cacheLine` in `restore-cache.ts` is the one formatter for the tristate prose: `exact hit (N
lockfiles)`, `partial hit (…)`, `miss (…)`, with the singular `1 lockfile` handled and carried
over verbatim from the legacy implementation.[^restore-cache-src] The count belongs on the
line because a miss with no lockfiles is a different problem from a miss with three: the
first says the patterns matched nothing, the second says the dependencies changed, and a
line that dropped the count would collapse two distinguishable failure modes into one
message. The job-summary panel renders the same three states from the same `CacheState`
through `cacheCell` in `summary/format.ts`, so the log and the panel derive from one state
value and cannot disagree with each other.[^format-src]

[^program-src]: ../../src/program.ts
[^install-runtimes-src]: ../../src/steps/install-runtimes.ts
[^setup-package-manager-src]: ../../src/steps/setup-package-manager.ts
[^install-dependencies-src]: ../../src/steps/install-dependencies.ts
[^restore-cache-src]: ../../src/steps/restore-cache.ts
[^format-src]: ../../src/summary/format.ts
