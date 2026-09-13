---
title: Turbo artifacts wire protocol — routes, auth, keys, and metadata
description: The /v8/artifacts HTTP contract the embedded turbo remote-cache server implements, and the framing rules a client depends on.
status: draft
type: Interface
kind: wire
resource: ../../src/turbo-cache/handler.ts
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 24a5efa491257fcc6db310ea7a4182be3d17635c83f9d712d06259699b6bd15a
sources:
  - id: handler
    resource: ../../src/turbo-cache/handler.ts
  - id: meta
    resource: ../../src/turbo-cache/meta.ts
---

# Turbo artifacts wire protocol — routes, auth, keys, and metadata

The embedded cache server implements Turbo's `/v8/artifacts` remote-cache contract[^handler]
over a generic `BlobStore`. This is the contract a `turbo run` step depends on once it is pointed at
the server through `TURBO_API` — see
[turbo-worker-environment](./turbo-worker-environment.md) for how the server itself is
configured, and [embedded-turbo-server](../decisions/embedded-turbo-server.md) for why it
exists at all.

## Routes

Evaluated in this order (`handler.ts:131-156`):

| Path | Methods | Answer |
| --- | --- | --- |
| `/v8/artifacts/status` | any | `200 {"status":"enabled"}` — **open, never authenticated** |
| `/v8/artifacts/events` | any | `200 []`, authenticated |
| `/v8/artifacts/:hash` | `PUT` | `202` |
| | `HEAD` | `200` / `404` |
| | `GET` | `200` + body / `404` |
| | other | `405` |
| anything else | any | `404` |

`/status` stays open because it is the readiness probe the spawning step polls before it has
anything to authenticate with (`handler.ts:143-144,162`). `/events` is turbo-client telemetry
traffic and **is** authenticated (`handler.ts:165-167`).

## Authentication order

Authentication happens **after** the route match: an unroutable path answers `404` rather than
`401` (`handler.ts:169-171`), which tells a misconfigured client which of the two things is
wrong — a bad hash versus a bad token.

The bearer prefix is optional and case-insensitive (`/^Bearer\s+/i`), so a client sending the
bare token is accepted (`handler.ts:106-107`). An **empty** `expectedToken` authorizes every
request — that permissive branch exists because a handler test needs it, and in production it
is unreachable: `readServerConfig` (see
[turbo-worker-environment](./turbo-worker-environment.md)) fails the server's boot rather than
letting `TURBOGHA_TOKEN` reach the handler empty.

## GET semantics: corrupt is a miss

A `GET` answers `404` for a genuine miss **and** for a blob whose envelope will not decode
into `TurboArtifactMeta` — a pre-envelope blob, a newer revision, a truncated frame
(`handler.ts:187-205`). All five `BlobEnvelopeError` members are caught and folded into the
same "not found" outcome (`handler.ts:193-204`), because a corrupt entry that were served
anyway would be indistinguishable to Turbo from a real one; turning it into a miss makes Turbo
rebuild instead. Every other failure — a `BlobStoreError`, anything the store's `get`/`put`/
`has` raises — collapses to a bare `500` at the handler's outer catch (`handler.ts:217-224`),
because there is nothing in the response body Turbo would act on differently.

Query strings are stripped before routing (`pathnameOf`, `handler.ts:76-79`): every request
carries `?teamId=…&slug=…`, and no route ever reads a parameter out of it.

## Blob keys

Keys are `${prefix}${hash}`, with a `/` inserted only when a non-empty prefix does not already
end in one (`artifactKey`, `handler.ts:123-124`). That separator matters for namespace
isolation: two prefixes where one is a substring of the other (`p` and `proj`) must not share
entries by concatenation alone.

There is **no `v2/` version segment**. The kit's `BlobEnvelope` carries the format revision
in-band and reports a mismatch as a typed `BlobEnvelopeError`, which the handler folds into the
same "miss" path described above; stale entries age out through the backend's own eviction
rather than through a key namespace this action manages.

## Metadata

```ts
export class TurboArtifactMeta extends Schema.Class<TurboArtifactMeta>("TurboArtifactMeta")({
  tag: Schema.NullOr(Schema.String),
  durationMs: Schema.Number,
}) {}
```

(`meta.ts:29-32`)[^meta]

`durationMs` **must round-trip**: Turbo computes `timeSaved` from the `x-artifact-duration`
header it gets back on a remote hit (`meta.ts:24-25`, `handler.ts:210`). It is clamped at the
handler boundary — via `clampDurationMs` — to a whole, non-negative number in
`0…4294967295` (`meta.ts:34-53`): the historical `uint32` frame range, kept even though JSON
would carry any number, because the clamp is what stops a nonsensical header (negative,
fractional, `NaN`, an absurd magnitude) from becoming a `timeSaved` a human reads.
`Math.trunc(x) || 0` folds both `NaN` and `-0` to `0` (`meta.ts:49-53`).

An **empty** tag is stored as an empty string but dropped on the way out — the handler's
truthiness check omits the `x-artifact-tag` header entirely rather than echoing it empty
(`handler.ts:212-213`).

`tag` is spelled `Schema.NullOr(Schema.String)` rather than `Schema.Option` because the
envelope writes metadata as **plain JSON** between its header and the body — the same
constraint cross-phase state carries; see
[cross-phase-state](../models/cross-phase-state.md) and
[plain-json-cross-phase-state](../conventions/plain-json-cross-phase-state.md).

[^handler]: handler
[^meta]: meta
