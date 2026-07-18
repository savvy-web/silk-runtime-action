import { Jsonc } from "@effected/jsonc";
import { Config, Effect, FileSystem, Option, Schema } from "effect";
import { ConfigError } from "../errors/errors.js";
import { DevEngines } from "../schemas/domain.js";

/**
 * Reads and parses package.json, decoding the devEngines field.
 * Wraps all failures in ConfigError.
 */
export const loadPackageJson = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;

	const content = yield* fs.readFileString("package.json", "utf-8").pipe(
		Effect.mapError(
			(cause) =>
				new ConfigError({
					reason:
						"package.json not found. This action requires a package.json with devEngines.packageManager and devEngines.runtime fields.",
					file: "package.json",
					cause,
				}),
		),
	);

	const raw = yield* Effect.try({
		try: () => JSON.parse(content) as unknown,
		catch: (cause) =>
			new ConfigError({
				reason: `Failed to parse package.json: Invalid JSON`,
				file: "package.json",
				cause,
			}),
	});

	const packageJson = yield* Schema.decodeUnknownEffect(Schema.Struct({ devEngines: DevEngines }))(raw).pipe(
		Effect.mapError(
			(cause) =>
				new ConfigError({
					reason: `package.json has invalid or missing devEngines field`,
					file: "package.json",
					cause,
				}),
		),
	);

	return packageJson.devEngines;
});

/**
 * Normalizes devEngines.runtime from a single object or array into always-array form.
 */
export const parseDevEngines = (devEngines: typeof DevEngines.Type) => {
	const runtimes = Array.isArray(devEngines.runtime) ? devEngines.runtime : [devEngines.runtime];
	return { ...devEngines, runtime: runtimes };
};

/**
 * Detects Biome version from the `biome-version` input override,
 * or by reading `biome.jsonc` / `biome.json` and extracting the version
 * from the `$schema` URL.
 *
 * Returns Option.none() if no Biome config is detected and no override is given.
 */
export const detectBiome = Effect.gen(function* () {
	// 1. Check explicit input override first
	const override = yield* Config.string("biome-version").pipe(Config.withDefault(""));
	if (override !== "") {
		return Option.some(override);
	}

	const fs = yield* FileSystem.FileSystem;

	// 2. Try biome.jsonc, then biome.json
	const configFile = yield* Effect.gen(function* () {
		const hasJsonc = yield* fs.access("biome.jsonc").pipe(
			Effect.map(() => true),
			Effect.catch(() => Effect.succeed(false)),
		);
		if (hasJsonc) return Option.some("biome.jsonc");

		const hasJson = yield* fs.access("biome.json").pipe(
			Effect.map(() => true),
			Effect.catch(() => Effect.succeed(false)),
		);
		if (hasJson) return Option.some("biome.json");

		return Option.none<string>();
	});

	if (Option.isNone(configFile)) {
		return Option.none<string>();
	}

	// 3. Read the config file and extract version from $schema URL
	const configContent = yield* fs
		.readFileString(configFile.value, "utf-8")
		.pipe(Effect.catch(() => Effect.succeed("{}")));

	const parsed = yield* Jsonc.parse(configContent).pipe(Effect.catch(() => Effect.succeed({} as unknown)));
	const schema = (parsed as { $schema?: string }).$schema;
	if (!schema) {
		return Option.none<string>();
	}

	const match = schema.match(/schemas\/([^/]+)\/schema\.json/);
	if (match?.[1]) {
		return Option.some(match[1]);
	}

	return Option.none<string>();
});

/**
 * Detects Turborepo configuration by checking if `turbo.json` exists.
 * Returns true if found, false otherwise.
 */
export const detectTurbo = Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;
	const exists = yield* fs.access("turbo.json").pipe(
		Effect.map(() => true),
		Effect.catch(() => Effect.succeed(false)),
	);
	return exists;
});
