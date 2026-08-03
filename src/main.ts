/**
 * Main action entry point.
 *
 * Thin wrapper around `Action.run` so tests can import `program` without
 * triggering module-level execution. `MainLive` adds the two services the
 * default runtime deliberately omits.
 *
 * @module main
 */

import { Action } from "@effected/github-actions";
import { MainLive } from "./layers/app.js";
import { program } from "./program.js";

/* v8 ignore next */
Action.run(program, { layer: MainLive });
