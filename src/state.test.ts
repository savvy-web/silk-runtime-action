import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { CacheState, STATE_KEYS } from "./state.js";

describe("state", () => {
	it("STATE_KEYS exposes cacheState", () => {
		expect(STATE_KEYS.cacheState).toBe("cache-state");
	});

	it("CacheState round-trips through Schema encode/decode", () => {
		const original = new CacheState({
			key: "linux-abc-def-123",
			paths: ["/home/runner/.npm", "**/node_modules"],
			restored: false,
		});
		const encoded = Schema.encodeSync(CacheState)(original);
		const decoded = Schema.decodeSync(CacheState)(encoded);
		expect(decoded.key).toBe(original.key);
		expect(decoded.paths).toEqual(original.paths);
		expect(decoded.restored).toBe(false);
	});
});
