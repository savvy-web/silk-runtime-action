import { describe, expect, it } from "@effect/vitest";
import { ActionLogger, ActionOutputError, ActionOutputs } from "@effected/github-actions";
import { Cause, Effect, Exit, Layer, Logger, Option } from "effect";
import type { OutputsModel } from "../../../src/schema/outputs.js";
import { initialOutputs } from "../../../src/schema/outputs.js";
import { CacheState } from "../../../src/state.js";
import type { SummaryFacts } from "../../../src/steps/summary.js";
import { writeSummary } from "../../../src/steps/summary.js";

/** The facts a fully-configured run hands the summary. */
const facts = (overrides: Partial<SummaryFacts> = {}): SummaryFacts => ({
	outputs: {
		...initialOutputs,
		packageManager: "pnpm",
		packageManagerVersion: "11.8.0",
		biomeVersion: "2.4.16",
		biomeEnabled: true,
		turboEnabled: true,
	} satisfies OutputsModel,
	runtimes: [{ name: "node", version: "26.3.1", path: "/opt/toolcache/node/26.3.1" }],
	biome: Option.some({ version: "2.4.16", path: "/opt/toolcache/biome/2.4.16" }),
	biomeDetected: Option.some("2.4.16"),
	cache: CacheState.make({
		paths: ["**/node_modules"],
		primaryKey: "silk-linux-x64-abc",
		restoredKey: Option.some("silk-linux-x64-abc"),
		lockfiles: ["pnpm-lock.yaml"],
	}),
	turboCache: { backend: "github", port: Option.some(41230), state: Option.none() },
	dependenciesInstalled: true,
	...overrides,
});

/**
 * The doubles this suite runs against, capturing what reached the runner.
 *
 * @remarks
 * `summary` is stubbed rather than left to die because it is the member under
 * test; `ActionLogger.layerTest`'s `group` runs its body, so the final group's
 * lines reach the captured logger like any other.
 */
const harness = (options: { readonly summary?: (content: string) => Effect.Effect<void, ActionOutputError> } = {}) => {
	const panels: Array<string> = [];
	const logs: Array<string> = [];
	const groups: Array<string> = [];
	const layer = Layer.mergeAll(
		ActionOutputs.layerTest({
			summary: options.summary ?? ((content) => Effect.sync(() => void panels.push(content))),
		}),
		ActionLogger.layerTest({
			group: (name, effect) =>
				Effect.suspend(() => {
					groups.push(name);
					return effect;
				}),
		}),
		Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
	);
	return { panels, logs, groups, layer };
};

describe("writeSummary", () => {
	it.effect("writes the rendered panel to the job summary", () => {
		const { panels, layer } = harness();
		return Effect.gen(function* () {
			yield* writeSummary(facts());
			expect(panels).toHaveLength(1);
			expect(panels[0]).toContain("## 🚀 Runtime Setup");
			expect(panels[0]).toContain("| Runtime(s) | node 26.3.1 |");
			expect(panels[0]).toContain("| Package manager | pnpm 11.8.0 |");
			expect(panels[0]).toContain("| Biome | 2.4.16 |");
			expect(panels[0]).toContain("| Turbo cache | github · server ready (:41230) |");
			expect(panels[0]).toContain("| Dependency cache | ✅ exact hit |");
			expect(panels[0]).toContain("| Dependencies | installed |");
			expect(panels[0]).toContain("- Cache key: `silk-linux-x64-abc`");
			expect(panels[0]).toContain("- Lockfiles: `pnpm-lock.yaml`");
		}).pipe(Effect.provide(layer));
	});

	it.effect("closes with the final group, one line per installed tool", () => {
		const { logs, groups, layer } = harness();
		return Effect.gen(function* () {
			yield* writeSummary(
				facts({
					runtimes: [
						{ name: "node", version: "26.3.1", path: "/opt/toolcache/node/26.3.1" },
						{ name: "bun", version: "1.3.3", path: "/opt/toolcache/bun/1.3.3" },
					],
				}),
			);
			expect(groups).toContain("Runtime Setup Complete");
			// Ruling 50: the installed lines only — v1 printed the *requested* set
			// first and then repeated it tool by tool.
			expect(logs).toEqual([
				"node: 26.3.1",
				"bun: 1.3.3",
				"pnpm: 11.8.0",
				"Turbo: enabled",
				"Biome: v2.4.16",
				"Dependencies: installed",
			]);
		}).pipe(Effect.provide(layer));
	});

	it.effect("reports an undetected Biome as undetected, and a skipped install as skipped", () => {
		const { logs, layer } = harness();
		return Effect.gen(function* () {
			yield* writeSummary(
				facts({
					outputs: { ...initialOutputs, packageManager: "deno", packageManagerVersion: "2.5.6" },
					biome: Option.none(),
					biomeDetected: Option.none(),
					dependenciesInstalled: false,
				}),
			);
			// Ruling 36's wording, replacing v1's "not installed" — which was wrong
			// for the case it was printed in.
			expect(logs).toContain("Biome: not detected");
			expect(logs).toContain("Turbo: disabled");
			expect(logs).toContain("Dependencies: skipped");
		}).pipe(Effect.provide(layer));
	});

	it.effect("tells a Biome whose install failed apart from one that was never there", () => {
		const { panels, logs, layer } = harness();
		return Effect.gen(function* () {
			// The reachable third case: detection resolved a version, `installBiome`
			// failed, and the program degraded it to a warning. Reporting that as
			// "not detected" would be wrong in the same direction v1's "not
			// installed" was — it names the wrong step.
			yield* writeSummary(facts({ biome: Option.none(), biomeDetected: Option.some("2.4.16") }));
			expect(logs).toContain("Biome: detected, install failed");
			expect(logs).not.toContain("Biome: not detected");
			// The panel row stays omitted: it reports what this run *has*, and a
			// failed install leaves it with nothing to name.
			expect(panels[0]).not.toContain("| Biome |");
		}).pipe(Effect.provide(layer));
	});

	it.effect("takes the affirmative Biome line from the install result, not from detection", () => {
		const { logs, layer } = harness();
		return Effect.gen(function* () {
			// Detection resolved 2.4.16 and the outputs echo it, but the install
			// answered with a different build — quirk 51 says the line follows the
			// install.
			yield* writeSummary(facts({ biome: Option.some({ version: "2.4.9", path: "/opt/toolcache/biome/2.4.9" }) }));
			expect(logs).toContain("Biome: v2.4.9");
		}).pipe(Effect.provide(layer));
	});

	it.effect("degrades a failed write to a warning, and still logs the final group", () => {
		const { logs, layer } = harness({
			summary: () => Effect.fail(new ActionOutputError({ reason: "writeFailed", file: "GITHUB_STEP_SUMMARY" })),
		});
		return Effect.gen(function* () {
			const exit = yield* writeSummary(facts()).pipe(Effect.exit);
			expect(exit._tag).toBe("Success");
			expect(logs.join("\n")).toContain("Failed to write job summary: ");
			// The panel is an extra, not a gate: the group still runs.
			expect(logs).toContain("Dependencies: installed");
		}).pipe(Effect.provide(layer));
	});

	it.effect("does not degrade a smuggled-past-the-types cache state, which is a defect", () => {
		const { panels, layer } = harness();
		return Effect.gen(function* () {
			// The counterpart to the deleted render-degradation case (effected#239).
			// Renders cannot fail, so the `Effect.try` that used to sit here was
			// catching nothing it was written for — and this, which it was not: a
			// `CacheState` whose `lockfiles` is not an array, unreachable through the
			// schema. The wrapper turned that impossible state into a warning nobody
			// reads. It dies now, which is what an impossible state deserves, and this
			// case is what stops the wrapper being reinstated to "fix" it.
			const broken = { primaryKey: "k", restoredKey: Option.none(), lockfiles: null } as unknown as CacheState;
			const exit = yield* writeSummary(facts({ cache: broken })).pipe(Effect.exit);
			expect(exit._tag).toBe("Failure");
			// A defect, not the step's typed failure: `SummaryError` no longer has an
			// arm that could carry this.
			expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true);
			expect(panels).toHaveLength(0);
		}).pipe(Effect.provide(layer));
	});
});
