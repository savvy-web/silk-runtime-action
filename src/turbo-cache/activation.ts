import type { Redacted } from "effect";
import { Option } from "effect";

import type { Inputs } from "../schema/inputs.js";

/**
 * The S3 settings an embedded S3 backend is started with.
 *
 * @remarks
 * `bucket` is a bare string because rule R3 is what produced this value — an
 * S3 resolution exists only when a bucket is set, so an `Option` here would be
 * a `None` no branch can reach. Everything else stays optional, and the two
 * secrets stay `Redacted`: they travel from here into the detached server's
 * environment, and `Secret.forChildEnv` is what unwraps them (oracle 67).
 */
export interface TurboS3Settings {
	readonly bucket: string;
	readonly region: Option.Option<string>;
	readonly endpoint: Option.Option<string>;
	readonly accessKeyId: Option.Option<string>;
	readonly secretAccessKey: Option.Option<Redacted.Redacted<string>>;
	readonly sessionToken: Option.Option<Redacted.Redacted<string>>;
	readonly prefix: Option.Option<string>;
}

/**
 * The resolved turbo cache strategy: the four shapes of oracle 2.
 *
 * @remarks
 * `"remote"` is deliberately absent. It is the *output* vocabulary for
 * `passthrough` (oracle 40, `action.yml`'s `turbo-cache-backend` enum) and the
 * rename happens where the outputs are written, not here — this type is what
 * the action decides, not what it reports.
 */
export type TurboCacheResolution =
	| { readonly mode: "off" }
	| { readonly mode: "passthrough"; readonly token: Redacted.Redacted<string>; readonly team: string }
	| { readonly mode: "embedded"; readonly backend: "github" }
	| { readonly mode: "embedded"; readonly backend: "s3"; readonly s3: TurboS3Settings };

/**
 * Resolves which turbo remote cache — if any — this run should use.
 *
 * @remarks
 * Four sequential first-match rules, verbatim from v1 (oracle 3):
 *
 * 1. turbo undetected, or `turbo-cache: off` → **off**.
 * 2. `turbo-token` **and** `turbo-team` → **passthrough** to Vercel.
 * 3. `turbo-s3-bucket` → **embedded**, S3 backend.
 * 4. otherwise → **embedded**, GitHub Actions cache backend.
 *
 * Order is the behavior: passthrough beats S3 when both are configured (rule 2
 * precedes rule 3), and rule 3 probes the **bucket alone** — S3 credentials
 * without a bucket resolve to the GitHub backend rather than to a
 * misconfigured S3 one.
 *
 * Where v1 read empty strings, this reads `Option.none()`: `ActionInput`'s
 * absence contract makes an unsupplied input and an empty one the same case,
 * so `Option.isSome` is exactly v1's `!== ""` and the table needs no
 * empty-string handling of its own.
 *
 * Partial passthrough credentials — one of token/team — fall through silently
 * (quirk 77). The fallthrough is kept; the ruling adds a *warning*, which
 * belongs to the caller that has a logger. See
 * {@link hasPartialPassthroughCredentials}.
 *
 * Pure: no services, no IO, no logging. Everything downstream of a resolution
 * — spawning, env, outputs — is the step's.
 */
export const resolveTurboCache = (args: {
	readonly turboDetected: boolean;
	readonly inputs: Inputs;
}): TurboCacheResolution => {
	const { turboDetected, inputs } = args;
	if (!turboDetected || inputs.turboCache === "off") return { mode: "off" };
	if (Option.isSome(inputs.turboToken) && Option.isSome(inputs.turboTeam)) {
		return { mode: "passthrough", token: inputs.turboToken.value, team: inputs.turboTeam.value };
	}
	if (Option.isSome(inputs.turboS3Bucket)) {
		return {
			mode: "embedded",
			backend: "s3",
			s3: {
				bucket: inputs.turboS3Bucket.value,
				region: inputs.turboS3Region,
				endpoint: inputs.turboS3Endpoint,
				accessKeyId: inputs.turboS3AccessKeyId,
				secretAccessKey: inputs.turboS3SecretAccessKey,
				sessionToken: inputs.turboS3SessionToken,
				prefix: inputs.turboS3Prefix,
			},
		};
	}
	return { mode: "embedded", backend: "github" };
};

/**
 * Whether exactly one of `turbo-token` / `turbo-team` was supplied.
 *
 * @remarks
 * Ruling 77's seam. Passthrough needs both, and v1 said nothing at all when a
 * workflow set one — the run silently started an embedded server instead of
 * talking to Vercel, which looks identical in the log to a workflow that
 * configured no passthrough. This predicate is pure so the table stays pure;
 * the step calls it and logs the warning.
 */
export const hasPartialPassthroughCredentials = (inputs: Inputs): boolean =>
	Option.isSome(inputs.turboToken) !== Option.isSome(inputs.turboTeam);
