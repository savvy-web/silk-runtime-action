import { describe, expect, it } from "vitest";
import type { S3Inputs, TurboCacheInputs } from "./activation.js";
import { resolveTurboCache } from "./activation.js";

const emptyS3: S3Inputs = {
	bucket: "",
	region: "",
	endpoint: "",
	accessKeyId: "",
	secretAccessKey: "",
	sessionToken: "",
	prefix: "",
};
const base: TurboCacheInputs = { turboDetected: true, cacheMode: "auto", turboToken: "", turboTeam: "", s3: emptyS3 };

describe("resolveTurboCache", () => {
	it("is off when turbo is not detected", () => {
		expect(resolveTurboCache({ ...base, turboDetected: false })).toEqual({ mode: "off" });
	});
	it("is off when cacheMode is off (even with turbo + creds)", () => {
		expect(resolveTurboCache({ ...base, cacheMode: "off", turboToken: "t", turboTeam: "m" })).toEqual({ mode: "off" });
	});
	it("is passthrough when token AND team are present", () => {
		expect(resolveTurboCache({ ...base, turboToken: "t", turboTeam: "m" })).toEqual({
			mode: "passthrough",
			token: "t",
			team: "m",
		});
	});
	it("is embedded s3 when a bucket is present and no external creds", () => {
		const s3: S3Inputs = { ...emptyS3, bucket: "my-bucket", region: "us-east-1" };
		expect(resolveTurboCache({ ...base, s3 })).toEqual({ mode: "embedded", backend: "s3", s3 });
	});
	it("is embedded github by default", () => {
		expect(resolveTurboCache(base)).toEqual({ mode: "embedded", backend: "github" });
	});
	it("prefers passthrough over s3 when both are configured", () => {
		const s3: S3Inputs = { ...emptyS3, bucket: "b" };
		expect(resolveTurboCache({ ...base, turboToken: "t", turboTeam: "m", s3 })).toEqual({
			mode: "passthrough",
			token: "t",
			team: "m",
		});
	});
});
