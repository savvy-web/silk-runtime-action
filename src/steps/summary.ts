import { ActionLogger, ActionOutputs } from "@effected/github-actions";
import { Data, Effect, Option } from "effect";

import type { OutputsModel } from "../schema/outputs.js";
import type { CacheState } from "../state.js";
import { buildRuntimeSummary } from "../summary/format.js";
import type { InstalledRuntime } from "./install-runtimes.js";
import type { StartedTurboCache } from "./turbo-cache.js";

/**
 * Raised when the job summary panel cannot be rendered, or cannot be written.
 *
 * @remarks
 * Shaped, then logged — never raised, on the same terms as `CacheError`: a
 * summary is a report *about* a run that already happened, and failing the job
 * over one would discard work that succeeded.
 *
 * Two reasons because the two failures call for different responses. `write` is
 * the runner refusing `GITHUB_STEP_SUMMARY`, which is an environment problem
 * and usually transient; `render` is this action's own markdown assembly
 * throwing, which is a bug here. v1 covered only the write, so a render throw
 * became a defect that took the job down after every install had succeeded
 * (ruling 53).
 */
export class SummaryError extends Data.TaggedError("SummaryError")<{
	readonly reason: "render" | "write";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/**
 * Everything the summary reports, from the steps that learned it.
 *
 * @remarks
 * A params object rather than the Phase A contract's lone `OutputsModel`, and
 * that is a deliberate contract change (note 47): three of the panel's facts
 * are simply not outputs. The published set carries the cache tristate but not
 * the key it was computed from, a comma-joined lockfile string rather than the
 * list, and nothing at all about whether the dependency install ran.
 *
 * Each field earns its place by carrying something `outputs` cannot:
 *
 * - `runtimes` — the installed list in `devEngines` declaration order. The
 *   outputs hold three fixed `{rt}Version` slots, which cannot express order.
 * - `biome` — the *install* result. The outputs echo it, but taking it from
 *   here is what makes quirk 51 literal rather than inferred: the final line
 *   reports what was installed, not what was detected.
 * - `biomeDetected` — the *detection* result, which no output carries at all
 *   once the install has failed and `biome-enabled` has gone to `false`.
 * - `cache` — the whole restore. The outputs have the tristate, not the key or
 *   the resolved file list.
 * - `turboCache` — the typed port. The output is `""` when nothing is
 *   listening, and parsing it back would be a round trip through a string.
 * - `dependenciesInstalled` — `installDependencies`' truthful `ran`, which is
 *   not an output at all. v1 echoed the *input* here and so reported deno's
 *   skipped install as done (quirk 52).
 *
 * `outputs` stays for what it is authoritative about: the package manager and
 * whether a `turbo.json` was detected.
 */
export interface SummaryFacts {
	readonly outputs: OutputsModel;
	/** What `installRuntimes` installed, in declaration order. */
	readonly runtimes: ReadonlyArray<InstalledRuntime>;
	/** What `installBiome` installed, if anything. */
	readonly biome: Option.Option<{ readonly version: string; readonly path: string }>;
	/**
	 * What `detectBiome` resolved, if anything.
	 *
	 * @remarks
	 * Carried *alongside* the install result rather than folded into it, because
	 * the final group's Biome line needs to tell the two `None`s apart: no
	 * `biome.jsonc` and no input at all, versus a version this run found and then
	 * failed to fetch. The panel needs no such distinction — its row reports what
	 * the run *has*, and both cases have nothing to name.
	 */
	readonly biomeDetected: Option.Option<string>;
	/** What `restoreCache` restored, and the key and lockfiles it asked with. */
	readonly cache: CacheState;
	/** What `startTurboCache` started. */
	readonly turboCache: StartedTurboCache;
	/** Whether an install command actually ran and succeeded. */
	readonly dependenciesInstalled: boolean;
}

/**
 * What the closing group says about Biome, in three arms.
 *
 * @remarks
 * The install result alone cannot distinguish the two ways it comes back
 * `None`. A repository with no `biome.jsonc` and no `biome-version` input never
 * asked for Biome; a repository that pinned one and hit a 404 asked and did not
 * get it. Both are `None`, and calling them the same thing names the wrong step
 * for one of them — which is exactly the defect ruling 36 fixed in the other
 * direction, v1 having said `not installed` for a Biome nobody looked for.
 *
 * The **panel row stays omitted** in the failed-install case, deliberately: the
 * table reports what this run *has*, and a failed install leaves it with no
 * version to put in the cell. The log group is where the difference belongs,
 * because the log is where someone goes to find out why.
 */
const biomeLine = (facts: SummaryFacts): string => {
	if (Option.isSome(facts.biome)) return `v${facts.biome.value.version}`;
	return Option.isSome(facts.biomeDetected) ? "detected, install failed" : "not detected";
};

/**
 * The closing log group: one line per tool, then the three facts that are not
 * tools.
 *
 * @remarks
 * v1 printed the *requested* runtime set on one `Runtime(s):` line and then
 * repeated the same information tool by tool. Ruling 50 collapses the two and
 * keeps the installed lines, which also makes the block uniform: every runtime
 * and the package manager render as `name: version`, in one shape.
 *
 * `Biome:` is the one line carrying a `v` prefix. That is v1's, kept — the
 * negative arms are not. v1 had one, `not installed`, and printed it for two
 * different situations; ruling 36 renamed it to `not detected`, which fixed the
 * common case and left the other one named wrong in the opposite direction. So
 * there are three arms (see {@link biomeLine}).
 */
const finalGroup = (facts: SummaryFacts): Effect.Effect<void> =>
	Effect.gen(function* () {
		for (const runtime of facts.runtimes) yield* Effect.logInfo(`${runtime.name}: ${runtime.version}`);
		yield* Effect.logInfo(`${facts.outputs.packageManager}: ${facts.outputs.packageManagerVersion}`);
		yield* Effect.logInfo(`Turbo: ${facts.outputs.turboEnabled ? "enabled" : "disabled"}`);
		yield* Effect.logInfo(`Biome: ${biomeLine(facts)}`);
		yield* Effect.logInfo(`Dependencies: ${facts.dependenciesInstalled ? "installed" : "skipped"}`);
	});

/**
 * Renders the job-summary panel and writes it, then closes the run with the
 * `Runtime Setup Complete` group.
 *
 * @remarks
 * Both halves live here so the ordering is not something `program.ts` has to
 * remember (note 48): the panel is written first, the group logged after, and a
 * reader of the workflow log sees the run end where it ended.
 *
 * **It cannot fail.** The declared {@link SummaryError} is the shape a failure
 * takes before it is logged. The render arm degrades to a warning and skips the
 * write — there is nothing to write — while the group still runs, because the
 * facts it logs were already known before anything was rendered.
 *
 * The render goes through `Effect.try` rather than being called directly:
 * `GitHubMarkdown` throws its serializer's failures as defects by design, and a
 * defect escaping here is exactly the thing v1 could not survive.
 */
export const writeSummary = (facts: SummaryFacts): Effect.Effect<void, SummaryError, ActionOutputs | ActionLogger> =>
	Effect.gen(function* () {
		const outputs = yield* ActionOutputs;
		const logger = yield* ActionLogger;

		yield* Effect.try({
			try: () =>
				buildRuntimeSummary({
					runtimes: facts.runtimes,
					packageManager: { name: facts.outputs.packageManager, version: facts.outputs.packageManagerVersion },
					biome: Option.map(facts.biome, (installed) => installed.version),
					turbo: { backend: facts.turboCache.backend, port: facts.turboCache.port },
					cache: facts.cache,
					dependenciesInstalled: facts.dependenciesInstalled,
				}),
			catch: (cause) =>
				new SummaryError({
					reason: "render",
					message: `Failed to render job summary: ${cause instanceof Error ? cause.message : String(cause)}`,
					cause,
				}),
		}).pipe(
			Effect.flatMap((panel) =>
				outputs
					.summary(panel)
					.pipe(
						Effect.mapError(
							(cause) =>
								new SummaryError({ reason: "write", message: `Failed to write job summary: ${cause.message}`, cause }),
						),
					),
			),
			// One arm for both reasons: each has already said which it is in its own
			// prose, and the response to either is the same — say so and carry on.
			Effect.catch((error) => Effect.logWarning(error.message)),
		);

		yield* logger.group("Runtime Setup Complete", finalGroup(facts));
	});
