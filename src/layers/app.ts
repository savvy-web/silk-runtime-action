/**
 * Application layer composition for the main phase.
 *
 * Wires every library and domain service the program needs.
 *
 * @module layers/app
 */

import { NodeFileSystem, NodeHttpClient } from "@effect/platform-node";
import {
	ActionCacheLive,
	ActionEnvironmentLive,
	ActionStateLive,
	CommandRunnerLive,
	GlobLive,
	ToolInstallerLive,
} from "@savvy-web/github-action-effects";
import { Layer } from "effect";

/* v8 ignore start -- pure layer wiring */

export const MainLive = Layer.mergeAll(
	ActionCacheLive.pipe(Layer.provide(NodeHttpClient.layer)),
	ToolInstallerLive,
	CommandRunnerLive,
	ActionStateLive.pipe(Layer.provide(NodeFileSystem.layer)),
	ActionEnvironmentLive,
	GlobLive,
	NodeFileSystem.layer,
);

/* v8 ignore stop */
