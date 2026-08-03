import { describe, expect, it } from "@effect/vitest";
import { BlobStore } from "@effected/github-actions";
import { Effect, Option, Schema } from "effect";

import { TurboArtifactMeta, clampDurationMs } from "../../../src/turbo-cache/meta.js";

describe("TurboArtifactMeta", () => {
	it("encodes to plain JSON", () => {
		// The statefix rule, applied to envelopes: `BlobEnvelope` frames metadata
		// as JSON between the header and the body, so an encoded form that is not
		// already plain JSON (a `Schema.Option` instance, say) writes something no
		// read can decode. Structural equality against an object literal is what
		// proves it — a class instance with the same fields would not match.
		const encoded = Schema.encodeSync(TurboArtifactMeta)(TurboArtifactMeta.make({ tag: "sig", durationMs: 1250 }));

		expect(encoded).toEqual({ tag: "sig", durationMs: 1250 });
		expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded);
	});

	it("encodes an absent tag as null", () => {
		const encoded = Schema.encodeSync(TurboArtifactMeta)(TurboArtifactMeta.make({ tag: null, durationMs: 0 }));

		expect(encoded).toEqual({ tag: null, durationMs: 0 });
	});

	it("survives a JSON round trip", () => {
		const meta = TurboArtifactMeta.make({ tag: "sig", durationMs: 1250 });
		const wire = JSON.parse(JSON.stringify(Schema.encodeSync(TurboArtifactMeta)(meta)));

		expect(Schema.decodeUnknownSync(TurboArtifactMeta)(wire)).toEqual(meta);
	});

	it("survives a real store round trip", () =>
		// `layerMemory` runs the real `BlobEnvelope` framing — encode, JSON,
		// decode — so this is the same proof the network backends give.
		Effect.gen(function* () {
			const store = yield* BlobStore;
			const metadata = TurboArtifactMeta.make({ tag: "sig", durationMs: 42 });
			const body = new Uint8Array([1, 2, 3]);

			yield* store.put("k", { metadata, body }, TurboArtifactMeta);
			const blob = yield* store.get("k", TurboArtifactMeta);

			expect(Option.isSome(blob)).toBe(true);
			if (Option.isSome(blob)) {
				expect(blob.value.metadata).toEqual(metadata);
				expect(blob.value.body).toEqual(body);
			}
		}).pipe(Effect.provide(BlobStore.layerMemory), Effect.runPromise));
});

describe("clampDurationMs", () => {
	it.each([
		["keeps a plain duration", 1250, 1250],
		["truncates a fractional duration", 1250.9, 1250],
		["floors a negative duration at zero", -5, 0],
		["maps NaN to zero", Number.NaN, 0],
		["caps at uint32", 8_589_934_592, 4_294_967_295],
		["keeps zero", 0, 0],
		["maps infinity to the cap", Number.POSITIVE_INFINITY, 4_294_967_295],
	])("%s", (_name, input, expected) => {
		expect(clampDurationMs(input)).toBe(expected);
	});
});
