import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { ActionOutputs } from "@effected/github-actions";
import { Effect } from "effect";

import type { OutputName, OutputsModel } from "../../../src/schema/outputs.js";
import { OUTPUT_NAMES, emitOutputs, initialOutputs } from "../../../src/schema/outputs.js";

/**
 * The output names declared in `action.yml`, read from the file itself.
 *
 * @remarks
 * The same deliberate five-line parse the input guard uses, anchored on
 * `outputs:` instead: the block is two-space-indented `name:` keys between that
 * top-level key and the next one. Reading it for real is what makes the guard
 * bite when `action.yml` and the code drift apart — a hand-maintained copy of
 * the list would agree with itself forever.
 */
const declaredOutputNames = (): ReadonlyArray<string> => {
	const source = readFileSync(fileURLToPath(new URL("../../../action.yml", import.meta.url)), "utf8");
	const lines = source.split("\n");
	const start = lines.indexOf("outputs:");
	const names: Array<string> = [];
	for (const line of lines.slice(start + 1)) {
		if (/^\S/.test(line)) break;
		const match = /^ {2}([A-Za-z0-9-]+):\s*$/.exec(line);
		if (match?.[1] !== undefined) names.push(match[1]);
	}
	return names;
};

describe("OUTPUT_NAMES", () => {
	it("names every action.yml output, and nothing action.yml does not declare", () => {
		// The outputs were the unguarded half of the parity contract: the inputs
		// have had this cross-check since Phase A, so an output added to
		// `action.yml` and never published — or published under a name nobody
		// declared — stayed invisible until a consumer's workflow read an empty
		// string.
		const declared = declaredOutputNames();
		expect(declared.length).toBeGreaterThan(0);
		expect([...OUTPUT_NAMES].sort()).toEqual([...declared].sort());
	});

	it("lists them in the order action.yml declares them", () => {
		// Nothing depends on the order, and it is asserted anyway: the two lists
		// are read side by side whenever an output is added, and a shuffled one
		// costs a reviewer the diff.
		expect([...OUTPUT_NAMES]).toEqual([...declaredOutputNames()]);
	});
});

/** Collects everything one `emitOutputs` call published, as a plain object. */
const emitted = (model: OutputsModel) =>
	Effect.gen(function* () {
		const seen = new Map<string, string>();
		yield* emitOutputs(model).pipe(
			Effect.provide(
				ActionOutputs.layerTest({
					set: (name, value) => Effect.sync(() => void seen.set(name, value)),
				}),
			),
		);
		return Object.fromEntries(seen);
	});

describe("emitOutputs", () => {
	it.effect("writes every action.yml output exactly once", () =>
		Effect.gen(function* () {
			const seen = yield* emitted(initialOutputs);
			expect(Object.keys(seen).sort()).toEqual([...OUTPUT_NAMES].sort());
			expect(seen["cache-hit"]).toBe("false");
			expect(seen["turbo-cache-backend"]).toBe("none");
		}),
	);

	it.effect("publishes each field under its own name, not merely under some name", () =>
		Effect.gen(function* () {
			// The name-set assertion above is blind to the thing most likely to go
			// wrong in a 16-line block of near-identical `set` calls: a field wired
			// to its neighbour's name. Swap `bunVersion` and `denoVersion` in
			// `emitOutputs` and every name is still written exactly once. Distinct
			// sentinels per field are what make that swap show up as a diff.
			const seen = yield* emitted({
				nodeVersion: "sentinel-1",
				nodeEnabled: true,
				bunVersion: "sentinel-2",
				bunEnabled: false,
				denoVersion: "sentinel-3",
				denoEnabled: true,
				packageManager: "sentinel-4",
				packageManagerVersion: "sentinel-5",
				biomeVersion: "sentinel-6",
				biomeEnabled: false,
				turboEnabled: true,
				// The two enum fields cannot take a sentinel, so they take values
				// distinct from each other and from every default.
				turboCacheBackend: "s3",
				turboCachePort: "sentinel-7",
				cacheHit: "partial",
				lockfiles: "sentinel-8",
				cachePaths: "sentinel-9",
			});

			expect(seen).toEqual({
				"node-version": "sentinel-1",
				"node-enabled": "true",
				"bun-version": "sentinel-2",
				"bun-enabled": "false",
				"deno-version": "sentinel-3",
				"deno-enabled": "true",
				"package-manager": "sentinel-4",
				"package-manager-version": "sentinel-5",
				"biome-version": "sentinel-6",
				"biome-enabled": "false",
				"turbo-enabled": "true",
				"turbo-cache-backend": "s3",
				"turbo-cache-port": "sentinel-7",
				"cache-hit": "partial",
				lockfiles: "sentinel-8",
				"cache-paths": "sentinel-9",
			});
		}),
	);

	it.effect("keeps the five boolean fields apart from one another", () =>
		Effect.gen(function* () {
			// A boolean has two values and there are five of them, so no single
			// model can tell them all apart — the sentinel case above would survive
			// a swap between any two booleans that happened to agree. One-hot does
			// what sentinels cannot: each field is the only `true` in its own run,
			// so a field wired to another's name publishes the wrong one.
			const oneHot = [
				["nodeEnabled", "node-enabled"],
				["bunEnabled", "bun-enabled"],
				["denoEnabled", "deno-enabled"],
				["biomeEnabled", "biome-enabled"],
				["turboEnabled", "turbo-enabled"],
			] as const satisfies ReadonlyArray<readonly [keyof OutputsModel, OutputName]>;

			for (const [field, name] of oneHot) {
				const seen = yield* emitted({ ...initialOutputs, [field]: true });
				const trueNames = Object.entries(seen)
					.filter(([, value]) => value === "true")
					.map(([published]) => published);
				expect(trueNames).toEqual([name]);
			}
		}),
	);
});
