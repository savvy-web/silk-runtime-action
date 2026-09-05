import { assert, describe, it } from "@effect/vitest";

/**
 * The test-process environment contract.
 *
 * @remarks
 * `main.ts` and `post.ts` both end in `if (process.env.GITHUB_ACTIONS) { await
 * Action.run(...) }`, which keeps them importable without executing the action.
 * That only holds while the *test* process does not look like a runner — and
 * under `pnpm ci:test` on GitHub Actions it otherwise would, so a suite that
 * imported either module would run the whole action as an import side effect.
 *
 * `vitest.setup.ts` strips the three families that make a process impersonate a
 * runner. It runs in the main vitest process before the fork pool is created,
 * so what a worker inherits is the stripped environment — and this suite runs
 * *in* a worker, which is the only place that can prove it. A setup file that
 * silently stopped being wired up would otherwise be invisible until a green
 * CI run published something.
 */
describe("the test process", () => {
	it("does not advertise itself as a GitHub Actions runner", () => {
		assert.isUndefined(process.env.GITHUB_ACTIONS);
	});

	it("carries no INPUT_* variables inherited from a host workflow", () => {
		assert.deepStrictEqual(
			Object.keys(process.env).filter((key) => key.startsWith("INPUT_")),
			[],
		);
	});

	it("carries no STATE_* variables inherited from a host workflow", () => {
		assert.deepStrictEqual(
			Object.keys(process.env).filter((key) => key.startsWith("STATE_")),
			[],
		);
	});
});
