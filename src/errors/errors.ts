/**
 * Schema-based tagged errors with computed messages.
 *
 * Uses Schema.TaggedErrorClass so payloads are validated, errors round-trip
 * cleanly through ActionState, and downstream callers get a typed `.message`
 * getter for surfacing in logs.
 *
 * @module errors/errors
 */

import { Schema } from "effect";

const NonEmptyString = Schema.String.check(Schema.isMinLength(1));

/* v8 ignore start -- pure data carriers */

/**
 * Error thrown when configuration is invalid or missing.
 */
export class ConfigError extends Schema.TaggedErrorClass<ConfigError>()("ConfigError", {
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
export class RuntimeInstallError extends Schema.TaggedErrorClass<RuntimeInstallError>()("RuntimeInstallError", {
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
export class PackageManagerSetupError extends Schema.TaggedErrorClass<PackageManagerSetupError>()(
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
export class DependencyInstallError extends Schema.TaggedErrorClass<DependencyInstallError>()(
	"DependencyInstallError",
	{
		packageManager: NonEmptyString,
		reason: NonEmptyString,
		cause: Schema.optional(Schema.Unknown),
	},
) {
	get message(): string {
		return `Failed to install dependencies with ${this.packageManager}: ${this.reason}`;
	}
}

/**
 * Error thrown when a cache operation fails.
 */
export class CacheError extends Schema.TaggedErrorClass<CacheError>()("CacheError", {
	operation: Schema.Literals(["save", "restore", "key-generation"]),
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
