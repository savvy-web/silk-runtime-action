import { describe, expect, it } from "vitest";
import { decodeArtifact, encodeArtifact } from "./codec.js";

// decodeArtifact returns null on a malformed frame; a valid round-trip never does.
const dec = (blob: Uint8Array): { tag: string | null; durationMs: number; body: Uint8Array } => {
	const r = decodeArtifact(blob);
	if (r === null) throw new Error("expected a valid frame");
	return r;
};

describe("artifact codec", () => {
	it("round-trips a tag, duration, and body", () => {
		const { tag, durationMs, body } = dec(encodeArtifact("sig-123", 1980, new Uint8Array([1, 2, 3, 4])));
		expect(tag).toBe("sig-123");
		expect(durationMs).toBe(1980);
		expect(body).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it("round-trips a null tag (unsigned artifact) with duration", () => {
		const { tag, durationMs, body } = dec(encodeArtifact(null, 42, new Uint8Array([9, 9])));
		expect(tag).toBeNull();
		expect(durationMs).toBe(42);
		expect(body).toEqual(new Uint8Array([9, 9]));
	});

	it("handles an empty body and zero duration", () => {
		const { tag, durationMs, body } = dec(encodeArtifact("t", 0, new Uint8Array()));
		expect(tag).toBe("t");
		expect(durationMs).toBe(0);
		expect(body).toEqual(new Uint8Array());
	});

	it("clamps a negative or fractional duration to a non-negative integer", () => {
		expect(dec(encodeArtifact(null, -5, new Uint8Array())).durationMs).toBe(0);
		expect(dec(encodeArtifact(null, 12.9, new Uint8Array())).durationMs).toBe(12);
	});

	it("returns null for a blob shorter than the 8-byte header", () => {
		expect(decodeArtifact(new Uint8Array([0, 0, 0]))).toBeNull();
	});

	it("returns null when the tag length runs past the blob", () => {
		// Header claims a 99-byte tag, but the blob has no tag/body after the header.
		const bad = new Uint8Array(8);
		new DataView(bad.buffer).setUint32(0, 99, false);
		expect(decodeArtifact(bad)).toBeNull();
	});
});
