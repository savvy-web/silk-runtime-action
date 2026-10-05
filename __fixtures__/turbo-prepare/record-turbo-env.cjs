// Run by the `prepare` script of `packages/app`, which the package manager
// executes during `install`. It records which of turbo's remote-cache variables
// the lifecycle script could see, so a later workflow step can assert on it —
// the install's own output is inside the action's step and cannot be grepped.
//
// Presence only for the two credentials: the values are this run's cache token.
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");

writeFileSync(
	join(__dirname, "turbo-prepare-env.json"),
	JSON.stringify({
		TURBO_API: process.env.TURBO_API ?? "",
		TURBO_TOKEN: Boolean(process.env.TURBO_TOKEN),
		TURBO_TEAM: Boolean(process.env.TURBO_TEAM),
	}),
);
