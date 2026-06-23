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
| `turbo-cache` | Backend to use: `"github"` (default) or `"s3"` |
| `turbo-cache-prefix` | Cache key prefix (default: `"turbo"`) |
| `turbo-s3-bucket` | S3 bucket name |
| `turbo-s3-region` | AWS region (default: `"us-east-1"`) |
| `turbo-s3-endpoint` | Custom S3-compatible endpoint URL |
| `turbo-s3-access-key-id` | AWS access key ID |
| `turbo-s3-secret-access-key` | AWS secret access key |
| `turbo-s3-session-token` | AWS session token (optional) |
| `turbo-s3-prefix` | S3 key prefix (default: `"turbo"`) |

**New outputs:**

| Output | Description |
| :--- | :--- |
| `turbo-cache-backend` | Active backend (`"github"`, `"s3"`, or `"vercel"`) |
| `turbo-cache-port` | Port the local server is listening on |

**Behavior change:** `**/.turbo` is no longer included in the file-level
dependency cache. The embedded remote cache server replaces that mechanism with
artifact-level caching that is faster and more granular.
