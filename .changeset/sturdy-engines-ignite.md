---
"@savvy-web/silk-runtime-action": minor
---

## Features

Rebuilt the action's internals on the `@effected/*` Effect v4 suite (`github-actions` 0.3.0, `npm` 0.7.0, `package-json` 0.7.0, `semver` 0.3.0), replacing `@savvy-web/github-action-effects`. The public interface is unchanged — same inputs, outputs, and `devEngines` contract, and the same job summary and log output. Consuming repos require no changes.

### Package managers provisioned without Corepack

Package managers are now installed directly into the tool cache. Corepack has been removed from the install path and is no longer required in consuming repos.

### Hardened dependency cache key

The dependency cache key now includes a CPU-architecture segment, and a partial cache hit falls back through a hardened two-rung restore ladder.

### Turbo remote-cache server hardening

The embedded Turbo remote-cache server is more resilient:

* A per-run random auth token fails closed instead of accepting unauthenticated requests
* `SIGTERM` triggers a graceful teardown so in-flight artifact writes are not lost
* `EADDRINUSE` on the chosen port is handled instead of crashing the job

### Runtimes visible to lifecycle scripts

Lifecycle scripts such as `postinstall` now see the installed runtimes and package manager on `PATH`. This fixes failures in consuming repos whose `postinstall` invokes `bun` or `deno`.

## Bug Fixes

* Windows package manager shims are now invoked safely, mitigating CVE-2024-27980
