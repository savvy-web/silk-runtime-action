---
"@savvy-web/silk-runtime-action": minor
---

## Features

### Embedded Turborepo remote cache server

When `turbo.json` is detected, the action now auto-starts a local cache server
(bundled as `dist/turbo-server.js`) that persists Turborepo artifacts across
CI runs. Two backends are supported:

- **GitHub Actions cache** (default) — zero-config; uses the existing
  `ACTIONS_CACHE_URL` / `ACTIONS_RUNTIME_TOKEN` environment that the runner
  provides.
- **S3-compatible storage** — activated via the new `turbo-s3-*` inputs;
  uses SigV4 request signing internally (no `aws-sdk` dependency).

When `turbo-token` + `turbo-team` are both set the server acts as a passthrough
to the external Vercel Remote Cache instead of one of the local backends.

**New inputs:**

| Input | Description |
| :--- | :--- |
| `turbo-cache` | Cache mode: `auto` (default) starts the embedded server when `turbo.json` is present; `off` disables. Backend is auto-selected: S3 if `turbo-s3-bucket` is set, otherwise GitHub Actions cache. |
| `turbo-cache-prefix` | Key prefix/namespace for embedded turbo cache artifacts (default: `""`) |
| `turbo-s3-bucket` | S3 bucket name |
| `turbo-s3-region` | AWS region (default: `""`) |
| `turbo-s3-endpoint` | Custom S3-compatible endpoint URL |
| `turbo-s3-access-key-id` | AWS access key ID |
| `turbo-s3-secret-access-key` | AWS secret access key |
| `turbo-s3-session-token` | AWS session token (optional) |
| `turbo-s3-prefix` | S3 key prefix (default: `""`) |

**New outputs:**

| Output | Description |
| :--- | :--- |
| `turbo-cache-backend` | Active backend (`github`, `s3`, `remote`, or `none`) |
| `turbo-cache-port` | Port the local server is listening on |

**Behavior change:** the embedded remote cache server provides artifact-level
caching (faster and more granular than the old whole-`**/.turbo` file cache).
Turbo's local artifact cache (`**/.turbo/cache`) is still file-cached as a fast
local-restore layer, but `**/.turbo/runs` (run summaries) and the other `.turbo`
subdirectories are no longer cached.
