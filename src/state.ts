import { ProcessId } from "@effected/github-actions";
import { Option, Schema } from "effect";

/**
 * Keys used with `ActionState.save`/`get`/`getOptional` to carry state across
 * the `main` → `post` phase boundary. Internal only, not part of this
 * action's parity surface — free to change without notice.
 */
export const STATE_KEYS = {
	cache: "silk-runtime-cache",
	turboServer: "silk-runtime-turbo-server",
	kcovCache: "silk-runtime-kcov",
} as const;

/**
 * Dependency cache state persisted from `main` to `post`.
 *
 * `restoredKey` distinguishes the three `ActionCache` outcomes: `none` is a
 * miss (no cache path matched), `some(primaryKey)` is an exact hit, and
 * `some(otherKey)` is a partial restore from a fallback key — `post` uses
 * this to decide whether a save is still needed. It is
 * `Schema.OptionFromNullOr`, **not** `Schema.Option`: state crosses the phase
 * boundary as `JSON.stringify(encoded)` in `GITHUB_STATE` and comes back as
 * `JSON.parse` of `STATE_<key>`, so every field's *encoded* form has to be
 * JSON. `Schema.Option` encodes to an `Option` instance, which stringifies
 * through `Option.toJSON` to `{"_id":"Option","_tag":"Some",…}` and no longer
 * decodes ("Expected Option") — a save that main reports as successful and
 * post cannot read. `OptionFromNullOr` encodes to `string | null`.
 *
 * `lockfiles` is the resolved file list the key was hashed from. `post` has no
 * use for it; it rides here because it is the restore step's answer to the
 * `lockfiles` output and this is the value that step already returns. The cost
 * is a handful of paths in `GITHUB_STATE` beside the archive paths already
 * there.
 */
export class CacheState extends Schema.Class<CacheState>("CacheState")({
	paths: Schema.Array(Schema.String),
	primaryKey: Schema.String,
	restoredKey: Schema.OptionFromNullOr(Schema.String),
	lockfiles: Schema.Array(Schema.String),
}) {}

/**
 * Whether the restore landed on the key it asked for.
 *
 * @remarks
 * The one comparison both phases turn on — `post` saves unless it is `true`,
 * and `main` publishes `cache-hit` from it — so it lives beside the state
 * rather than being spelled out twice with a chance of drifting.
 */
export const isExactHit = (state: CacheState): boolean =>
	Option.isSome(state.restoredKey) && state.restoredKey.value === state.primaryKey;

/**
 * Embedded turbo remote-cache server state persisted from `main` to `post` so
 * `post` can stop the detached process.
 *
 * `pid` is `ProcessId` rather than a bare `Schema.Number`: the value crosses
 * the phase boundary as text through `GITHUB_STATE`, and a truncated state
 * file, an absent key, or `Number("")` all decode to `0` — `ProcessId`
 * refuses that value rather than letting it reach `DetachedProcess.reap`.
 */
export class TurboServerState extends Schema.Class<TurboServerState>("TurboServerState")({
	pid: ProcessId,
	port: Schema.Number,
	backend: Schema.Literals(["github", "s3"]),
	logFile: Schema.String,
}) {}

/**
 * kcov cache state persisted from `main` to `post`.
 *
 * @remarks
 * Deliberately **not** folded into {@link CacheState}, and given its own
 * {@link STATE_KEYS} entry, because the two are keyed on entirely different
 * things: the dependency cache on lockfile hashes, this one on a pinned tool
 * version plus the runner's `ImageOS` and architecture. Sharing one entry
 * would tie a multi-minute kcov build to the lockfiles and discard it on every
 * dependency bump — and, in the other direction, would keep a stale kcov tree
 * alive across an image change that a dependency bump happens not to notice.
 *
 * `restoredKey` is `Schema.OptionFromNullOr` for exactly the reason spelled
 * out on {@link CacheState}: state crosses the phase boundary as JSON, and
 * `Schema.Option` encodes to a form that does not decode back. `OptionFromNullOr`
 * encodes to `string | null`.
 *
 * `main` writes this only when it actually built kcov — a restored-and-probed
 * tree is already in the cache under this key, so there is nothing for `post`
 * to save.
 */
export class KcovCacheState extends Schema.Class<KcovCacheState>("KcovCacheState")({
	paths: Schema.Array(Schema.String),
	primaryKey: Schema.String,
	restoredKey: Schema.OptionFromNullOr(Schema.String),
}) {}
