/** S3 backend inputs (empty string = unset). */
export interface S3Inputs {
	readonly bucket: string;
	readonly region: string;
	readonly endpoint: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	readonly sessionToken: string;
	readonly prefix: string;
}

/** Raw inputs that drive turbo cache activation. */
export interface TurboCacheInputs {
	readonly turboDetected: boolean;
	readonly cacheMode: "auto" | "off";
	readonly turboToken: string;
	readonly turboTeam: string;
	readonly s3: S3Inputs;
}

/** The resolved turbo cache strategy. */
export type TurboCacheResolution =
	| { readonly mode: "off" }
	| { readonly mode: "passthrough"; readonly token: string; readonly team: string }
	| { readonly mode: "embedded"; readonly backend: "github" }
	| { readonly mode: "embedded"; readonly backend: "s3"; readonly s3: S3Inputs };

/**
 * Smart auto-detect: off when turbo absent or explicitly disabled; passthrough
 * when external Vercel creds are present; otherwise embedded (S3 if a bucket is
 * configured, else GitHub).
 */
export const resolveTurboCache = (i: TurboCacheInputs): TurboCacheResolution => {
	if (!i.turboDetected || i.cacheMode === "off") return { mode: "off" };
	if (i.turboToken !== "" && i.turboTeam !== "") return { mode: "passthrough", token: i.turboToken, team: i.turboTeam };
	if (i.s3.bucket !== "") return { mode: "embedded", backend: "s3", s3: i.s3 };
	return { mode: "embedded", backend: "github" };
};
