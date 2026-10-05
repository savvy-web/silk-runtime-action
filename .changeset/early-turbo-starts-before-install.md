---
"@savvy-web/silk-runtime-action": minor
---

## Features

### Turbo remote cache now reaches dependency-install lifecycle scripts

The "Start turbo remote cache" step now runs immediately before "Install dependencies" instead of last, so `turbo run` calls made by lifecycle scripts during the install (for example `"prepare": "turbo run build:dev"`) use the remote cache instead of running with it disabled. The install child process receives the same `TURBO_API`, `TURBO_TOKEN` and `TURBO_TEAM` variables the step exports for later workflow steps, covering both the embedded server and Vercel passthrough.

The early start applies only when all of these hold:

* a `turbo.json` is detected
* `install-deps` is `true`
* `ignore-scripts` is `false`
* the package manager is not `deno`

Every other run keeps the late start. There are no input, output or `action.yml` changes.

Two visible side effects on runs that start early:

* The "Start turbo remote cache" log group appears before "Install dependencies" rather than at the end.
* The detached embedded server holds the runner's `ACTIONS_RUNTIME_TOKEN` through the install as well, a longer window than the late start.

### No duplicate workspace cache on a branch whose lockfile matches its base

The post step no longer re-saves the workspace cache when the entry it restored differs from this run's key only in the branch digest. Same tool versions, same install policy and same lockfile digest mean the install had nothing to add, so the save only produced a second copy of the same archive: 40–56s and roughly 260 MB of cache quota on the first run of every branch, measured on a 35-package workspace.

* Such a run still reports `cache-hit: partial`, and so does every later run on that branch, because the branch never gets an entry of its own.
* The post step logs `Cache was restored from another branch's entry for the same lockfile (<key>) — skipping save`.
* Turbo's local artifact cache and anything named in `additional-cache-paths` are part of the same archive, so on such a branch they stay at the base branch's snapshot.
* A partial restore from a different lockfile digest is saved exactly as before, and a workspace with no lockfile never skips.
