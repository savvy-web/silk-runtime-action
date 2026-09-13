---
type: Convention
title: Log levels and buffering
description: Which Effect.log* level a line belongs at, which steps buffer their transcript, and why warnings are never buffered.
tags: [observability]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: e6f00dabf25831b9e06a3f140a0a630e403ce7149a0bc45e10fdbd233aac8308
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
---

# Log levels and buffering

Group every step's log lines under `ActionLogger.group(title, effect)`, so the workflow log
is one collapsible group per step rather than an undifferentiated stream. Inside the two
noisiest steps, additionally hold the transcript with `logger.withBuffer(name, effect, {
onSuccess: "discard" })`, so a green run reads as one line per runtime or per manager, while
a failure spills the whole transcript.

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
it is `logWarning` and must never be routed through a buffer that could discard it.

## `ActionLogger.group` per step

`program.ts` wraps every pipeline step in its own `ActionLogger.group`, so the workflow log
renders as one collapsible section per step rather than one flat stream a reader has to
scan.[^program-src]

## `withBuffer(..., { onSuccess: "discard" })` in the two noisiest steps

Two steps hold their transcript rather than emitting it live:

- `install-runtimes.ts` buffers each runtime's install
  (`logger.withBuffer(spec.name, installOne(spec, host), { onSuccess: "discard" })`), so a
  green run is exactly one line per runtime rather than every intermediate download and
  extraction line.[^install-runtimes-src]
- `setup-package-manager.ts` buffers the package manager's own provisioning the same
  way.[^setup-package-manager-src]

Held-and-discarded on success means the transcript costs nothing when everything works; a
failure spills the URL, the cache path and everything else the buffer was holding, so nothing
useful is lost by holding it.

`install-dependencies.ts` buffers differently: it holds the **echoed stderr**, not the
install itself — the install's own stdout is inherited and streams live regardless, so
buffering it would hide a genuinely long-running install from a human watching the job. The
buffer exists so an interleaved dribble of warnings does not scramble the live transcript,
and it is flushed on **every exit path**, so a failing install shows all of the held stderr
and not just the tail the error message itself carries.[^install-dependencies-src]

**Warnings are never buffered**, in either shape of buffering above. A `logWarning` call
inside a buffered step still reaches the log on a successful run — the buffer only holds
`logInfo`-level narration, never a degradation notice.

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
