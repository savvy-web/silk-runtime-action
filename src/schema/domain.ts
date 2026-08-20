import { SemVer } from "@effected/semver";
import { Data, Schema } from "effect";

/**
 * Supported JavaScript runtime names, as accepted by `devEngines.runtime[].name`.
 */
export const RuntimeName = Schema.Literals(["node", "bun", "deno"]);
export type RuntimeName = typeof RuntimeName.Type;

/**
 * Supported package manager names, as accepted by `devEngines.packageManager.name`.
 *
 * @remarks
 * Five values, not four: `deno` is a package manager as well as a runtime, and
 * `action.yml` documents the `package-manager` output as
 * `npm | pnpm | yarn | bun | deno`. Dropping it would be a silent parity break
 * against v1.
 */
export const PackageManagerName = Schema.Literals(["npm", "pnpm", "yarn", "bun", "deno"]);
export type PackageManagerName = typeof PackageManagerName.Type;

/**
 * A version string with no semver range operators — exactly `MAJOR.MINOR.PATCH`,
 * with an optional prerelease/build suffix. A range, wildcard, or partial
 * version (`^24.0.0`, `24.x`, `1.2`, `*`) is rejected. The schema's `Type` stays
 * `string` — this checks the input, it does not transform it into a `SemVer`
 * instance — because `devEngines` values are stored and re-serialized as plain
 * strings.
 *
 * @remarks
 * `SemVer.ExactVersionString` from `@effected/semver` *is* this check, so the
 * alias is the whole definition (upstream round 7, item 9). The local
 * composition it replaces was `parseResult` plus a `trim() === s` guard, because
 * `parseResult` tolerated padding; `SemVer.isValid` — which
 * `ExactVersionString` is refined by — rejects untrimmed input outright, which
 * is the documented upstream posture and exactly what this needed. Padding has
 * to fail here rather than become a 404 later: the accepted string is
 * interpolated verbatim into runtime download URLs.
 *
 * `ExactVersionString` rather than `PinnableVersionString`: build metadata is
 * allowed, and one fixture depends on it — pnpm carries an integrity hash in
 * its `devEngines` version (`11.8.0+sha512.c1f5…`).
 */
export const AbsoluteVersion = SemVer.ExactVersionString;
export type AbsoluteVersion = typeof AbsoluteVersion.Type;

const OnFail = Schema.Literals(["warn", "error", "ignore"]);

/**
 * The normalized three-state form of an optional tool input: `auto` detects
 * the tool from the repository, `on` forces the install, `off` skips it.
 *
 * @remarks
 * Backs the `bats` and `kcov` inputs. Declared here rather than alongside
 * `detectBats` because `schema/inputs.ts` also consumes it — `schema/` is the
 * lower layer in this repo, so the type lives where both `steps/` and
 * `schema/` can import it without inverting that layering.
 */
export const ToolMode = Schema.Literals(["auto", "on", "off"]);
export type ToolMode = typeof ToolMode.Type;

/**
 * A single `devEngines.runtime` entry: a runtime name paired with an absolute version.
 */
export class RuntimeSpec extends Schema.Class<RuntimeSpec>("RuntimeSpec")({
	name: RuntimeName,
	version: AbsoluteVersion,
	onFail: Schema.optionalKey(OnFail),
}) {}

/**
 * The `devEngines.packageManager` entry: a package manager name paired with an
 * absolute version.
 */
export class PackageManagerSpec extends Schema.Class<PackageManagerSpec>("PackageManagerSpec")({
	name: PackageManagerName,
	version: AbsoluteVersion,
	onFail: Schema.optionalKey(OnFail),
}) {}

/**
 * The fully-decoded `devEngines` configuration: one package manager and at
 * least one runtime.
 */
export class RuntimeConfig extends Schema.Class<RuntimeConfig>("RuntimeConfig")({
	packageManager: PackageManagerSpec,
	runtimes: Schema.NonEmptyArray(RuntimeSpec),
}) {}

/**
 * Raised when `package.json` is missing, is not valid JSON, or its `devEngines`
 * field is missing or malformed.
 *
 * @remarks
 * Three reasons, one per failure stage. Every schema rejection — an absent
 * `devEngines`, an unsupported name, a semver range where an absolute version
 * belongs — collapses into `invalid-dev-engines` with the parse issue carried
 * as `cause`, matching v1's single message. Finer-grained reasons can be added
 * later without breaking consumers that match on these.
 */
export class ConfigError extends Data.TaggedError("ConfigError")<{
	readonly reason: "missing-package-json" | "malformed-json" | "invalid-dev-engines";
	readonly message: string;
	readonly cause?: unknown;
}> {}
