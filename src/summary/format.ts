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
}

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
