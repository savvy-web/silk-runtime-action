import { Jsonc } from "@effected/jsonc";
import { Data, Effect, FileSystem, Option } from "effect";

/**
 * Raised when a Biome config file cannot be read, or its `$schema` field
 * cannot be parsed into a version.
 */
export class BiomeDetectError extends Data.TaggedError("BiomeDetectError")<{
	readonly reason: "read" | "parse";
	readonly message: string;
	readonly cause?: unknown;
}> {}

/**
 * The config files this looks for, in the order it looks (oracle 5).
 *
 * @remarks
 * Working-directory relative, as in v1 — the same posture as `detectTurbo`, and
 * for the same reason: biome resolves its own config from the working
 * directory.
 */
const CONFIG_FILES = ["biome.jsonc", "biome.json"] as const;

/**
 * Biome's own `$schema` urls carry the version as a path segment.
 *
 * @remarks
 * v1's pattern, verbatim and deliberately unanchored (oracle 10). It matches on
 * any host, so a vendored or mirrored schema url resolves the same way, and the
 * captured segment is not validated — `next` and `latest` are things a
 * repository can legitimately pin, and biome's release tags are npm-style.
 */
const SCHEMA_VERSION = /schemas\/([^/]+)\/schema\.json/;

/** `Option.none()` for a string that is blank once trimmed. */
const nonBlank = (value: string): Option.Option<string> => {
	const trimmed = value.trim();
	return trimmed === "" ? Option.none() : Option.some(trimmed);
};

/**
 * The first of {@link CONFIG_FILES} that exists, if either does.
 *
 * @remarks
 * A probe rather than a read, so an *existing but unreadable* first file is
 * still the file this uses — falling through to `biome.json` because
 * `biome.jsonc` could not be opened would resolve a version the repository does
 * not use.
 */
const configFile = (fs: FileSystem.FileSystem): Effect.Effect<Option.Option<string>> =>
	Effect.gen(function* () {
		for (const candidate of CONFIG_FILES) {
			const exists = yield* fs.access(candidate).pipe(
				Effect.as(true),
				Effect.catch(() => Effect.succeed(false)),
			);
			if (exists) return Option.some(candidate);
		}
		return Option.none<string>();
	});

/**
 * The version `$schema` names, if the parsed config names one.
 *
 * @remarks
 * The `typeof` guard fixes a latent v1 defect (oracle 11): a truthy non-string
 * `$schema` — an object, as a mistyped config produces — reached `.match` and
 * threw a `TypeError` nothing caught, killing the whole action over an
 * optional feature.
 */
const schemaVersion = (config: unknown): Option.Option<string> => {
	if (config === null || typeof config !== "object") return Option.none();
	const schema = (config as { readonly $schema?: unknown }).$schema;
	if (typeof schema !== "string") return Option.none();
	return Option.fromUndefinedOr(SCHEMA_VERSION.exec(schema)?.[1]);
};

/**
 * Resolves which Biome version, if any, this run should install.
 *
 * @remarks
 * `requested` is the raw `biome-version` input. When present it wins outright;
 * when absent the version is derived from the `$schema` field of `biome.jsonc`
 * or `biome.json`, and `Option.none()` means "no Biome in this repository, skip
 * the install".
 *
 * Detection is deliberately split from installation so the resolved version is
 * available *before* `restoreCache`, which folds it into the cache key —
 * the legacy ordering (`legacy-v1/program.ts:382-411`).
 *
 * The override short-circuits **before** any filesystem access (oracle 1-2), so
 * a repository with a config file it wants overridden is not read at all. It is
 * trimmed, which v1 did not do (quirk 3): the version becomes a path segment in
 * a release url, and padding makes that a 404 rather than an error anyone can
 * read. Blank-after-trim is therefore absent, matching the empty-string-is
 * -absent reading `ActionInput` already applies. What it is *not* is validated
 * (quirk 4, consciously kept): biome tags are npm-style and the url encodes
 * whatever is asked for.
 *
 * `BiomeDetectError` stays on the signature and is never raised. Every
 * file-level failure — absent, unreadable, unparseable, no `$schema`, a
 * `$schema` that names no version — resolves to `Option.none()` (oracle 7),
 * because Biome is optional and a repository whose config this cannot read is
 * not a repository the action should fail. The declared error keeps the
 * contract open for a genuinely unexpected case without making today's
 * tolerance a lie, which is the same posture `restoreCache` takes.
 */
export const detectBiome = (
	requested: Option.Option<string>,
): Effect.Effect<Option.Option<string>, BiomeDetectError, FileSystem.FileSystem> =>
	Effect.gen(function* () {
		const override = Option.flatMap(requested, nonBlank);
		if (Option.isSome(override)) {
			yield* Effect.logInfo(`Detected Biome: ${override.value}`);
			return override;
		}

		const fs = yield* FileSystem.FileSystem;
		const file = yield* configFile(fs);
		if (Option.isNone(file)) return Option.none();

		// v1 read an unreadable file as "{}" and an unparseable one as {}; both land
		// here as `Option.none()` by way of an empty object, which is the same
		// answer through one path instead of two.
		const contents = yield* fs.readFileString(file.value).pipe(Effect.catch(() => Effect.succeed("{}")));
		const parsed = yield* Jsonc.parse(contents).pipe(Effect.catch(() => Effect.succeed({} as unknown)));

		const version = schemaVersion(parsed);
		if (Option.isSome(version)) yield* Effect.logInfo(`Detected Biome: ${version.value}`);
		return version;
	});
