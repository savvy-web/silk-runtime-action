---
"@savvy-web/silk-runtime-action": major
---

## Breaking Changes

### The S3 backend is removed

The embedded Turbo cache server no longer stores artifacts in S3. The seven `turbo-s3-*` inputs are gone (`turbo-s3-bucket`, `turbo-s3-region`, `turbo-s3-endpoint`, `turbo-s3-access-key-id`, `turbo-s3-secret-access-key`, `turbo-s3-session-token`, `turbo-s3-prefix`), and the `turbo-cache-backend` output no longer reports `s3`.

A workflow that still passes a `turbo-s3-*` input gets an "unexpected input" warning from the runner and the embedded server on the GitHub Actions cache. To migrate, delete those inputs and either pass `turbo-api` for a hosted cache, as below, or pass nothing and keep the embedded server. The stored S3 keys are no longer read and can be deleted.

What changes for a workflow that used S3 and does not set `turbo-api`:

* Turbo artifacts move to the embedded server on the GitHub Actions cache. They count against the repository's Actions cache quota, which the dependency caches share.
* Actions cache entries are scoped by branch, so a branch reads its own entries and its base branch's. Expect fewer cross-branch hits than a shared bucket gave.

```yaml
permissions:
  contents: read
  id-token: write
steps:
  - uses: savvy-web/silk-runtime-action@v2
    with:
      turbo-api: https://cache.example.com
```

## Features

### Sign in to a hosted Turbo remote cache with the job's OIDC token

The new `turbo-api` input names a hosted Turborepo remote cache. The action requests a GitHub OIDC token for the URL's origin, trades it at `POST <turbo-api>/auth/github`, and exports `TURBO_API`, a masked `TURBO_TOKEN` and `TURBO_TEAM=silk`. No secret is stored: the job needs `id-token: write` and nothing else.

* `turbo-api` has no default and must be an `https` URL.
* When sign-in is not possible (no `id-token: write`, a pull request from a fork on the `pull_request` event, a refusal, a malformed answer, an unreachable service, or more than 10 seconds), the action logs one warning naming the reason and starts the embedded cache server instead. Sign-in never fails a job.
* The fallback is always the embedded server. With `turbo-api` set, `turbo-token` and `turbo-team` are not used, even when sign-in fails.
* Resolution order is `turbo-cache: off`, then `turbo-api`, then `turbo-token` with `turbo-team`, then the embedded server. `off` requests no token and sends no request.
* The `turbo-cache-backend` output gains `hosted`, and the job summary reports `hosted (<host>)`.
