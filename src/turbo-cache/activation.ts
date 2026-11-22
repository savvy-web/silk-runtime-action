import type { Redacted } from "effect";
import { Option } from "effect";

import type { Inputs } from "../schema/inputs.js";

/**
 * The resolved turbo cache strategy: one shape per row of the decision table.
 *
 * @remarks
 * `"remote"` is deliberately absent. It is the *output* vocabulary for
 * `passthrough` (oracle 40, `action.yml`'s `turbo-cache-backend` enum) and the
 * rename happens where the outputs are written, not here — this type is what
 * the action decides, not what it reports.
 *
 * `hosted` carries the `turbo-api` input **verbatim**. Whether that string is a
 * usable https URL is sign-in's question, because the answer to a bad one is a
 * warning and the embedded server, and this table has no logger and no
 * fallback to give.
 */
export type TurboCacheResolution =
	| { readonly mode: "off" }
	| { readonly mode: "hosted"; readonly api: string }
	| { readonly mode: "passthrough"; readonly token: Redacted.Redacted<string>; readonly team: string }
	| { readonly mode: "embedded" };

/**
 * Resolves which turbo remote cache — if any — this run should use.
 *
 * @remarks
 * Four sequential first-match rules:
 *
 * 1. turbo undetected, or `turbo-cache: off` → **off**.
 * 2. `turbo-api` → **hosted**: sign in to that service, and fall back to the
 *    embedded server when sign-in is not possible.
 * 3. `turbo-token` **and** `turbo-team` → **passthrough** to Vercel.
 * 4. otherwise → **embedded**, on the GitHub Actions cache.
 *
 * Order is the behavior. Rule 1 comes first so that `off` is absolute: a
 * shared workflow turns the cache off for a fork's code, and nothing else a
 * caller passes may mint a token or send a request after that. Rule 2 precedes
 * rule 3 because a workflow that names a hosted service means it, whatever
 * Vercel credentials an organization also happens to publish.
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
 * — signing in, spawning, env, outputs — is the step's.
 */
export const resolveTurboCache = (args: {
	readonly turboDetected: boolean;
	readonly inputs: Inputs;
}): TurboCacheResolution => {
	const { turboDetected, inputs } = args;
	if (!turboDetected || inputs.turboCache === "off") return { mode: "off" };
	if (Option.isSome(inputs.turboApi)) return { mode: "hosted", api: inputs.turboApi.value };
	if (Option.isSome(inputs.turboToken) && Option.isSome(inputs.turboTeam)) {
		return { mode: "passthrough", token: inputs.turboToken.value, team: inputs.turboTeam.value };
	}
	return { mode: "embedded" };
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
