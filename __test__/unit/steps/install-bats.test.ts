import { assert, describe, it } from "@effect/vitest";
import { ScriptedSpawner } from "@effected/commands";
import { ActionLogger, ActionOutputs, ToolInstaller, ToolInstallerError } from "@effected/github-actions";
import type { MemoryFileSystemSeed } from "@effected/memfs";
import { MemoryFileSystem } from "@effected/memfs";
import { Effect, Layer, Logger, Option, Path, References } from "effect";

import { batsLibraryPlans } from "../../../src/descriptors/bats.js";
import { installBats } from "../../../src/steps/install-bats.js";

const HOME = "/home/runner";
const TOOL = "/opt/hostedtoolcache/bats/1.14.0/x64";

/** Where the stubbed `extractTar` says every archive unpacked to. */
const EXTRACTED = "/tmp/x";

/**
 * The unpacked tarball trees the installer copies from.
 *
 * @remarks
 * Built from `batsLibraryPlans()` rather than spelled out, so a plan whose
 * `archiveSubPath` or `layout` changes moves the fixture with it instead of
 * leaving the suite copying from a path nothing produces.
 *
 * `batsMockShipsLoader` is the whole point of seeding a real volume here. The
 * bats-mock tarball *may* omit `load.bash`, and the installer synthesizes one
 * when it does — so the case is expressed by leaving the file out of the tree,
 * which is what actually happens, rather than by teaching a stubbed `access` to
 * answer "absent" for one path it was told about in advance.
 */
const extractedTrees = (options: { readonly batsMockShipsLoader: boolean }): MemoryFileSystemSeed =>
	Object.fromEntries(
		batsLibraryPlans().flatMap((lib): ReadonlyArray<readonly [string, string]> => {
			const root = `${EXTRACTED}/${lib.archiveSubPath}`;
			return lib.layout === "flat"
				? [
						[`${root}/stub.bash`, "# stub.bash\n"],
						[`${root}/binstub`, "#!/usr/bin/env bash\n"],
						...(options.batsMockShipsLoader ? [[`${root}/load.bash`, "# shipped loader\n"] as const] : []),
					]
				: [
						[`${root}/load.bash`, "# shipped loader\n"],
						[`${root}/src/${lib.name}.bash`, "# src\n"],
					];
		}),
	);

interface Recorded {
	readonly downloaded: Array<string>;
	readonly paths: Array<string>;
	readonly env: Array<readonly [string, string]>;
	readonly written: Array<readonly [path: string, content: string]>;
	readonly logs: Array<string>;
}

const recorder = (): Recorded => ({ downloaded: [], paths: [], env: [], written: [], logs: [] });

/** A jq probe that always reports present, unless a suite overrides the spawner layer. */
const jqPresent = ScriptedSpawner.make(() => ({ stdout: "jq-1.7\n", exit: 0 }));

const makeLayer = (
	r: Recorded,
	overrides: Partial<Parameters<typeof ToolInstaller.layerTest>[0]> = {},
	tree: { readonly batsMockShipsLoader?: boolean } = {},
) =>
	Layer.mergeAll(
		ToolInstaller.layerTest({
			download: (url: string) => {
				r.downloaded.push(url);
				return Effect.succeed(`/tmp/dl/${r.downloaded.length}.tar.gz`);
			},
			extractTar: () => Effect.succeed("/tmp/x"),
			cacheDir: () => Effect.succeed(TOOL),
			...overrides,
		}),
		ActionOutputs.layerTest({
			addPath: (p) => Effect.sync(() => void r.paths.push(p)),
			exportVariable: (n, v) => Effect.sync(() => void r.env.push([n, v])),
		}),
		// A real volume holding the unpacked tarballs, wrapped in a recorder that
		// observes each synthesized loader and then delegates the write to it.
		MemoryFileSystem.layerFaulty({
			writeFileString: (path: string, content: string) => {
				r.written.push([path, content]);
				return undefined;
			},
		}).pipe(
			Layer.provide(
				MemoryFileSystem.layerWith(extractedTrees({ batsMockShipsLoader: tree.batsMockShipsLoader ?? true })),
			),
		),
		Path.layer,
		ActionLogger.layerTest({}),
		Logger.layer([Logger.make(({ message }) => void r.logs.push(String(message)))]),
		Layer.succeed(References.MinimumLogLevel)("Debug"),
		jqPresent.layer,
	);

describe("installBats", () => {
	it.effect("installs nothing when the decision was not to install", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installBats(false, HOME).pipe(Effect.provide(makeLayer(r)));
			assert.strictEqual(Option.isNone(result), true);
			assert.deepStrictEqual(r.downloaded, []);
			assert.deepStrictEqual(r.paths, []);
		}),
	);

	it.effect("downloads bats-core and all four libraries", () =>
		Effect.gen(function* () {
			const r = recorder();
			yield* installBats(true, HOME).pipe(Effect.provide(makeLayer(r)));
			assert.lengthOf(r.downloaded, 5);
			assert.include(r.downloaded[0], "bats-core/archive/refs/tags/v1.14.0");
			assert.strictEqual(
				r.downloaded.some((u) => u.includes("jasonkarns/bats-mock")),
				true,
			);
			// Every seeded tarball ships its own load.bash, so the installer finds
			// one at each destination and synthesizes nothing.
			assert.deepStrictEqual(r.written, []);
		}),
	);

	it.effect("publishes the tool-cache bin directory to PATH", () =>
		Effect.gen(function* () {
			const r = recorder();
			const result = yield* installBats(true, HOME).pipe(Effect.provide(makeLayer(r)));
			assert.deepStrictEqual(r.paths, [`${TOOL}/bin`]);
			assert.strictEqual(Option.isSome(result) && result.value.binDir, `${TOOL}/bin`);
		}),
	);

	it.effect("exports BATS_LIB_PATH at the shared library root, not per library", () =>
		Effect.gen(function* () {
			const r = recorder();
			yield* installBats(true, HOME).pipe(Effect.provide(makeLayer(r)));
			assert.deepInclude(r.env, ["BATS_LIB_PATH", `${HOME}/.local/share`]);
			assert.deepInclude(r.env, ["BATS_PATH", `${TOOL}/bin/bats`]);
		}),
	);

	it.effect("synthesizes a load.bash for bats-mock when the tarball ships none", () =>
		Effect.gen(function* () {
			const r = recorder();
			// The bats-mock tarball ships no load.bash, so none is copied to the
			// destination and the installer has to write one.
			yield* installBats(true, HOME).pipe(Effect.provide(makeLayer(r, {}, { batsMockShipsLoader: false })));
			// The content, not just the path. Asserting only that *a* write happened
			// lets a wrong loader through, and a wrong loader breaks
			// `bats_load_library bats-mock` for every consumer with nothing to show
			// for it. Spelled literally rather than imported from the module under
			// test, which would pass against a mangled constant.
			// biome-ignore lint/suspicious/noTemplateCurlyInString: shell interpolation the installed script evaluates, not a JS template
			const loader = 'source "$(dirname "${BASH_SOURCE[0]}")/stub.bash"\n';
			assert.deepStrictEqual(r.written, [[`${HOME}/.local/share/bats-mock/load.bash`, loader]]);
		}),
	);

	// With `$HOME` unset the old default resolved to the *relative* `.local/share`,
	// so the libraries landed in the checkout and `BATS_LIB_PATH` pointed at a path
	// `bats_load_library` re-resolved against each test's working directory. The
	// failure that produced said nothing about `$HOME`; this one does, before any
	// file moves.
	it.effect("refuses to install under a relative library root", () =>
		Effect.gen(function* () {
			const r = recorder();
			const error = yield* installBats(true, "").pipe(Effect.provide(makeLayer(r)), Effect.flip);
			assert.strictEqual(error._tag, "BatsInstallError");
			assert.strictEqual(error.reason, "install");
			assert.include(error.message, "$HOME");
			// Nothing was downloaded, published or written: the guard runs before
			// the first archive fetch, not after five of them.
			assert.deepStrictEqual(r.downloaded, []);
			assert.deepStrictEqual(r.paths, []);
			assert.deepStrictEqual(r.env, []);
			assert.deepStrictEqual(r.written, []);
		}),
	);

	it.effect("fails typed when a download fails", () =>
		Effect.gen(function* () {
			const r = recorder();
			const error = yield* installBats(true, HOME).pipe(
				Effect.provide(
					makeLayer(r, {
						download: () => Effect.fail(new ToolInstallerError({ reason: "downloadFailed", subject: "bats-core" })),
					}),
				),
				Effect.flip,
			);
			assert.strictEqual(error._tag, "BatsInstallError");
			assert.strictEqual(error.reason, "download");
		}),
	);

	it.effect("warns but does not fail when jq is absent", () =>
		Effect.gen(function* () {
			const r = recorder();
			const jqAbsent = ScriptedSpawner.make((command) => ScriptedSpawner.notFound(command));
			const result = yield* installBats(true, HOME).pipe(Effect.provide(Layer.mergeAll(makeLayer(r), jqAbsent.layer)));
			assert.strictEqual(Option.isSome(result), true);
			assert.strictEqual(
				r.logs.some((line) => line.includes("jq was not found")),
				true,
			);
		}),
	);
});
