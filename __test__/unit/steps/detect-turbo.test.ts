import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Logger, PlatformError, References } from "effect";

import { detectTurbo } from "../../../src/steps/detect-turbo.js";

/** The one file the step looks for. */
const TURBO_JSON = "turbo.json";

/**
 * A `FileSystem` where `present` names the files that exist.
 *
 * @remarks
 * `access` alone is stubbed: the step must never read or parse the file, so a
 * step that does fails here rather than passing on a served body.
 */
const fileSystemTest = (
	present: ReadonlySet<string>,
	accessed: Array<string> = [],
	failure: PlatformError.SystemErrorTag = "NotFound",
): Layer.Layer<FileSystem.FileSystem> =>
	FileSystem.layerNoop({
		access: (path) => {
			accessed.push(path);
			return present.has(path)
				? Effect.void
				: Effect.fail(
						PlatformError.systemError({
							_tag: failure,
							module: "FileSystem",
							method: "access",
							pathOrDescriptor: path,
						}),
					);
		},
	});

describe("detectTurbo", () => {
	it.effect("reports turbo when turbo.json is there", () =>
		Effect.gen(function* () {
			const accessed: Array<string> = [];
			const turbo = yield* detectTurbo.pipe(Effect.provide(fileSystemTest(new Set([TURBO_JSON]), accessed)));

			expect(turbo).toEqual({ enabled: true });
			// Presence is the whole test (oracle 24): the contents are never read, so
			// an invalid turbo.json still counts.
			expect(accessed).toEqual([TURBO_JSON]);
		}),
	);

	it.effect("reports no turbo when turbo.json is absent", () =>
		Effect.gen(function* () {
			const turbo = yield* detectTurbo.pipe(Effect.provide(fileSystemTest(new Set())));
			expect(turbo).toEqual({ enabled: false });
		}),
	);

	it.effect("reports no turbo when the probe itself fails", () =>
		Effect.gen(function* () {
			// A permission error is not "absent", but there is nothing else this step
			// could answer and nothing a workflow could do with the distinction —
			// v1 collapsed every probe failure to false and so does this.
			const turbo = yield* detectTurbo.pipe(Effect.provide(fileSystemTest(new Set(), [], "PermissionDenied")));
			expect(turbo).toEqual({ enabled: false });
		}),
	);

	it.effect("does not look for a turbo.jsonc", () =>
		Effect.gen(function* () {
			// v1 had no such fallback and neither does this (oracle 25). A repository
			// that only has turbo.jsonc reports no turbo, which is the parity answer.
			const accessed: Array<string> = [];
			const turbo = yield* detectTurbo.pipe(Effect.provide(fileSystemTest(new Set(["turbo.jsonc"]), accessed)));

			expect(turbo).toEqual({ enabled: false });
			expect(accessed).toEqual([TURBO_JSON]);
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
			expect(logs).toContain("Detected Turbo configuration");

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
			expect(quiet).not.toContain("Detected Turbo configuration");
		}),
	);
});
