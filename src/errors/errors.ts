/**
 * Schema-based tagged errors with computed messages.
 *
 * Uses Schema.TaggedError so payloads are validated, errors round-trip
 * cleanly through ActionState, and downstream callers get a typed `.message`
 * getter for surfacing in logs.
 *
 * @module errors/errors
 */

import { Schema } from "effect";

const NonEmptyString = Schema.String.pipe(Schema.minLength(1));

/* v8 ignore start -- pure data carriers */

/**
 * Error thrown when configuration is invalid or missing.
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()("ConfigError", {
	reason: NonEmptyString,
	file: Schema.optional(Schema.String),
	cause: Schema.optional(Schema.Unknown),
}) {
	get message(): string {
		return this.file ? `${this.reason} (at ${this.file})` : this.reason;
	}
}

/**
 * Error thrown when a runtime (node, bun, deno) fails to install.
 */
export class RuntimeInstallError extends Schema.TaggedError<RuntimeInstallError>()("RuntimeInstallError", {
	runtime: NonEmptyString,
	version: NonEmptyString,
	reason: NonEmptyString,
	cause: Schema.optional(Schema.Unknown),
}) {
	get message(): string {
		return `Failed to install ${this.runtime}@${this.version}: ${this.reason}`;
	}
}

/**
 * Error thrown when setting up a package manager fails.
 */
export class PackageManagerSetupError extends Schema.TaggedError<PackageManagerSetupError>()(
	"PackageManagerSetupError",
	{
		packageManager: NonEmptyString,
		version: NonEmptyString,
		reason: NonEmptyString,
		cause: Schema.optional(Schema.Unknown),
	},
) {
	get message(): string {
		return `Failed to setup ${this.packageManager}@${this.version}: ${this.reason}`;
	}
}

/**
 * Error thrown when installing dependencies fails.
 */
export class DependencyInstallError extends Schema.TaggedError<DependencyInstallError>()("DependencyInstallError", {
	packageManager: NonEmptyString,
	reason: NonEmptyString,
	cause: Schema.optional(Schema.Unknown),
}) {
	get message(): string {
		return `Failed to install dependencies with ${this.packageManager}: ${this.reason}`;
	}
}

/**
 * Error thrown when a cache operation fails.
 */
export class CacheError extends Schema.TaggedError<CacheError>()("CacheError", {
	operation: Schema.Literal("save", "restore", "key-generation"),
	reason: NonEmptyString,
	cause: Schema.optional(Schema.Unknown),
}) {
	get message(): string {
		return `Cache ${this.operation} failed: ${this.reason}`;
	}
}

/**
 * Union of all expected action errors.
 */
export type ActionError =
	| ConfigError
	| RuntimeInstallError
	| PackageManagerSetupError
	| DependencyInstallError
	| CacheError;

/* v8 ignore stop */
