/**
 * Cross-phase state schemas.
 *
 * GitHub Actions persists state between phases as `STATE_*` env vars.
 * `ActionState.save/get` encode and decode each value through its Schema.
 *
 * @module state
 */

import { Schema } from "effect";

/**
 * Cache state persisted from main to post.
 *
 * `restored=true` means main got an exact hit and post should skip the save.
 * `restored=false` means a miss or partial restore — post saves the new key.
 */
export class CacheState extends Schema.Class<CacheState>("CacheState")({
	key: Schema.String,
	paths: Schema.Array(Schema.String),
	restored: Schema.Boolean,
}) {}

/**
 * Turbo cache server state persisted from main to post so post can kill it.
 */
export class TurboServerState extends Schema.Class<TurboServerState>("TurboServerState")({
	pid: Schema.Number,
	port: Schema.Number,
	backend: Schema.String,
}) {}

/**
 * Keys used with `ActionState.save/get`.
 */
export const STATE_KEYS = {
	cacheState: "cache-state",
	turboServerState: "turbo-server-state",
} as const;
