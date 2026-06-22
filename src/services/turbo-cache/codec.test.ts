import { describe, expect, it } from "vitest";
import { decodeArtifact, encodeArtifact } from "./codec.js";

describe("artifact codec", () => {
	it("round-trips a tag and body", () => {
		const { tag, body } = decodeArtifact(encodeArtifact("sig-123", new Uint8Array([1, 2, 3, 4])));
		expect(tag).toBe("sig-123");
		expect(body).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it("round-trips a null tag (unsigned artifact)", () => {
		const { tag, body } = decodeArtifact(encodeArtifact(null, new Uint8Array([9, 9])));
		expect(tag).toBeNull();
		expect(body).toEqual(new Uint8Array([9, 9]));
	});

	it("handles an empty body", () => {
		const { tag, body } = decodeArtifact(encodeArtifact("t", new Uint8Array()));
		expect(tag).toBe("t");
		expect(body).toEqual(new Uint8Array());
	});
});
