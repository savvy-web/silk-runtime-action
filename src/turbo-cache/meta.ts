import { Schema } from "effect";

/**
 * What the cache server stores beside an artifact's bytes: Turbo's signature
 * tag and the time the task took to produce it.
 *
 * @remarks
 * This replaces v1's hand-rolled binary frame (`[4B tagLen][4B durationMs]
 * [tag][body]`, oracle 8-14) — `BlobEnvelope` owns framing now and this owns
 * *meaning*. Two consequences of that swap are load-bearing:
 *
 * - **The encoded form has to be plain JSON.** The envelope writes metadata as
 *   JSON between its header and the body, so a field whose encoded form is a
 *   class instance (`Schema.Option` is the one that bit this action before, in
 *   `state.ts`) writes bytes that no read can decode. `Schema.NullOr` encodes
 *   to `string | null`, which is why the tag is spelled that way rather than as
 *   an `Option`.
 * - **`ARTIFACT_KEY_VERSION` is gone.** v1 namespaced keys with `v2/` because a
 *   frame change had no in-band version; the envelope carries one, reports a
 *   revision mismatch as a typed `BlobEnvelopeError`, and the handler turns
 *   that into a miss. Keys are now `${prefix}${hash}` and stale entries age out
 *   through the backend's own eviction (oracle 65).
 *
 * `durationMs` must round-trip: Turbo computes `timeSaved` from the
 * `x-artifact-duration` it gets back on a remote hit. An **empty** tag is
 * stored as an empty string and dropped on the way out by the handler's
 * truthiness check, which is v1's behavior and quirk 80.
 */
export class TurboArtifactMeta extends Schema.Class<TurboArtifactMeta>("TurboArtifactMeta")({
	tag: Schema.NullOr(Schema.String),
	durationMs: Schema.Number,
}) {}

/** The largest duration the stored metadata represents. */
const MAX_DURATION_MS = 4_294_967_295;

/**
 * Normalizes an inbound `x-artifact-duration` to a whole, non-negative
 * millisecond count.
 *
 * @remarks
 * v1's frame wrote the duration into a `uint32`, and this keeps that range
 * even though JSON would carry any number — the clamp is what stops a
 * nonsensical header (a negative, a fraction, `NaN` from a garbage value, an
 * absurd magnitude) from becoming a `timeSaved` Turbo reports to a user. Ruling
 * 65 keeps the behavior and moves it to the handler boundary, where the header
 * arrives, rather than burying it in a codec.
 *
 * `Math.trunc(x) || 0` is v1's `NaN` guard verbatim: `NaN || 0` is `0`, and so
 * is `-0`.
 */
export const clampDurationMs = (durationMs: number): number =>
	Math.min(MAX_DURATION_MS, Math.max(0, Math.trunc(durationMs) || 0));
