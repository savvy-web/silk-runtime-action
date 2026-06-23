// src/services/summary.ts
import { GithubMarkdown } from "@savvy-web/github-action-effects";

/** Active turbo cache backend reported by applyTurboCache. */
export type TurboCacheBackend = "github" | "s3" | "remote" | "none";

/** Dependency-cache restore outcome. */
export type CacheHit = "exact" | "partial" | "none";

/** Facts about a completed runtime setup, rendered into the job summary. */
export interface RuntimeSummary {
	readonly runtimes: ReadonlyArray<{ readonly name: string; readonly version: string }>;
	readonly packageManager: { readonly name: string; readonly version: string };
	readonly biome: string | null;
	readonly turbo: { readonly backend: TurboCacheBackend; readonly port: number | null };
	readonly cacheHit: CacheHit;
	readonly dependenciesInstalled: boolean;
	readonly cacheKey: string;
	readonly lockfiles: ReadonlyArray<string>;
}

/** Human label for the turbo cache state (step line + summary row). */
export const formatTurboLine = (backend: TurboCacheBackend, port: number | null): string => {
	if (backend === "none") return "disabled";
	if (backend === "remote") return "passthrough (Vercel)";
	return `${backend} · server ready${port === null ? "" : ` (:${port})`}`;
};

/** One-line detected-config summary for the "Detect configuration" step. */
export const formatDetectLine = (s: {
	runtimes: ReadonlyArray<{ name: string; version: string }>;
	packageManager: { name: string; version: string };
	biome: string | null;
	turbo: boolean;
}): string => {
	const parts = [
		...s.runtimes.map((r) => `${r.name} ${r.version}`),
		`${s.packageManager.name} ${s.packageManager.version}`,
	];
	if (s.biome) parts.push(`biome ${s.biome}`);
	if (s.turbo) parts.push("turbo");
	return parts.join(" · ");
};

/** One-line dependency-cache summary for the "Restore cache" step. */
export const formatCacheLine = (hit: CacheHit, lockfileCount: number): string => {
	const lf = `${lockfileCount} lockfile${lockfileCount === 1 ? "" : "s"}`;
	if (hit === "exact") return `exact hit (${lf})`;
	if (hit === "partial") return `partial hit (${lf})`;
	return `miss (${lf})`;
};

const cacheCell = (hit: CacheHit): string =>
	hit === "exact" ? "✅ exact hit" : hit === "partial" ? "♻️ partial hit" : "⬜ miss";

/** Build the GitHub job-summary panel (markdown) for the runtime setup. */
export const buildRuntimeSummary = (s: RuntimeSummary): string => {
	const rows: Array<Array<string>> = [
		["Runtime(s)", s.runtimes.map((r) => `${r.name} ${r.version}`).join(", ")],
		["Package manager", `${s.packageManager.name} ${s.packageManager.version}`],
	];
	if (s.biome) rows.push(["Biome", s.biome]);
	rows.push(["Turbo cache", formatTurboLine(s.turbo.backend, s.turbo.port)]);
	rows.push(["Dependency cache", cacheCell(s.cacheHit)]);
	rows.push(["Dependencies", s.dependenciesInstalled ? "installed" : "skipped"]);

	const detailItems = [
		s.cacheKey ? `Cache key: \`${s.cacheKey}\`` : "",
		s.lockfiles.length > 0 ? `Lockfiles: ${s.lockfiles.map((l) => `\`${l}\``).join(", ")}` : "Lockfiles: none",
	].filter((l) => l !== "");

	return [
		GithubMarkdown.heading("🚀 Runtime Setup", 2),
		GithubMarkdown.table(["Component", "Detail"], rows),
		GithubMarkdown.details("Cache details", GithubMarkdown.list(detailItems)),
	].join("\n\n");
};
