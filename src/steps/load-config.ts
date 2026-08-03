import type { Path } from "effect";
import { Effect, FileSystem, Schema } from "effect";
import { ConfigError, PackageManagerSpec, RuntimeConfig, RuntimeSpec } from "../schema/domain.js";

/**
 * The slice of `package.json` this step decodes.
 *
 * @remarks
 * `Schema.Struct` ignores unknown keys, so every unrelated manifest field —
 * including a top-level corepack `packageManager` pin — is discarded rather
 * than consulted: `devEngines` is the only source of truth.
 *
 * `runtime` accepts either a single entry or a non-empty array of them. An
 * empty array is a decode failure, which keeps the normalized
 * {@link RuntimeConfig.runtimes} non-empty by construction.
 */
const PackageJsonDevEngines = Schema.Struct({
	devEngines: Schema.Struct({
		packageManager: PackageManagerSpec,
		runtime: Schema.Union([RuntimeSpec, Schema.NonEmptyArray(RuntimeSpec)]),
	}),
});

const decodePackageJson = Schema.decodeUnknownEffect(PackageJsonDevEngines);

/** Narrows the decoded `runtime` union without depending on `RuntimeSpec` being a class. */
const isRuntimeSpec = Schema.is(RuntimeSpec);

/**
 * Reads and decodes `package.json`'s `devEngines` block.
 *
 * @remarks
 * `Path` sits in `R` because the frozen Phase A contract declares it, not
 * because this step needs it — nothing here resolves a path.
 *
 * The manifest is read from the literal, cwd-relative path `package.json` and
 * parsed with strict `JSON.parse` — not JSONC. Every failure surfaces as a
 * {@link ConfigError}: a missing file, unparseable JSON, or any decode
 * rejection, the last collapsed into one message with the parse issue carried
 * as `cause` rather than rendered.
 *
 * Normalization is deliberately minimal — a single runtime becomes an array of
 * one, and nothing else changes. Duplicates survive, declaration order is
 * preserved, names are matched case-sensitively, and no field is defaulted.
 */
export const loadConfig: Effect.Effect<RuntimeConfig, ConfigError, FileSystem.FileSystem | Path.Path> = Effect.gen(
	function* () {
		const fs = yield* FileSystem.FileSystem;

		const content = yield* fs.readFileString("package.json", "utf-8").pipe(
			Effect.mapError(
				(cause) =>
					new ConfigError({
						reason: "missing-package-json",
						message:
							"package.json not found. This action requires a package.json with devEngines.packageManager and devEngines.runtime fields.",
						cause,
					}),
			),
		);

		const raw = yield* Effect.try({
			try: () => JSON.parse(content) as unknown,
			catch: (cause) =>
				new ConfigError({
					reason: "malformed-json",
					message: "Failed to parse package.json: Invalid JSON",
					cause,
				}),
		});

		const { devEngines } = yield* decodePackageJson(raw).pipe(
			Effect.mapError(
				(cause) =>
					new ConfigError({
						reason: "invalid-dev-engines",
						message: "package.json has invalid or missing devEngines field",
						cause,
					}),
			),
		);

		const config = RuntimeConfig.make({
			packageManager: devEngines.packageManager,
			runtimes: isRuntimeSpec(devEngines.runtime) ? [devEngines.runtime] : devEngines.runtime,
		});

		// The group these run in was silent, which made it the one step in the
		// pipeline whose log said nothing about what it learned — while
		// `detectBiome` and `detectTurbo` beside it both announce their findings
		// (ruling 31). `@` joins a name to its version here, and a space does in
		// the job summary; the split is v1's, per formatter, and is kept rather
		// than harmonized (ruling 54).
		yield* Effect.logInfo(
			`Detected runtime(s): ${config.runtimes.map((runtime) => `${runtime.name}@${runtime.version}`).join(", ")}`,
		);
		yield* Effect.logInfo(`Detected package manager: ${config.packageManager.name}@${config.packageManager.version}`);
		return config;
	},
);
