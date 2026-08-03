import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { ActionEnvironment, ActionOutputs, ActionState, ProcessId } from "@effected/github-actions";
import { Effect, FileSystem, Layer, Option, Schema } from "effect";

import { CacheState, STATE_KEYS, TurboServerState } from "../../src/state.js";

/**
 * `ActionState.layer` — the real one — pointed at a state file (the `main`
 * phase) or seeded with `STATE_*` variables (the `post` phase).
 *
 * @remarks
 * Deliberately not a test double. The two phases use *different* mechanisms:
 * `save` appends `key<<DELIM` blocks to `GITHUB_STATE`, `get` reads
 * `STATE_<key>` from the environment, and the value crosses between them as
 * text. An in-memory double that hands the encoded object straight back
 * round-trips schemas that JSON cannot — which is exactly the bug this suite
 * exists to catch.
 */
const realState = (env: Record<string, string>): Layer.Layer<ActionState> =>
	ActionState.layer.pipe(
		Layer.provide(ActionEnvironment.layerFrom(env)),
		Layer.provide(ActionOutputs.layerTest()),
		Layer.provide(NodeFileSystem.layer),
	);

/**
 * What the runner does between phases: parse the `GITHUB_STATE` file's
 * heredoc-framed entries and republish each as a `STATE_<key>` variable.
 */
const republish = (raw: string): Record<string, string> => {
	const lines = raw.split("\n");
	const env: Record<string, string> = {};
	for (let index = 0; index < lines.length; index++) {
		const header = /^(.+?)<<(.+)$/.exec(lines[index] ?? "");
		if (header === null) continue;
		const [, key, delimiter] = header as unknown as [string, string, string];
		const body: string[] = [];
		index++;
		while (index < lines.length && lines[index] !== delimiter) {
			body.push(lines[index] ?? "");
			index++;
		}
		env[`STATE_${key}`] = body.join("\n");
	}
	return env;
};

/**
 * A full `main` → runner → `post` trip: save through the real service into a
 * scoped temp state file, republish that file the way the runner does, then
 * read it back through a second, independently built service.
 */
const acrossPhases = <A, I>(key: string, value: A, schema: Schema.Codec<A, I>) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const directory = yield* fs.makeTempDirectoryScoped();
		const file = `${directory}/state.txt`;
		yield* fs.writeFileString(file, "");

		yield* Effect.flatMap(ActionState, (state) => state.save(key, value, schema)).pipe(
			Effect.provide(realState({ GITHUB_STATE: file })),
		);

		const written = yield* fs.readFileString(file);
		const env = republish(written);
		const restored = yield* Effect.flatMap(ActionState, (state) => state.get(key, schema)).pipe(
			Effect.provide(realState(env)),
		);

		return { restored, published: env[`STATE_${key}`] ?? "" };
	}).pipe(Effect.provide(NodeFileSystem.layer));

describe("CacheState", () => {
	it.effect("survives the runner state round trip on an exact hit", () =>
		Effect.gen(function* () {
			const value = CacheState.make({
				paths: ["~/.cache/pnpm", "**/node_modules"],
				primaryKey: "cache-key-1",
				restoredKey: Option.some("cache-key-1"),
				lockfiles: ["/work/repo/pnpm-lock.yaml", "/work/repo/deno.lock"],
			});

			const { restored, published } = yield* acrossPhases(STATE_KEYS.cache, value, CacheState);

			expect(restored.paths).toEqual(value.paths);
			expect(restored.primaryKey).toBe("cache-key-1");
			expect(restored.lockfiles).toEqual(value.lockfiles);
			expect(Option.getOrThrow(restored.restoredKey)).toBe("cache-key-1");
			// The published text is the contract with the runner: JSON, one line,
			// and no `Option` internals ("_id") that only decode back to themselves.
			expect(published).not.toContain("_id");
			expect(published).not.toContain("\n");
		}),
	);

	it.effect("survives the runner state round trip on a partial restore", () =>
		Effect.gen(function* () {
			const value = CacheState.make({
				paths: ["~/.cache/pnpm"],
				primaryKey: "deps-abc123",
				restoredKey: Option.some("deps-abc122"),
				lockfiles: [],
			});

			const { restored } = yield* acrossPhases(STATE_KEYS.cache, value, CacheState);

			expect(restored.primaryKey).toBe("deps-abc123");
			expect(Option.getOrThrow(restored.restoredKey)).toBe("deps-abc122");
			expect(Option.getOrThrow(restored.restoredKey)).not.toBe(restored.primaryKey);
		}),
	);

	it.effect("survives the runner state round trip on a miss", () =>
		Effect.gen(function* () {
			const value = CacheState.make({
				paths: ["~/.cache/pnpm"],
				primaryKey: "cache-key-1",
				restoredKey: Option.none(),
				lockfiles: [],
			});

			const { restored, published } = yield* acrossPhases(STATE_KEYS.cache, value, CacheState);

			expect(Option.isNone(restored.restoredKey)).toBe(true);
			expect(published).toContain('"restoredKey":null');
		}),
	);

	it.effect("getOptional reports none when the earlier phase saved nothing", () =>
		Effect.gen(function* () {
			const state = yield* ActionState;
			const restored = yield* state.getOptional(STATE_KEYS.cache, CacheState);
			expect(Option.isNone(restored)).toBe(true);
		}).pipe(Effect.provide(realState({}))),
	);
});

describe("TurboServerState", () => {
	it.effect("survives the runner state round trip", () =>
		Effect.gen(function* () {
			const value = TurboServerState.make({
				pid: ProcessId.make(12345),
				port: 41230,
				backend: "github",
				logFile: "/tmp/silk-turbo-server.log",
			});

			const { restored } = yield* acrossPhases(STATE_KEYS.turboServer, value, TurboServerState);

			expect(restored).toEqual(value);
		}),
	);

	it.effect("rejects pid 0 (the truncated-state-file case)", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				Schema.decodeUnknownEffect(TurboServerState)({
					pid: 0,
					port: 41230,
					backend: "github",
					logFile: "/tmp/silk-turbo-server.log",
				}),
			);
			expect(exit._tag).toBe("Failure");
		}),
	);

	it.effect("rejects an unknown backend", () =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(
				Schema.decodeUnknownEffect(TurboServerState)({
					pid: 12345,
					port: 41230,
					backend: "remote",
					logFile: "/tmp/silk-turbo-server.log",
				}),
			);
			expect(exit._tag).toBe("Failure");
		}),
	);
});
