/**
 * Main action entry point.
 *
 * Thin wrapper around Action.run that loads the program and its layer.
 *
 * @module main
 */

import { Action } from "@savvy-web/github-action-effects";
import { MainLive } from "./layers/app.js";
import { program } from "./program.js";

/* v8 ignore next -- entry point, only runs when bundled as dist/main.js */
Action.run(program, { layer: MainLive });
