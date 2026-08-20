import { ActionInput } from "@effected/github-actions";
import type { Redacted } from "effect";
import { Config, Option } from "effect";

import type { ToolMode } from "./domain.js";

/**
 * The 18 `action.yml` input names, verbatim, as a const tuple.
 *
 * @remarks
 * The counterpart to `OUTPUT_NAMES`. It is what makes "the code and
 * `action.yml` declare the same inputs" a test rather than a convention — the
 * suite reads `action.yml` and records what {@link loadInputs} actually asks
 * the config provider for, and both must equal this list.
 */
export const INPUT_NAMES = [
	"biome-version",
	"turbo-cache",
	"turbo-cache-prefix",
	"turbo-token",
	"turbo-team",
	"turbo-s3-bucket",
	"turbo-s3-region",
	"turbo-s3-endpoint",
	"turbo-s3-access-key-id",
	"turbo-s3-secret-access-key",
	"turbo-s3-session-token",
	"turbo-s3-prefix",
	"install-deps",
	"bats",
	"kcov",
	"cache-bust",
	"additional-lockfiles",
	"additional-cache-paths",
] as const;

/**
 * A single `action.yml` input name.
 */
export type InputName = (typeof INPUT_NAMES)[number];

/**
 * Normalized `turbo-cache` mode. Any value other than the literal `"off"`
 * (including absence, which defaults per `action.yml`) normalizes to `"auto"`.
 */
export type TurboCacheMode = "auto" | "off";

/**
 * The fully decoded, typed shape of all 18 `action.yml` inputs.
 */
export interface Inputs {
	readonly biomeVersion: Option.Option<string>;
	readonly turboCache: TurboCacheMode;
	readonly turboCachePrefix: string;
	readonly turboToken: Option.Option<Redacted.Redacted<string>>;
	readonly turboTeam: Option.Option<string>;
	readonly turboS3Bucket: Option.Option<string>;
	readonly turboS3Region: Option.Option<string>;
	readonly turboS3Endpoint: Option.Option<string>;
	readonly turboS3AccessKeyId: Option.Option<string>;
	readonly turboS3SecretAccessKey: Option.Option<Redacted.Redacted<string>>;
	readonly turboS3SessionToken: Option.Option<Redacted.Redacted<string>>;
	readonly turboS3Prefix: Option.Option<string>;
	readonly installDeps: boolean;
	readonly bats: ToolMode;
	readonly kcov: ToolMode;
	readonly cacheBust: Option.Option<string>;
	readonly additionalLockfiles: ReadonlyArray<string>;
	readonly additionalCachePaths: ReadonlyArray<string>;
}

/**
 * Decodes all 18 `action.yml` inputs into a typed {@link Inputs} value, via
 * `ActionInput` accessors so `INPUT_` mangling and empty-string-is-absent
 * semantics stay owned by `@effected/github-actions`, not reimplemented here.
 */
export const loadInputs: Config.Config<Inputs> = Config.all({
	biomeVersion: Config.option(ActionInput.string("biome-version")),
	turboCache: ActionInput.string("turbo-cache").pipe(Config.withDefault("auto")),
	turboCachePrefix: ActionInput.string("turbo-cache-prefix").pipe(Config.withDefault("")),
	turboToken: Config.option(ActionInput.redacted("turbo-token")),
	turboTeam: Config.option(ActionInput.string("turbo-team")),
	turboS3Bucket: Config.option(ActionInput.string("turbo-s3-bucket")),
	turboS3Region: Config.option(ActionInput.string("turbo-s3-region")),
	turboS3Endpoint: Config.option(ActionInput.string("turbo-s3-endpoint")),
	turboS3AccessKeyId: Config.option(ActionInput.string("turbo-s3-access-key-id")),
	turboS3SecretAccessKey: Config.option(ActionInput.redacted("turbo-s3-secret-access-key")),
	turboS3SessionToken: Config.option(ActionInput.redacted("turbo-s3-session-token")),
	turboS3Prefix: Config.option(ActionInput.string("turbo-s3-prefix")),
	installDeps: ActionInput.boolean("install-deps").pipe(Config.withDefault(true)),
	bats: ActionInput.string("bats").pipe(Config.withDefault("auto")),
	kcov: ActionInput.string("kcov").pipe(Config.withDefault("auto")),
	cacheBust: Config.option(ActionInput.string("cache-bust")),
	additionalLockfiles: ActionInput.lines("additional-lockfiles").pipe(Config.withDefault([])),
	additionalCachePaths: ActionInput.lines("additional-cache-paths").pipe(Config.withDefault([])),
}).pipe(
	Config.map((raw) => ({
		...raw,
		turboCache: raw.turboCache === "off" ? ("off" as const) : ("auto" as const),
		bats: toolMode(raw.bats),
		kcov: toolMode(raw.kcov),
		cacheBust: Option.filter(raw.cacheBust, (v) => v !== "false" && v !== ""),
	})),
);

/**
 * Normalizes a three-state tool input.
 *
 * @remarks
 * `"true"` and `"false"` are the only recognized literals; everything else —
 * including absence, `"auto"`, and a typo — is `"auto"`. This mirrors
 * `turbo-cache`'s "any value other than the literal `off` is `auto`" rule, and
 * for the same reason: the safe reading of an input nobody spelled correctly is
 * the auto-detecting one, never a silent force-on or force-off.
 */
const toolMode = (raw: string): ToolMode => (raw === "true" ? "on" : raw === "false" ? "off" : "auto");
