/**
 * Every string this action renders about what it set up: the one-line step
 * summaries and the job-summary panel.
 *
 * @remarks
 * Pure and service-free on purpose. The prose is the parity surface — a
 * consumer's workflow log and job summary are what change when it drifts — so
 * it lives in one module that a test can pin verbatim, rather than being
 * inlined at the six call sites that emit it.
 *
 * Two separator conventions live here side by side, and both are deliberate
 * (ruling 54): the detect line and the panel join a name to its version with a
 * **space**, while the final log group and the `Detected …` info lines use
 * `@`. They are not harmonized because each is v1's, and the two are read in
 * different places — one by a human skimming a summary, the other by anyone
 * grepping a log for `node@`.
 *
 * @module summary/format
 */

import { GitHubMarkdown } from "@effected/github-actions";
import { Option } from "effect";

import type { OutputsModel } from "../schema/outputs.js";
import type { CacheState } from "../state.js";
import { isExactHit } from "../state.js";

/** A name/version pair, however it was learned. */
export interface NamedVersion {
	readonly name: string;
	readonly version: string;
}

/** The `turbo-cache-backend` vocabulary, borrowed from the output it publishes. */
export type TurboCacheBackend = OutputsModel["turboCacheBackend"];

/** What the detect line reports. */
export interface DetectFacts {
	readonly runtimes: ReadonlyArray<NamedVersion>;
	readonly packageManager: NamedVersion;
	/** The resolved Biome version, when one was detected. */
	readonly biome: Option.Option<string>;
	/** Whether a `turbo.json` was found. */
	readonly turbo: boolean;
	/**
	 * Whether `bats-core` was detected.
	 *
	 * @remarks
	 * A bare word in the detect line, like `turbo` — detection learns *that*
	 * bash testing is present, not a version.
	 */
	readonly bats: boolean;
}

/** What the job-summary panel renders. */
export interface RuntimeSummaryFacts {
	readonly runtimes: ReadonlyArray<NamedVersion>;
	readonly packageManager: NamedVersion;
	/** The installed Biome version, when one was installed. */
	readonly biome: Option.Option<string>;
	readonly turbo: { readonly backend: TurboCacheBackend; readonly port: Option.Option<number> };
	/**
	 * The restore, whole.
	 *
	 * @remarks
	 * One field rather than v1's three (`cacheHit`, `cacheKey`, `lockfiles`):
	 * the panel derives all three from it, and passing the state means the
	 * tristate is computed by {@link isExactHit} — the same comparison the
	 * `cache-hit` output and the post phase turn on — instead of being restated
	 * as a third enum that could disagree with them.
	 */
	readonly cache: CacheState;
	readonly dependenciesInstalled: boolean;
	/** What the BATS row reports, when `bats-core` was requested. */
	readonly bats: Option.Option<BatsSummary>;
	/** What the kcov row reports, when kcov was requested. */
	readonly kcov: Option.Option<KcovSummary>;
}

/** What the BATS panel row reports. */
export interface BatsSummary {
	readonly version: string;
	readonly libraries: ReadonlyArray<{ readonly name: string; readonly version: string }>;
}

/**
 * What the kcov panel row reports.
 *
 * @remarks
 * `unavailable` exists because kcov's failure is *silent* where Biome's is
 * not. A failed Biome install surfaces immediately as a failing lint step, so
 * its row can afford to be omitted (see `buildRuntimeSummary`). A failed kcov
 * install does not: the consumer's tests still pass, coverage is simply
 * absent, and the only other signal is a warning inside a collapsed log
 * group. The panel is the one place that has to say it out loud. This is the
 * single place BATS/kcov and Biome are treated differently, and it is
 * deliberate — the two new rows still follow Biome's omit-when-not-requested
 * rule, they just don't stay silent about a request that failed.
 *
 * `bats` stays lowercase in the detect line, `BATS` is the panel row label,
 * and `kcov` is lowercase in both — following ruling 55's `biome`/`Biome`
 * split for the same reason: BATS is an acronym conventionally capitalized in
 * prose, kcov is a project name that spells itself lowercase everywhere. Do
 * not harmonize these with each other.
 */
export type KcovSummary =
	| { readonly _tag: "installed"; readonly version: string; readonly cacheHit: boolean }
	| { readonly _tag: "unavailable" };

/** The separator both joined lines use — a middle dot, U+00B7, not a hyphen or a bullet. */
const DOT = " · ";

/**
 * What the turbo remote cache ended up being, in one phrase.
 *
 * @remarks
 * Shared by the step line and the panel row so the log and the summary cannot
 * disagree. The port is an `Option<number>` rather than the `turbo-cache-port`
 * output's string (note 45): that output is `""` when no server is listening,
 * and parsing it back would turn a typed absence into a string comparison.
 *
 * `remote` says "passthrough (Vercel)" rather than naming a port because there
 * is no local server — the run talks to Vercel's endpoint, which this action
 * does not own and does not name.
 */
export const formatTurboLine = (backend: TurboCacheBackend, port: Option.Option<number>): string => {
	if (backend === "none") return "disabled";
	if (backend === "remote") return "passthrough (Vercel)";
	return `${backend}${DOT}server ready${Option.match(port, { onNone: () => "", onSome: (bound) => ` (:${bound})` })}`;
};

/**
 * Everything this run detected, on one line.
 *
 * @remarks
 * The headline a reader skims instead of expanding four collapsed groups.
 * `biome` is lowercase here and `Biome` in the panel's row label — v1's split,
 * kept verbatim (ruling 55) — and turbo appears as a bare word because
 * detection learns that it is configured, not which version.
 */
export const formatDetectLine = (facts: DetectFacts): string => {
	const parts = [
		...facts.runtimes.map((runtime) => `${runtime.name} ${runtime.version}`),
		`${facts.packageManager.name} ${facts.packageManager.version}`,
	];
	if (Option.isSome(facts.biome)) parts.push(`biome ${facts.biome.value}`);
	if (facts.turbo) parts.push("turbo");
	if (facts.bats) parts.push("bats");
	return parts.join(DOT);
};

/**
 * The dependency cache's outcome as a panel cell.
 *
 * @remarks
 * Derived from the state rather than from the `cache-hit` output's literals
 * (note 46), for the same reason `restore-cache`'s `cacheLine` is: there is one
 * definition of "exact", and it is {@link isExactHit}.
 */
export const cacheCell = (cache: CacheState): string => {
	if (Option.isNone(cache.restoredKey)) return "⬜ miss";
	return isExactHit(cache) ? "✅ exact hit" : "♻️ partial hit";
};

/**
 * kcov's outcome as a panel cell.
 *
 * @remarks
 * Its own helper, not a reuse of {@link cacheCell} — that one is typed on
 * `CacheState` and encodes a three-way exact/partial/miss distinction that
 * kcov's single-entry cache does not have.
 */
export const kcovCell = (summary: KcovSummary): string =>
	summary._tag === "unavailable"
		? "⚠️ unavailable"
		: `${summary.version}${DOT}${summary.cacheHit ? "✅ cached" : "⬜ built"}`;

/**
 * The BATS row's value: the core version, then each helper library
 * short-named (its `bats-` prefix stripped) and versioned, all inline on the
 * module's existing separator.
 *
 * @remarks
 * The libraries do not get their own rows, and they do not go in the
 * `Cache details` block — that block is about the dependency cache and would
 * be the wrong home for a version list.
 */
const batsCell = (summary: BatsSummary): string =>
	[summary.version, ...summary.libraries.map((lib) => `${lib.name.replace(/^bats-/, "")} ${lib.version}`)].join(DOT);

/**
 * The job-summary panel: a heading, a table of what was set up, and a
 * collapsed block naming the cache key and the lockfiles it was hashed from.
 *
 * @remarks
 * Three fragments joined by a blank line, exactly as v1 assembled them.
 * Structure goes through `GitHubMarkdown` rather than string joining so a cell
 * carrying a pipe — a lockfile pattern, say — escapes rather than shifting
 * every column after it.
 *
 * The Biome row is **omitted** when nothing was installed rather than rendered
 * empty: a table row saying nothing costs a reader a glance, and the
 * `Dependencies` row already covers "this run did less than you expected".
 * The BATS and kcov rows follow the same omit-when-not-requested rule (both
 * are `Option.none()` when the tool was never asked for), with one exception:
 * a kcov that was requested and failed still renders, as `⚠️ unavailable`
 * rather than a missing row — see {@link KcovSummary} for why that one case
 * cannot afford to stay silent.
 * The lockfiles detail item is the opposite case and is unconditional — a miss
 * with no lockfiles at all is a different problem from a miss with three, so
 * `Lockfiles: none` has to be said out loud.
 */
export const buildRuntimeSummary = (facts: RuntimeSummaryFacts): string => {
	const rows: Array<ReadonlyArray<string>> = [
		["Runtime(s)", facts.runtimes.map((runtime) => `${runtime.name} ${runtime.version}`).join(", ")],
		["Package manager", `${facts.packageManager.name} ${facts.packageManager.version}`],
	];
	if (Option.isSome(facts.biome)) rows.push(["Biome", facts.biome.value]);
	if (Option.isSome(facts.bats)) rows.push(["BATS", batsCell(facts.bats.value)]);
	if (Option.isSome(facts.kcov)) rows.push(["kcov", kcovCell(facts.kcov.value)]);
	rows.push(["Turbo cache", formatTurboLine(facts.turbo.backend, facts.turbo.port)]);
	rows.push(["Dependency cache", cacheCell(facts.cache)]);
	rows.push(["Dependencies", facts.dependenciesInstalled ? "installed" : "skipped"]);

	const details = [
		...(facts.cache.primaryKey === "" ? [] : [`Cache key: ${GitHubMarkdown.code(facts.cache.primaryKey)}`]),
		facts.cache.lockfiles.length === 0
			? "Lockfiles: none"
			: `Lockfiles: ${facts.cache.lockfiles.map((lockfile) => GitHubMarkdown.code(lockfile)).join(", ")}`,
	];

	return [
		GitHubMarkdown.heading("🚀 Runtime Setup", 2),
		GitHubMarkdown.table(["Component", "Detail"], rows),
		GitHubMarkdown.details("Cache details", GitHubMarkdown.list(details)),
	].join("\n\n");
};
