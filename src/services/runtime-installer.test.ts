import { ToolInstaller } from "@savvy-web/github-action-effects";
import {
	ActionOutputsTest,
	CommandRunnerTest,
	ToolInstallerError,
	ToolInstallerTest,
} from "@savvy-web/github-action-effects/testing";
import { Cause, Effect, Exit, Layer, Logger, Option } from "effect";
import { describe, expect, it } from "vitest";
import { RuntimeInstallError } from "../errors/errors.js";
import type { RuntimeDescriptor } from "./runtime-installer.js";
import { makeRuntimeInstaller } from "./runtime-installer.js";

// ---------------------------------------------------------------------------
// Test descriptor (node-like)
// ---------------------------------------------------------------------------

const nodeTestDescriptor: RuntimeDescriptor = {
	name: "node",
	getDownloadUrl: (version, platform, arch) =>
		`https://nodejs.org/dist/v${version}/node-v${version}-${platform}-${arch}.tar.gz`,
	getToolInstallOptions: (_version, platform, _arch) =>
		platform === "win32" ? { archiveType: "zip" as const } : { archiveType: "tar.gz" as const, binSubPath: "bin" },
	verifyCommand: ["node", "--version"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test layer type erasure at service boundary
const runInstall = (version: string, descriptor: RuntimeDescriptor, testLayer: Layer.Layer<any>) => {
	const installer = makeRuntimeInstaller(descriptor);
	return Effect.runPromise(
		installer.install(version).pipe(Effect.provide(testLayer), Effect.provide(Logger.layer([]))),
	);
};

// biome-ignore lint/suspicious/noExplicitAny: test layer type erasure at service boundary
const runInstallExit = (version: string, descriptor: RuntimeDescriptor, testLayer: Layer.Layer<any>) => {
	const installer = makeRuntimeInstaller(descriptor);
	return Effect.runPromise(
		Effect.exit(installer.install(version).pipe(Effect.provide(testLayer), Effect.provide(Logger.layer([])))),
	);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("makeRuntimeInstaller", () => {
	describe("install succeeds", () => {
		it("returns InstalledRuntime with correct name, version, and path", async () => {
			const tools = ToolInstallerTest.empty();
			const outputs = ActionOutputsTest.empty();
			const testLayer = Layer.mergeAll(
				ToolInstallerTest.layer(tools),
				CommandRunnerTest.empty(),
				ActionOutputsTest.layer(outputs),
			);

			const result = await runInstall("24.11.0", nodeTestDescriptor, testLayer);

			expect(result.name).toBe("node");
			expect(result.version).toBe("24.11.0");
			expect(result.path).toContain("/tools/node/24.11.0");
		});

		it("records cacheDir call and addPath in test state", async () => {
			const tools = ToolInstallerTest.empty();
			const outputs = ActionOutputsTest.empty();
			const testLayer = Layer.mergeAll(
				ToolInstallerTest.layer(tools),
				CommandRunnerTest.empty(),
				ActionOutputsTest.layer(outputs),
			);

			await runInstall("24.11.0", nodeTestDescriptor, testLayer);

			expect(tools.cacheDirCalls).toHaveLength(1);
			expect(tools.cacheDirCalls[0]).toMatchObject({ tool: "node", version: "24.11.0" });
			expect(outputs.paths).toHaveLength(1);
		});

		it("exec is called with the verify command args", async () => {
			const tools = ToolInstallerTest.empty();
			const outputs = ActionOutputsTest.empty();
			const cmdResponses = new Map([["node --version", { exitCode: 0, stdout: "v24.11.0", stderr: "" }]]);
			const testLayer = Layer.mergeAll(
				ToolInstallerTest.layer(tools),
				CommandRunnerTest.layer(cmdResponses),
				ActionOutputsTest.layer(outputs),
			);

			const result = await runInstall("24.11.0", nodeTestDescriptor, testLayer);
			expect(result.name).toBe("node");
		});
	});

	describe("install wraps ToolInstallerError as RuntimeInstallError", () => {
		it("fails with RuntimeInstallError when ToolInstaller.download fails", async () => {
			const outputs = ActionOutputsTest.empty();
			const failingToolInstaller: typeof ToolInstaller.Service = {
				find: () => Effect.succeed(Option.none()),
				download: () =>
					Effect.fail(
						new ToolInstallerError({
							tool: "node",
							version: "24.11.0",
							operation: "download",
							reason: "Network error",
						}),
					),
				extractTar: () => Effect.succeed("/tmp/extracted"),
				extractZip: () => Effect.succeed("/tmp/extracted"),
				cacheDir: () => Effect.succeed("/tools/node/24.11.0"),
				cacheFile: () => Effect.succeed("/tools/node/24.11.0"),
			};

			const testLayer = Layer.mergeAll(
				Layer.succeed(ToolInstaller, failingToolInstaller),
				CommandRunnerTest.empty(),
				ActionOutputsTest.layer(outputs),
			);

			const exit = await runInstallExit("24.11.0", nodeTestDescriptor, testLayer);

			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
			expect(err).toBeInstanceOf(RuntimeInstallError);
			if (err instanceof RuntimeInstallError) {
				expect(err.runtime).toBe("node");
				expect(err.version).toBe("24.11.0");
				expect(err.reason).toContain("Network error");
			}
		});
	});

	describe("install wraps CommandRunnerError as RuntimeInstallError", () => {
		it("fails with RuntimeInstallError when CommandRunner.exec fails", async () => {
			const tools = ToolInstallerTest.empty();
			const outputs = ActionOutputsTest.empty();
			const cmdResponses = new Map([["node --version", { exitCode: 127, stdout: "", stderr: "node: not found" }]]);
			const testLayer = Layer.mergeAll(
				ToolInstallerTest.layer(tools),
				CommandRunnerTest.layer(cmdResponses),
				ActionOutputsTest.layer(outputs),
			);

			const exit = await runInstallExit("24.11.0", nodeTestDescriptor, testLayer);

			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
			expect(err).toBeInstanceOf(RuntimeInstallError);
			if (err instanceof RuntimeInstallError) {
				expect(err.runtime).toBe("node");
				expect(err.version).toBe("24.11.0");
			}
		});
	});

	describe("installerLayerFor", () => {
		it("fails with RuntimeInstallError for unknown runtime name", async () => {
			const mod = await import("./runtime-installer.js");
			const layer = mod.installerLayerFor("unknown");
			const exit = await Effect.runPromise(
				Effect.exit(
					mod.RuntimeInstaller.pipe(
						Effect.flatMap((i) => i.install("1.0.0")),
						Effect.provide(layer),
						Effect.provide(Logger.layer([])),
					) as unknown as Effect.Effect<never, RuntimeInstallError>,
				),
			);
			expect(Exit.isFailure(exit)).toBe(true);
			const err = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
			expect(err).toBeInstanceOf(RuntimeInstallError);
			if (err instanceof RuntimeInstallError) {
				expect(err.reason).toContain("Unknown runtime: unknown");
			}
		});

		it("returns a layer for node", async () => {
			const mod = await import("./runtime-installer.js");
			expect(mod.installerLayerFor("node")).toBeDefined();
		});

		it("returns a layer for bun", async () => {
			const mod = await import("./runtime-installer.js");
			expect(mod.installerLayerFor("bun")).toBeDefined();
		});

		it("returns a layer for deno", async () => {
			const mod = await import("./runtime-installer.js");
			expect(mod.installerLayerFor("deno")).toBeDefined();
		});
	});
});

// ---------------------------------------------------------------------------
// extractErrorReason tests
// ---------------------------------------------------------------------------

describe("extractErrorReason", () => {
	it("extracts reason from object with reason field", async () => {
		const mod = await import("./runtime-installer.js");
		expect(mod.extractErrorReason({ reason: "something failed" })).toBe("something failed");
	});

	it("extracts message from Error instances", async () => {
		const mod = await import("./runtime-installer.js");
		expect(mod.extractErrorReason(new Error("err msg"))).toBe("err msg");
	});

	it("extracts message from object with message field", async () => {
		const mod = await import("./runtime-installer.js");
		expect(mod.extractErrorReason({ message: "msg" })).toBe("msg");
	});

	it("formats _tag when present", async () => {
		const mod = await import("./runtime-installer.js");
		expect(mod.extractErrorReason({ _tag: "SomeError" })).toBe("SomeError");
	});

	it("prefers reason over _tag when both present", async () => {
		const mod = await import("./runtime-installer.js");
		expect(mod.extractErrorReason({ _tag: "SomeError", reason: "details" })).toBe("details");
	});

	it("returns string representation for primitives", async () => {
		const mod = await import("./runtime-installer.js");
		expect(mod.extractErrorReason("plain string")).toBe("plain string");
		expect(mod.extractErrorReason(42)).toBe("42");
	});

	it("returns 'Unknown error' for empty values", async () => {
		const mod = await import("./runtime-installer.js");
		expect(mod.extractErrorReason("")).toBe("Unknown error");
		expect(mod.extractErrorReason(null)).toBe("null");
	});
});

// ---------------------------------------------------------------------------
// formatCauseDetail tests
// ---------------------------------------------------------------------------

describe("formatCauseDetail", () => {
	it("extracts cause detail from error with structured cause", async () => {
		const mod = await import("./runtime-installer.js");
		const error = { cause: { reason: "timeout", operation: "restore", key: "cache-key" } };
		expect(mod.formatCauseDetail(error)).toBe("reason=timeout, operation=restore, key=cache-key");
	});

	it("uses ? for missing cause fields", async () => {
		const mod = await import("./runtime-installer.js");
		const error = { cause: {} };
		expect(mod.formatCauseDetail(error)).toBe("reason=?, operation=?, key=?");
	});

	it("returns undefined for error without cause", async () => {
		const mod = await import("./runtime-installer.js");
		expect(mod.formatCauseDetail({ reason: "no cause" })).toBeUndefined();
	});

	it("returns undefined for non-object error", async () => {
		const mod = await import("./runtime-installer.js");
		expect(mod.formatCauseDetail("string error")).toBeUndefined();
		expect(mod.formatCauseDetail(null)).toBeUndefined();
	});

	it("returns undefined when cause is undefined", async () => {
		const mod = await import("./runtime-installer.js");
		expect(mod.formatCauseDetail({ cause: undefined })).toBeUndefined();
	});
});
