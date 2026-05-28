import { Schema } from "effect";

/**
 * Validates that a version string is absolute (no semver ranges).
 * Rejects strings containing: ^, ~, >, <, =, *, x, X
 */
export const AbsoluteVersion = Schema.String.pipe(
	Schema.filter(
		(v) => {
			// Reject semver range operators and wildcards
			const hasRangeOperators = /[~^<>=*xX]/.test(v);
			if (hasRangeOperators) {
				return false;
			}
			// Must match basic semver format: digits.digits.digits with optional prerelease/build
			const semverPattern = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?(\+[a-zA-Z0-9.-]+)?$/;
			return semverPattern.test(v);
		},
		{ message: () => "Must be an absolute version (e.g., '24.11.0'), not a semver range" },
	),
);

/**
 * Supported runtime names
 */
export const RuntimeName = Schema.Literal("node", "bun", "deno");
export type RuntimeName = typeof RuntimeName.Type;

/**
 * Supported package manager names
 */
export const PackageManagerName = Schema.Literal("npm", "pnpm", "yarn", "bun", "deno");
export type PackageManagerName = typeof PackageManagerName.Type;

/**
 * A single devEngines entry (generic, for backward compat)
 */
export const DevEngineEntry = Schema.Struct({
	name: Schema.String,
	version: AbsoluteVersion,
	onFail: Schema.optional(Schema.String),
});
export type DevEngineEntry = typeof DevEngineEntry.Type;

/**
 * Runtime entry with validated name
 */
export const RuntimeEntry = Schema.Struct({
	name: RuntimeName,
	version: AbsoluteVersion,
	onFail: Schema.optional(Schema.String),
});
export type RuntimeEntry = typeof RuntimeEntry.Type;

/**
 * Package manager entry with validated name
 */
export const PackageManagerEntry = Schema.Struct({
	name: PackageManagerName,
	version: AbsoluteVersion,
	onFail: Schema.optional(Schema.String),
});
export type PackageManagerEntry = typeof PackageManagerEntry.Type;

/**
 * Complete devEngines schema with typed entries
 */
export const DevEngines = Schema.Struct({
	packageManager: PackageManagerEntry,
	runtime: Schema.Union(RuntimeEntry, Schema.Array(RuntimeEntry)),
});
export type DevEngines = typeof DevEngines.Type;
