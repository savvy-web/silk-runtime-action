---
type: Convention
title: Cross-phase state's encoded form must be plain JSON
description: Every Schema field that crosses the main-to-post boundary must encode to plain JSON, and must be tested against the real ActionState layer, never an in-memory double.
tags: [caching, testing]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: c0d625dfc44e54cc283fd49dc88f85e12267acbc9ad826c9266b4742f0bc7e4f
sources:
  - id: state-schemas
    resource: ../../src/state.ts
  - id: turbo-artifact-meta
    resource: ../../src/turbo-cache/meta.ts
  - id: state-round-trip-test
    resource: ../../__test__/unit/state.test.ts
---

# Cross-phase state's encoded form must be plain JSON

`main` and `post` are separate processes. `ActionState.save` appends `key<<DELIM` heredoc
blocks to the `GITHUB_STATE` file; the runner republishes each block as a `STATE_<key>`
environment variable; `ActionState.get`/`getOptional` reads it back. The values cross as
text: `JSON.stringify(encoded)` out, `JSON.parse` in.

**Rule: every field of a `Schema.Class` written through `ActionState.save`, and every field
of `TurboArtifactMeta` written through `BlobEnvelope`, must have an *encoded* form that is
plain JSON.** Never choose a schema combinator for a cross-phase field by whether it
typechecks or passes a test double — choose it by what `JSON.stringify` and `JSON.parse`
actually produce for it.

## The bug this rule generalizes from

`CacheState.restoredKey` (`../../src/state.ts:37-42`) was originally `Schema.Option(Schema.String)`.
`Schema.Option`'s **encoded** form is an `Option` *instance*, not a plain value. Stringifying
it goes through `Option.toJSON` and produces `{"_id":"Option","_tag":"Some",…}`, which no
longer decodes on the other side — `main` reported a successful save, and `post` could not
read it back (`"Expected Option"`). The fix is one line: `Schema.OptionFromNullOr(Schema.String)`,
whose encoded form is `string | null` — a shape `JSON.parse` actually hands back.

Every `restoredKey` field in `src/state.ts` — on `CacheState`, `StoreCacheState` and
`KcovCacheState` — is `Schema.OptionFromNullOr(Schema.String)` for this exact reason
(`state.ts:23-29`, `state.ts:68-71`, `state.ts:111-114`). `TurboServerState.pid` is
`ProcessId` rather than a bare `Schema.Number`, for a related but distinct reason: a
truncated state file, an absent key, or `Number("")` all decode to `0`, and `ProcessId`
refuses that value rather than letting it reach `DetachedProcess.reap` (`state.ts:87-90`).

### Two corollaries

- **In-memory test doubles are strictly more permissive than the runner, for this specific
  bug shape.** A `Map`-backed double hands the encoded object straight back and round-trips
  schemas that JSON cannot — it would have passed `Schema.Option` without complaint. Never
  trust an in-memory double alone to validate a state schema.
- **The same constraint applies to `BlobEnvelope` metadata.** `TurboArtifactMeta`
  (`../../src/turbo-cache/meta.ts:29-32`) writes its metadata as JSON between the envelope's
  header and the body, so it spells its `tag` field `Schema.NullOr(Schema.String)` rather
  than `Schema.Option`, for the identical reason `CacheState.restoredKey` does.

## Test against the real `ActionState` layer, not a double

`../../__test__/unit/state.test.ts` builds its harness on the **real** `ActionState.layer`
rather than any test double:

```ts
const realState = (env: Record<string, string>): Layer.Layer<ActionState> =>
  ActionState.layer.pipe(
    Layer.provide(ActionEnvironment.layerFrom(env)),
    Layer.provide(ActionOutputs.layerTest()),
    Layer.provide(NodeFileSystem.layer),
  );
```

Beside it, a five-line `republish` function does what the runner does between phases: parse
`GITHUB_STATE`'s heredoc-framed entries and republish each as a `STATE_<key>` variable, so a
full round trip saves through a service pointed at a scoped temp state file, republishes
that file the way the runner does, and reads it back through a second, independently built
service instance. **This is the harness pattern for any future state schema** — a new field
on `CacheState`, `StoreCacheState`, `KcovCacheState` or `TurboServerState`, or a wholly new
state class, is proven correct only by passing through this same save → republish → read
cycle, never by a `Map`-backed stand-in.

## `ProcessId.make`, never `makeUnsafe`

Every construction of a `ProcessId` — in production code and in tests — uses `ProcessId.make`,
never `ProcessId.makeUnsafe`. `makeUnsafe` typechecks through a test double and then dies at
runtime in exactly the place `Effect.catchDefect` goes blind, which is the same failure mode
this whole convention exists to keep out of cross-phase state: a value that looks fine until
the moment it actually crosses the boundary.

See [../models/cross-phase-state.md](../models/cross-phase-state.md) for the full shape of
`STATE_KEYS` and the four `Schema.Class` bundles this convention constrains.
