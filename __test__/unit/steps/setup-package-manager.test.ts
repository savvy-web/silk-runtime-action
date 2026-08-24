import { describe, expect, it } from "@effect/vitest";
import type { PackageManagerInstallOptions } from "@effected/github-actions";
import {
	ActionLogger,
	ActionOutputs,
	AmbientPackageManager,
	CachedPackageManager,
	PackageManagerInstaller,
	PackageManagerInstallerError,
	RunnerFileUnavailableError,
} from "@effected/github-actions";
import type { PackageManagerPin } from "@effected/npm";
import { Effect, Layer, Logger, Option } from "effect";

import type { PackageManagerName } from "../../../src/schema/domain.js";
import { PackageManagerSpec } from "../../../src/schema/domain.js";
import { PackageManagerError, setupPackageManager } from "../../../src/steps/setup-package-manager.js";

/** A `devEngines.packageManager` entry, spelled as the config loader produces one. */
const specOf = (name: PackageManagerName, version: string) => PackageManagerSpec.make({ name, version });

/** Records what a case's doubles were asked to do, so elision is assertable. */
interface Recorder {
	readonly pins: Array<PackageManagerPin>;
	/** The options each `install` was called with, positionally alongside `pins`. */
	readonly options: Array<PackageManagerInstallOptions | undefined>;
	readonly paths: Array<string>;
	readonly logs: Array<string>;
}

const recorder = (): Recorder => ({ pins: [], options: [], paths: [], logs: [] });

/**
 * A tool-cache answer, overridable field by field.
 *
 * @remarks
 * `source` is a `Schema.tag`, so the discriminant is filled in by `make` rather
 * than passed — constructing the real class is what makes the step's narrowing
 * meaningful here instead of a structural coincidence.
 */
const cached = (overrides: Partial<Omit<CachedPackageManager, "source">> = {}): CachedPackageManager =>
	CachedPackageManager.make({
		name: "pnpm",
		version: "10.20.0",
		directory: "/opt/toolcache/pnpm/10.20.0",
		binDir: "/opt/toolcache/pnpm/10.20.0/.bin",
		bins: { pnpm: "/opt/toolcache/pnpm/10.20.0/bin/pnpm.cjs" },
		...overrides,
	});

/**
 * Every service `setupPackageManager` requires, doubled around a happy-path
 * install.
 *
 * @remarks
 * `bareInstaller` drops the `install` double entirely, so a case that expects
 * the step to install *nothing* fails loudly rather than silently passing —
 * `PackageManagerInstaller.makeTest`'s unstubbed member dies.
 */
const layerFor = (
	log: Recorder,
	options: {
		readonly install?: PackageManagerInstaller["Service"]["install"];
		readonly bareInstaller?: boolean;
		readonly addPath?: ActionOutputs["Service"]["addPath"];
	} = {},
) =>
	Layer.mergeAll(
		PackageManagerInstaller.layerTest(
			options.bareInstaller === true
				? {}
				: {
						install:
							options.install ??
							((pin) =>
								Effect.sync(() => {
									log.pins.push(pin);
									return cached({ name: pin.name, version: pin.version.toString() });
								})),
					},
		),
		ActionOutputs.layerTest({
			addPath:
				options.addPath ??
				((path) =>
					Effect.sync(() => {
						log.paths.push(path);
					})),
		}),
		ActionLogger.layerTest({}),
		Logger.layer([
			Logger.make<unknown, void>(({ message }) => {
				log.logs.push(Array.isArray(message) ? message.map(String).join(" ") : String(message));
			}),
		]),
	);

describe("setupPackageManager", () => {
	it.effect("treats bun as its own package manager and installs nothing", () =>
		Effect.gen(function* () {
			const log = recorder();
			const result = yield* setupPackageManager(specOf("bun", "1.3.3")).pipe(
				// A reached `install` dies: the no-op has to be a genuine no-op.
				Effect.provide(layerFor(log, { bareInstaller: true })),
			);

			expect(result).toEqual({ name: "bun", version: "1.3.3", binDir: Option.none() });
			expect(log.logs).toContain("bun is its own package manager, no additional setup needed");
			expect(log.paths).toEqual([]);
		}),
	);

	it.effect("treats deno as its own package manager and installs nothing", () =>
		Effect.gen(function* () {
			const log = recorder();
			const result = yield* setupPackageManager(specOf("deno", "2.5.6")).pipe(
				Effect.provide(layerFor(log, { bareInstaller: true })),
			);

			expect(result).toEqual({ name: "deno", version: "2.5.6", binDir: Option.none() });
			expect(log.logs).toContain("deno is its own package manager, no additional setup needed");
		}),
	);

	it.effect("does not log the activation step line for a package manager it did not activate", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* setupPackageManager(specOf("bun", "1.3.3")).pipe(Effect.provide(layerFor(log, { bareInstaller: true })));
			// Both halves in one run: the step said what it did, and did not claim
			// an activation that never happened. The positive assertion is what
			// keeps the negative one honest — a step that logged nothing at all
			// would otherwise pass it.
			expect(log.logs).toContain("bun is its own package manager, no additional setup needed");
			expect(log.logs).not.toContain("bun@1.3.3 activated");
		}),
	);

	it.effect("installs the exact pin `devEngines` names", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* setupPackageManager(specOf("pnpm", "10.20.0")).pipe(Effect.provide(layerFor(log)));

			expect(log.pins).toHaveLength(1);
			expect(log.pins[0]?.name).toBe("pnpm");
			expect(log.pins[0]?.version.toString()).toBe("10.20.0");
			expect(log.pins[0]?.integrity).toBeUndefined();
		}),
	);

	it.effect("splits a `devEngines` version's integrity tail into the pin's integrity", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* setupPackageManager(specOf("pnpm", "10.20.0+sha512.deadbeef")).pipe(Effect.provide(layerFor(log)));

			// The pin grammar owns the split: the first `+` begins integrity, so the
			// version never carries it.
			expect(log.pins[0]?.version.toString()).toBe("10.20.0");
			expect(log.pins[0]?.integrity).toBe("sha512.deadbeef");
		}),
	);

	it.effect("publishes a tool-cache install's bin directory to PATH, not its root", () =>
		Effect.gen(function* () {
			const log = recorder();
			const result = yield* setupPackageManager(specOf("pnpm", "10.20.0")).pipe(Effect.provide(layerFor(log)));
			// The shim directory the installer wrote, which is what makes `pnpm`
			// resolvable by name — the entry root holds no executable.
			expect(log.paths).toEqual(["/opt/toolcache/pnpm/10.20.0/.bin"]);
			expect(result.binDir).toStrictEqual(Option.some("/opt/toolcache/pnpm/10.20.0/.bin"));
		}),
	);

	it.effect("publishes bun's own entry directory, which is its binDir", () =>
		Effect.gen(function* () {
			const log = recorder();
			// bun as the *package manager* is the no-op branch, so this exercises the
			// shape rather than the step's bun path: the cached bun binary needs no
			// shim, so the installer reports `binDir === directory`.
			const result = yield* setupPackageManager(specOf("pnpm", "10.20.0")).pipe(
				Effect.provide(
					layerFor(log, {
						install: () =>
							Effect.succeed(
								cached({
									name: "bun",
									version: "1.3.3",
									directory: "/opt/toolcache/bun/1.3.3",
									binDir: "/opt/toolcache/bun/1.3.3",
									bins: { bun: "/opt/toolcache/bun/1.3.3/bun" },
								}),
							),
					}),
				),
			);

			expect(log.paths).toEqual(["/opt/toolcache/bun/1.3.3"]);
			expect(result.binDir).toStrictEqual(Option.some("/opt/toolcache/bun/1.3.3"));
		}),
	);

	it.effect("suppresses the installer's ambient npm probe", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* setupPackageManager(specOf("npm", "11.6.0")).pipe(
				Effect.provide(
					layerFor(log, {
						install: (pin, options) =>
							Effect.sync(() => {
								log.pins.push(pin);
								log.options.push(options);
								return cached({ name: "npm", version: "11.6.0" });
							}),
					}),
				),
			);

			// Issue #220. The probe interrogates the *runner's* npm, before this
			// action's PATH assembly exists — so on a match it answers `ambient` with
			// no directory, and the pinned node's bin directory leads instead,
			// executing the npm bundled with that node rather than the pinned one.
			// Which npm ran was therefore a function of the runner image. `false` is
			// what makes it a function of the manifest.
			expect(log.options[0]?.allowAmbient).toBe(false);
		}),
	);

	it.effect("publishes nothing to PATH for an ambient package manager", () =>
		Effect.gen(function* () {
			const log = recorder();
			// Not reachable through this step any more — `allowAmbient: false` closes
			// the only branch that answers `ambient`. The case stays because the
			// installer's return type still carries the arm, and the step reads it off
			// the discriminant rather than asserting a shape: if the option is ever
			// revisited, the directoryless answer is still handled rather than
			// producing an `addPath(undefined)`.
			const result = yield* setupPackageManager(specOf("npm", "11.6.0")).pipe(
				Effect.provide(
					layerFor(log, {
						install: (pin) =>
							Effect.sync(() => {
								log.pins.push(pin);
								// The runner's own toolchain already had it: the variant
								// carries no directory at all, and the bins are bare names
								// `PATH` already resolves.
								return AmbientPackageManager.make({
									name: "npm",
									version: "11.6.0",
									bins: { npm: "npm", npx: "npx" },
								});
							}),
					}),
				),
			);

			expect(log.paths).toEqual([]);
			// Nothing to prepend downstream either: the manager is already resolvable.
			expect(result.binDir).toStrictEqual(Option.none());
		}),
	);

	it.effect("logs the activation step line as `{pm}@{version}`", () =>
		Effect.gen(function* () {
			const log = recorder();
			yield* setupPackageManager(specOf("pnpm", "10.20.0")).pipe(Effect.provide(layerFor(log)));
			expect(log.logs).toContain("pnpm@10.20.0 activated");
		}),
	);

	it.effect("echoes the requested version, not whatever the installer reports", () =>
		Effect.gen(function* () {
			const log = recorder();
			const result = yield* setupPackageManager(specOf("pnpm", "10.20.0+sha512.deadbeef")).pipe(
				Effect.provide(
					layerFor(log, {
						// The installer answers with the canonical semver, which is not the
						// `devEngines` string. The outputs echo the request (ruling 47).
						install: () => Effect.succeed(cached({ version: "10.20.0" })),
					}),
				),
			);

			expect(result.name).toBe("pnpm");
			expect(result.version).toBe("10.20.0+sha512.deadbeef");
		}),
	);

	it.effect("reports an unparseable pin as an install failure", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				// `AbsoluteVersion` accepts semver build metadata; the pin grammar reads
				// the same tail as integrity and rejects it for not being `<algo>.<hex>`.
				setupPackageManager(specOf("pnpm", "10.20.0+deadbeef")).pipe(
					Effect.provide(layerFor(log, { bareInstaller: true })),
				),
			);

			expect(error._tag).toBe("PackageManagerError");
			expect(error.reason).toBe("install");
			expect(error.message).toBe(
				'Failed to setup pnpm@10.20.0+deadbeef: Invalid package-manager pin "pnpm@10.20.0+deadbeef": integrity must be a corepack <algo>.<hex> hash',
			);
			expect(error.cause).toBeDefined();
		}),
	);

	it.effect("reports a download failure as an install failure", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				setupPackageManager(specOf("pnpm", "10.20.0")).pipe(
					Effect.provide(
						layerFor(log, {
							install: () =>
								Effect.fail(
									new PackageManagerInstallerError({
										reason: "downloadFailed",
										name: "pnpm",
										version: "10.20.0",
										subject: "https://registry.npmjs.org/pnpm/-/pnpm-10.20.0.tgz",
									}),
								),
						}),
					),
				),
			);

			expect(error.reason).toBe("install");
			// The kit error's prose, not its discriminant.
			expect(error.message).toContain("Failed to setup pnpm@10.20.0: ");
			expect(error.message).toContain("https://registry.npmjs.org/pnpm/-/pnpm-10.20.0.tgz");
		}),
	);

	it.effect("reports an integrity mismatch as an install failure", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				setupPackageManager(specOf("pnpm", "10.20.0+sha512.deadbeef")).pipe(
					Effect.provide(
						layerFor(log, {
							install: () =>
								Effect.fail(
									new PackageManagerInstallerError({
										reason: "integrityMismatch",
										name: "pnpm",
										version: "10.20.0",
										expected: "sha512.deadbeef",
										actual: "sha512.cafebabe",
									}),
								),
						}),
					),
				),
			);

			// Nothing was cached, so the manager was never acquired: install, not
			// verify. `verify` is reserved for an artifact that *did* land.
			expect(error.reason).toBe("install");
		}),
	);

	it.effect("reports an unexpected artifact layout as a verify failure", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				setupPackageManager(specOf("yarn", "4.0.0")).pipe(
					Effect.provide(
						layerFor(log, {
							install: () =>
								Effect.fail(
									new PackageManagerInstallerError({
										reason: "layoutUnexpected",
										name: "yarn",
										version: "4.0.0",
										subject: "package.json names no bin",
									}),
								),
						}),
					),
				),
			);

			// The artifact downloaded and extracted; what failed is the check that it
			// is the package manager it claims to be.
			expect(error.reason).toBe("verify");
			expect(error.message).toContain("Failed to setup yarn@4.0.0: ");
		}),
	);

	it.effect("reports a PATH publication failure as an activation failure", () =>
		Effect.gen(function* () {
			const log = recorder();
			const error = yield* Effect.flip(
				setupPackageManager(specOf("pnpm", "10.20.0")).pipe(
					Effect.provide(
						layerFor(log, {
							addPath: () => Effect.fail(new RunnerFileUnavailableError({ file: "GITHUB_PATH" })),
						}),
					),
				),
			);

			expect(error.reason).toBe("activate");
			expect(error.message).toBe(
				'Failed to setup pnpm@10.20.0: Runner file "GITHUB_PATH" is not available; is this running on a GitHub runner?',
			);
		}),
	);

	it("PackageManagerError carries its tag and reason", () => {
		const error = new PackageManagerError({ reason: "activate", message: "activation failed" });
		expect(error._tag).toBe("PackageManagerError");
		expect(error.reason).toBe("activate");
		expect(error.message).toBe("activation failed");
	});
});
