import { describe, expect, it } from "vitest";
import { decodeArtifact, encodeArtifact } from "./codec.js";

describe("artifact codec", () => {
	it("round-trips a tag, duration, and body", () => {
		const { tag, durationMs, body } = decodeArtifact(encodeArtifact("sig-123", 1980, new Uint8Array([1, 2, 3, 4])));
		expect(tag).toBe("sig-123");
		expect(durationMs).toBe(1980);
		expect(body).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it("round-trips a null tag (unsigned artifact) with duration", () => {
		const { tag, durationMs, body } = decodeArtifact(encodeArtifact(null, 42, new Uint8Array([9, 9])));
		expect(tag).toBeNull();
		expect(durationMs).toBe(42);
		expect(body).toEqual(new Uint8Array([9, 9]));
	});

	it("handles an empty body and zero duration", () => {
		const { tag, durationMs, body } = decodeArtifact(encodeArtifact("t", 0, new Uint8Array()));
		expect(tag).toBe("t");
		expect(durationMs).toBe(0);
		expect(body).toEqual(new Uint8Array());
	});

	it("clamps a negative or fractional duration to a non-negative integer", () => {
		expect(decodeArtifact(encodeArtifact(null, -5, new Uint8Array())).durationMs).toBe(0);
		expect(decodeArtifact(encodeArtifact(null, 12.9, new Uint8Array())).durationMs).toBe(12);
	});
});
