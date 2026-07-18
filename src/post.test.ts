import { ActionCache } from "@savvy-web/github-action-effects";
import { ActionCacheTest, ActionLoggerTest, ActionStateTest } from "@savvy-web/github-action-effects/testing";
import { Effect, Layer, Logger, Option, References } from "effect";
import { describe, expect, it } from "vitest";
import { CacheError } from "./errors/errors.js";
import { makePost, post } from "./post.js";
import { saveCache } from "./services/cache.js";
import { STATE_KEYS } from "./state.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test mock requires any for mocked service tags
type AnyLayer = Layer.Layer<any>;
const asLayer = (l: AnyLayer): Layer.Layer<never> => l as Layer.Layer<never>;

// biome-ignore lint/suspicious/noExplicitAny: test mock requires any for mocked effect results
const run = <A>(effect: Effect.Effect<A, any, any>, layer: AnyLayer): Promise<A> =>
	Effect.runPromise(
		effect.pipe(Effect.provide(asLayer(layer)), Effect.provide(Logger.layer([]))) as Effect.Effect<A, never, never>,
	);

/**
 * Effect Logger that captures log entries into a provided array.
 * Used to verify Effect.logWarning calls.
 */
const capturingLoggerLayer = (entries: Array<{ level: string; message: string }>): Layer.Layer<never> =>
	Layer.mergeAll(
		Logger.layer([
			Logger.make(({ logLevel, message }) => {
				entries.push({
					level: logLevel,
					message: Array.isArray(message) ? message.map(String).join(" ") : String(message),
				});
			}),
		]),
		Layer.succeed(References.MinimumLogLevel, "All"),
	);

const runWithLogger = <A>(
	effect: Effect.Effect<A, unknown, unknown>,
	layer: AnyLayer,
	loggerLayer: Layer.Layer<never>,
): Promise<A> =>
	Effect.runPromise(
		effect.pipe(Effect.provide(asLayer(layer)), Effect.provide(loggerLayer)) as Effect.Effect<A, never, never>,
	);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("post action (saveCache integration)", () => {
	it("saveCache is called when restored is false (partial hit)", async () => {
		const cache = ActionCacheTest.empty();
		const state = ActionStateTest.empty();
		state.entries.set("cache-state", JSON.stringify({ key: "test-key", paths: ["/cache/path"], restored: false }));

		const layer = Layer.mergeAll(ActionCacheTest.layer(cache), ActionStateTest.layer(state));

		await run(saveCache(), layer);

		expect(cache.entries.has("test-key")).toBe(true);
		expect(cache.entries.get("test-key")).toEqual(["/cache/path"]);
	});

	it("saveCache is called when restored is false (cache miss)", async () => {
		const cache = ActionCacheTest.empty();
		const state = ActionStateTest.empty();
		state.entries.set("cache-state", JSON.stringify({ key: "test-key", paths: ["/cache/path"], restored: false }));

		const layer = Layer.mergeAll(ActionCacheTest.layer(cache), ActionStateTest.layer(state));

		await run(saveCache(), layer);

		expect(cache.entries.has("test-key")).toBe(true);
	});

	it("saveCache skips when restored is true (exact hit)", async () => {
		const cache = ActionCacheTest.empty();
		const state = ActionStateTest.empty();
		state.entries.set("cache-state", JSON.stringify({ key: "test-key", paths: ["/cache/path"], restored: true }));

		const layer = Layer.mergeAll(ActionCacheTest.layer(cache), ActionStateTest.layer(state));

		await run(saveCache(), layer);

		expect(cache.entries.size).toBe(0);
	});

	it("post skips save when no cache state in main (missing state)", async () => {
		// No cache-state stored — getOptional returns None, post exits early
		const cache = ActionCacheTest.empty();
		const state = ActionStateTest.empty();

		const layer = Layer.mergeAll(ActionCacheTest.layer(cache), ActionStateTest.layer(state));

		// Should resolve without throwing and without saving anything
		await expect(run(post, layer)).resolves.toBeUndefined();
		expect(cache.entries.size).toBe(0);
	});

	it("post skips save when restored is true (exact hit)", async () => {
		// restored=true means main got an exact cache hit — post exits early
		const cache = ActionCacheTest.empty();
		const state = ActionStateTest.empty();
		state.entries.set("cache-state", JSON.stringify({ key: "test-key", paths: ["/cache/path"], restored: true }));

		const layer = Layer.mergeAll(ActionCacheTest.layer(cache), ActionStateTest.layer(state));

		await expect(run(post, layer)).resolves.toBeUndefined();
		expect(cache.entries.size).toBe(0);
	});

	it("post calls saveCache when restored is false (miss or partial hit)", async () => {
		// restored=false means post must save the new cache entry
		const cache = ActionCacheTest.empty();
		const state = ActionStateTest.empty();
		state.entries.set("cache-state", JSON.stringify({ key: "test-key", paths: ["/cache/path"], restored: false }));

		const logger = ActionLoggerTest.empty();
		const layer = Layer.mergeAll(
			ActionCacheTest.layer(cache),
			ActionStateTest.layer(state),
			ActionLoggerTest.layer(logger),
		);

		await expect(run(post, layer)).resolves.toBeUndefined();
		expect(cache.entries.has("test-key")).toBe(true);
		expect(cache.entries.get("test-key")).toEqual(["/cache/path"]);
	});

	it("post catches typed CacheError from saveCache and logs warning (does not fail)", async () => {
		// Regression test: Effect.catchDefect alone does not catch typed
		// CacheError. Without an outer Effect.catch, a save failure would
		// propagate and fail the workflow. The post.ts pipe must catch both.
		const state = ActionStateTest.empty();
		state.entries.set("cache-state", JSON.stringify({ key: "test-key", paths: ["/cache/path"], restored: false }));

		// Hand-rolled ActionCache mock that fails save() with the wrapped
		// CacheError that saveCache() raises in production.
		const failingCacheLayer: Layer.Layer<ActionCache> = Layer.succeed(
			ActionCache,
			ActionCache.of({
				save: () => Effect.fail(new CacheError({ operation: "save", reason: "test failure" })) as never,
				restore: () => Effect.succeed(Option.none()),
			}),
		);

		const logger = ActionLoggerTest.empty();
		const captured: Array<{ level: string; message: string }> = [];

		const layer = Layer.mergeAll(failingCacheLayer, ActionStateTest.layer(state), ActionLoggerTest.layer(logger));

		// Should resolve (not reject) despite the typed CacheError.
		await expect(runWithLogger(post, layer, capturingLoggerLayer(captured))).resolves.toBeUndefined();

		// Should have logged a warning about the post-action error.
		const warnings = captured.filter((e) => e.level === "Warn");
		expect(warnings.length).toBeGreaterThan(0);
		expect(warnings.some((w) => w.message.includes("Post-action error"))).toBe(true);
	});

	it("kills the turbo server when state is present", async () => {
		const killed: Array<number> = [];
		const spy = (pid: number): void => {
			killed.push(pid);
		};

		const cache = ActionCacheTest.empty();
		const state = ActionStateTest.empty();
		// Seed turbo server state; no cache-state so post exits early after teardown
		state.entries.set(STATE_KEYS.turboServerState, JSON.stringify({ pid: 555, port: 41230, backend: "github" }));

		const layer = Layer.mergeAll(ActionCacheTest.layer(cache), ActionStateTest.layer(state));

		await run(makePost(spy), layer);

		expect(killed).toContain(555);
	});
});
