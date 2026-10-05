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

### Turbo remote cache activity in the workflow log

The embedded cache server previously logged nothing per request, and its log file stayed in the runner's temp directory where nobody could read it. A job whose Turbo tasks all missed and a job whose Turbo never reached the server looked the same.

* The server now writes one line per artifact request: method, task hash, HTTP status, outcome (`hit`, `miss`, `stored`, `exists`, `absent`, `unauthorized`, `error`), artifact size and elapsed time. It also logs the address, backend and prefix it is listening with.
* The post step prints that log in a collapsed `Turbo remote cache activity` group, headed by the totals, for example `Turbo remote cache (github, port 41230): 34 hits, 1 miss, 1 upload, 0 errors`. Only the last 1000 lines are printed; the totals cover the whole log.
* The group appears whenever a server was spawned, including one that never became ready, so the reason for a failed start is in the workflow log.
* The main step logs when the cache was started ahead of the dependency install, and the install logs the names of the `TURBO_*` variables it was handed. Values are never printed.
