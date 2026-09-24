---
"@savvy-web/silk-runtime-action": patch
---

## Bug Fixes

* Accept pnpm's `download` value for `devEngines.packageManager.onFail` / `devEngines.runtime[].onFail` — previously any value other than `warn`, `error`, or `ignore` failed with "package.json has invalid or missing devEngines field", even for a manager where `download` is valid. `download` on a non-pnpm manager still fails, now naming the offending entries.
* `devEngines` decode errors now include the schema issue and field path (e.g. which `devEngines.runtime[]` entry has an invalid version), instead of a bare, unhelpful message
