/**
 * Frame an artifact for blob storage as: [4-byte big-endian tag length]
 * [4-byte big-endian duration ms][tag UTF-8][body]. A null tag is encoded as
 * length 0. `durationMs` is Turbo's `x-artifact-duration` (the time taken to
 * generate the artifact); it must round-trip so Turbo can compute `timeSaved`
 * on a remote cache hit. It is clamped to a uint32 (ms), which covers any
 * realistic build-task duration.
 */
export const encodeArtifact = (tag: string | null, durationMs: number, body: Uint8Array): Uint8Array => {
	const tagBytes = tag ? new TextEncoder().encode(tag) : new Uint8Array(0);
	const out = new Uint8Array(8 + tagBytes.length + body.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, tagBytes.length, false);
	view.setUint32(4, Math.min(0xffffffff, Math.max(0, Math.trunc(durationMs) || 0)), false);
	out.set(tagBytes, 8);
	out.set(body, 8 + tagBytes.length);
	return out;
};

/** Inverse of {@link encodeArtifact}. */
export const decodeArtifact = (blob: Uint8Array): { tag: string | null; durationMs: number; body: Uint8Array } => {
	const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
	const tagLen = view.getUint32(0, false);
	const durationMs = view.getUint32(4, false);
	const tag = tagLen > 0 ? new TextDecoder().decode(blob.subarray(8, 8 + tagLen)) : null;
	return { tag, durationMs, body: blob.subarray(8 + tagLen) };
};
