---
"@savvy-web/silk-runtime-action": minor
---

## Features

### Runtime-setup job summary and richer logs

The action now writes a GitHub job-summary panel describing the runtime setup —
a table of runtime(s), package manager, Biome, Turbo cache (backend and mode),
dependency-cache hit, and dependency install status, with a collapsed
"Cache details" section listing the cache key and lockfiles. The summary write
is non-fatal: a failure logs a warning and never fails the action.

Collapsed step lines now surface their outcome inline, so you no longer have to
expand a group to see what happened:

- **Detect configuration** shows the detected runtimes, package manager, Biome,
  and whether Turbo was found.
- **Turbo remote cache** shows the active backend and server readiness
  (e.g. `github · server ready (:41230)`), or `passthrough (Vercel)` / `disabled`.
- **Restore cache** shows `exact hit` / `partial hit` / `miss` with the lockfile
  count.

### Quieter install logs

The action silences noisy chatter from its own install steps — npm update and
funding notices and husky `prepare` output — by setting `NPM_CONFIG_UPDATE_NOTIFIER`,
`NPM_CONFIG_FUND`, `HUSKY`, and `COREPACK_ENABLE_DOWNLOAD_PROMPT` on its own
process only. These are not exported, so they do not affect later steps in your
job (and `HUSKY=0` correctly skips git-hook installation in CI). The package
manager's own install summary is preserved.
