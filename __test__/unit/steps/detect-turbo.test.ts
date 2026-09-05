import { assert, describe, it } from "@effect/vitest";
import { MemoryFileSystem } from "@effected/memfs";
import type { FileSystem } from "effect";
import { Effect, Layer, Logger, PlatformError, References } from "effect";

import { detectTurbo } from "../../../src/steps/detect-turbo.js";

/** The one file the step looks for. */
const TURBO_JSON = "turbo.json";

/**
 * A volume seeded with `present`, wrapped in a recorder over `access`.
 *
 * @remarks
 * The volume answers presence, so an absent file fails `NotFound` on its own
 * rather than through a stub deciding what absence looks like. The handler
 * records the probed path and returns `undefined` — delegate — except when a
 * `failure` other than `NotFound` is asked for, which is how the
 * permission-denied case is reached on a volume that has no permissions model.
 *
 * Contents are never seeded as anything but an empty file: the step must not
 * read or parse `turbo.json`, and a step that starts to would find nothing.
 */
const fileSystemTest = (
	present: ReadonlySet<string>,
	accessed: Array<string> = [],
	failure: PlatformError.SystemErrorTag = "NotFound",
): Layer.Layer<FileSystem.FileSystem> =>
	MemoryFileSystem.layerFaulty({
		access: (path) => {
			accessed.push(path);
			return failure === "NotFound"
				? undefined
				: Effect.fail(
						PlatformError.systemError({
							_tag: failure,
							module: "FileSystem",
							method: "access",
							pathOrDescriptor: path,
						}),
					);
		},
	}).pipe(Layer.provide(MemoryFileSystem.layerWith(Object.fromEntries([...present].map((name) => [`/${name}`, ""])))));

describe("detectTurbo", () => {
	it.effect("reports turbo when turbo.json is there", () =>
		Effect.gen(function* () {
			const accessed: Array<string> = [];
			const turbo = yield* detectTurbo.pipe(Effect.provide(fileSystemTest(new Set([TURBO_JSON]), accessed)));

			assert.deepStrictEqual(turbo, { enabled: true });
			// Presence is the whole test (oracle 24): the contents are never read, so
			// an invalid turbo.json still counts.
			assert.deepStrictEqual(accessed, [TURBO_JSON]);
		}),
	);

	it.effect("reports no turbo when turbo.json is absent", () =>
		Effect.gen(function* () {
			const turbo = yield* detectTurbo.pipe(Effect.provide(fileSystemTest(new Set())));
			assert.deepStrictEqual(turbo, { enabled: false });
		}),
	);

	it.effect("reports no turbo when the probe itself fails", () =>
		Effect.gen(function* () {
			// A permission error is not "absent", but there is nothing else this step
			// could answer and nothing a workflow could do with the distinction —
			// v1 collapsed every probe failure to false and so does this.
			const turbo = yield* detectTurbo.pipe(Effect.provide(fileSystemTest(new Set(), [], "PermissionDenied")));
			assert.deepStrictEqual(turbo, { enabled: false });
		}),
	);

	it.effect("does not look for a turbo.jsonc", () =>
		Effect.gen(function* () {
			// v1 had no such fallback and neither does this (oracle 25). A repository
			// that only has turbo.jsonc reports no turbo, which is the parity answer.
			const accessed: Array<string> = [];
			const turbo = yield* detectTurbo.pipe(Effect.provide(fileSystemTest(new Set(["turbo.jsonc"]), accessed)));

			assert.deepStrictEqual(turbo, { enabled: false });
			assert.deepStrictEqual(accessed, [TURBO_JSON]);
		}),
	);

	it.effect("says what it detected", () =>
		Effect.gen(function* () {
			const logs: Array<string> = [];
			const logger = Layer.mergeAll(
				Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))]),
				Layer.succeed(References.MinimumLogLevel)("Debug"),
			);
			yield* detectTurbo.pipe(Effect.provide(Layer.mergeAll(fileSystemTest(new Set([TURBO_JSON])), logger)));

			// v1's line, verbatim (oracle 26).
			assert.include(logs, "Detected Turbo configuration");

			const quiet: Array<string> = [];
			yield* detectTurbo.pipe(
				Effect.provide(
					Layer.mergeAll(
						fileSystemTest(new Set()),
						Logger.layer([Logger.make(({ message }) => void quiet.push(String(message)))]),
						Layer.succeed(References.MinimumLogLevel)("Debug"),
					),
				),
			);
			assert.notInclude(quiet, "Detected Turbo configuration");
		}),
	);
});
