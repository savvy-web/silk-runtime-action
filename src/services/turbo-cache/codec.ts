/**
 * Frame an artifact for blob storage as: [4-byte big-endian tag length]
 * [tag UTF-8][body]. A null tag is encoded as length 0.
 */
export const encodeArtifact = (tag: string | null, body: Uint8Array): Uint8Array => {
	const tagBytes = tag ? new TextEncoder().encode(tag) : new Uint8Array(0);
	const out = new Uint8Array(4 + tagBytes.length + body.length);
	new DataView(out.buffer).setUint32(0, tagBytes.length, false);
	out.set(tagBytes, 4);
	out.set(body, 4 + tagBytes.length);
	return out;
};

/** Inverse of {@link encodeArtifact}. */
export const decodeArtifact = (blob: Uint8Array): { tag: string | null; body: Uint8Array } => {
	const tagLen = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getUint32(0, false);
	const tag = tagLen > 0 ? new TextDecoder().decode(blob.subarray(4, 4 + tagLen)) : null;
	return { tag, body: blob.subarray(4 + tagLen) };
};
