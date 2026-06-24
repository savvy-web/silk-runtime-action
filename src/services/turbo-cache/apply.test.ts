import { ActionOutputsTest, ActionStateTest } from "@savvy-web/github-action-effects/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { applyTurboCache } from "./apply.js";
import type { SpawnSpec } from "./lifecycle.js";

const layers = (o: ReturnType<typeof ActionOutputsTest.empty>, s: ReturnType<typeof ActionStateTest.empty>) =>
	Layer.mergeAll(ActionOutputsTest.layer(o), ActionStateTest.layer(s));

const fakeSpawn = (pid: number) => (_spec: SpawnSpec) => Effect.succeed(pid);
const ready = (ok: boolean) => (_port: number) => Effect.succeed(ok);

const findVar = (o: ReturnType<typeof ActionOutputsTest.empty>, name: string) =>
	o.variables.find((v) => v.name === name)?.value;

const baseDeps = { serverEntry: "/x/dist/turbo-server.js", prefix: "", spawn: fakeSpawn(1), waitForReady: ready(true) };

describe("applyTurboCache", () => {
	it("off mode does nothing", async () => {
		const o = ActionOutputsTest.empty();
		const s = ActionStateTest.empty();
		const r = await Effect.runPromise(applyTurboCache({ mode: "off" }, baseDeps).pipe(Effect.provide(layers(o, s))));
		expect(r).toEqual({ backend: "none", port: null });
		expect(o.variables).toHaveLength(0);
		expect(s.entries.has("turbo-server-state")).toBe(false);
	});

	it("passthrough exports real token/team and no TURBO_API", async () => {
		const o = ActionOutputsTest.empty();
		const s = ActionStateTest.empty();
		const r = await Effect.runPromise(
			applyTurboCache({ mode: "passthrough", token: "t", team: "m" }, baseDeps).pipe(Effect.provide(layers(o, s))),
		);
		expect(r).toEqual({ backend: "remote", port: null });
		expect(findVar(o, "TURBO_TOKEN")).toBe("t");
		expect(findVar(o, "TURBO_TEAM")).toBe("m");
		expect(findVar(o, "TURBO_API")).toBeUndefined();
	});

	it("embedded github (ready) spawns, exports TURBO_API + dummy creds, and saves state", async () => {
		const o = ActionOutputsTest.empty();
		const s = ActionStateTest.empty();
		const r = await Effect.runPromise(
			applyTurboCache(
				{ mode: "embedded", backend: "github" },
				{
					...baseDeps,
					prefix: "pre/",
					spawn: fakeSpawn(4242),
					waitForReady: ready(true),
				},
			).pipe(Effect.provide(layers(o, s))),
		);
		expect(r).toEqual({ backend: "github", port: 41230 });
		expect(findVar(o, "TURBO_API")).toBe("http://127.0.0.1:41230");
		expect(findVar(o, "TURBO_TOKEN")).toBe("silk-runtime-action");
		expect(findVar(o, "TURBO_TEAM")).toBe("silk-runtime-action");
		// ActionStateTestState.entries is Map<string,string> keyed by state key
		expect(s.entries.has("turbo-server-state")).toBe(true);
	});

	it("embedded but never ready: degrades to none, no TURBO_API, but still saves state for cleanup", async () => {
		const o = ActionOutputsTest.empty();
		const s = ActionStateTest.empty();
		const r = await Effect.runPromise(
			applyTurboCache(
				{ mode: "embedded", backend: "github" },
				{
					...baseDeps,
					spawn: fakeSpawn(4242),
					waitForReady: ready(false),
				},
			).pipe(Effect.provide(layers(o, s))),
		);
		expect(r).toEqual({ backend: "none", port: null });
		expect(findVar(o, "TURBO_API")).toBeUndefined();
		// state still saved so post can kill the half-started pid
		expect(s.entries.has("turbo-server-state")).toBe(true);
	});
});
