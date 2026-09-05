/**
 * Global setup: make the test process stop looking like a GitHub Actions runner.
 *
 * @remarks
 * Every entry module (`main.ts`, `post.ts`) ends with the same guard —
 * `if (process.env.GITHUB_ACTIONS) { await Action.run(...) }` — so the program
 * stays importable without executing. That idiom only holds while the *test*
 * process does not itself look like a runner. Under `pnpm ci:test` on GitHub
 * Actions it does: `GITHUB_ACTIONS` is set, so a suite that imports a guarded
 * entry module would run the whole action as an import side effect.
 *
 * The guard is not wrong — the ambient environment is — and this file is where
 * that is fixed, once, for the whole suite. `INPUT_*` and `STATE_*` go with it
 * so a fixture that forgets to seed its own inputs reads nothing rather than
 * silently inheriting the *host* workflow's inputs or saved state.
 *
 * This runs in the main vitest process **before** the fork pool is created, so
 * the stripped environment is what every worker inherits. `__test__/unit/env.test.ts`
 * asserts that from inside a worker, because a setup file that quietly stopped
 * being wired up would otherwise be invisible.
 *
 * @module vitest.setup
 */

/** Environment variables whose presence makes a test process impersonate a runner. */
const STRIPPED_PREFIXES = ["INPUT_", "STATE_"] as const;

export function setup(): void {
	delete process.env.GITHUB_ACTIONS;
	for (const key of Object.keys(process.env)) {
		if (STRIPPED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
			delete process.env[key];
		}
	}
}
