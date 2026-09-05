/**
 * Main action entry point.
 *
 * Thin wrapper around `Action.run`. `MainLive` adds the two services the
 * default runtime deliberately omits.
 *
 * The `GITHUB_ACTIONS` guard is the same idiom `post.ts` uses — one idiom on
 * every entry, not one for main and another for post — so importing this module
 * never executes the action. `vitest.setup.ts` strips `GITHUB_ACTIONS` from the
 * test process, which is what keeps the guard honest when the suite itself runs
 * on a runner.
 *
 * @module main
 */

import { Action } from "@effected/github-actions";
import { MainLive } from "./layers/app.js";
import { program } from "./program.js";

/* v8 ignore next 3 -- entry-point guard, only runs in GitHub Actions */
if (process.env.GITHUB_ACTIONS) {
	await Action.run(program, { layer: MainLive });
}
