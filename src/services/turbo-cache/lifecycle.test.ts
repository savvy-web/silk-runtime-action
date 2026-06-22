import { describe, expect, it } from "vitest";
import type { TurboCacheResolution } from "./activation.js";
import { DEFAULT_TURBO_PORT, buildSpawnSpec, killProcess } from "./lifecycle.js";

describe("buildSpawnSpec", () => {
	it("builds a github-backed spec with the core env", () => {
		const res: TurboCacheResolution = { mode: "embedded", backend: "github" };
		const spec = buildSpawnSpec("/x/dist/turbo-server.js", res, { port: 41230, prefix: "pre/", token: "dummy" });
		expect(spec.args).toEqual(["/x/dist/turbo-server.js"]);
		expect(spec.port).toBe(41230);
		expect(spec.env.TURBOGHA_BACKEND).toBe("github");
		expect(spec.env.TURBOGHA_PORT).toBe("41230");
		expect(spec.env.TURBOGHA_PREFIX).toBe("pre/");
		expect(spec.env.TURBOGHA_TOKEN).toBe("dummy");
		expect(spec.env.TURBOGHA_S3_BUCKET).toBeUndefined();
	});

	it("includes S3 env for an s3-backed spec", () => {
		const res: TurboCacheResolution = {
			mode: "embedded",
			backend: "s3",
			s3: {
				bucket: "b",
				region: "r",
				endpoint: "e",
				accessKeyId: "ak",
				secretAccessKey: "sk",
				sessionToken: "st",
				prefix: "pf",
			},
		};
		const spec = buildSpawnSpec("/x/dist/turbo-server.js", res, { port: 1, prefix: "", token: "d" });
		expect(spec.env.TURBOGHA_BACKEND).toBe("s3");
		expect(spec.env.TURBOGHA_S3_BUCKET).toBe("b");
		expect(spec.env.TURBOGHA_S3_REGION).toBe("r");
		expect(spec.env.TURBOGHA_S3_SECRET_ACCESS_KEY).toBe("sk");
	});
});

describe("killProcess", () => {
	it("sends SIGTERM to the pid", () => {
		const calls: Array<[number, string | undefined]> = [];
		killProcess(123, (pid, signal) => calls.push([pid, signal]));
		expect(calls).toEqual([[123, "SIGTERM"]]);
	});
	it("swallows errors when the process is already gone", () => {
		expect(() =>
			killProcess(999, () => {
				throw Object.assign(new Error("no such process"), { code: "ESRCH" });
			}),
		).not.toThrow();
	});
});

it("exposes the default port", () => {
	expect(DEFAULT_TURBO_PORT).toBe(41230);
});
