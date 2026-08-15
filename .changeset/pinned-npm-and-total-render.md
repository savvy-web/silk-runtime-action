---
"@savvy-web/silk-runtime-action": patch
---

## Bug Fixes

The npm named in `devEngines.packageManager` is now the npm that actually runs the dependency install.

Previously an npm pin could be answered by the runner's own npm when its version matched the pin exactly. That answer carries no directory, so it contributed nothing to the `PATH` this action assembles — and the pinned node's bin directory led instead, meaning the install ran the npm *bundled with* that node rather than the pinned one. When the runner's npm did **not** match, the pin was downloaded and did run. So which npm executed depended on the runner image, while the `package-manager-version` output reported the pinned version either way.

The action now installs the pinned npm unconditionally, so npm behaves like every other tool it provisions. The visible cost is one small download on runs where the runner's npm happened to match.

* No change for `pnpm`, `yarn`, `bun` or `deno` — none of them had an ambient short-circuit
* `package-manager` and `package-manager-version` outputs are unchanged

## Refactoring

* Removed the defensive wrapper around job-summary rendering. `@effected/github-actions` 0.6.1 documents that a `GitHubMarkdown` render cannot fail, so the wrapper only widened the failure it caught. `SummaryError` now carries the single reason `write`.

## Tests

* Added coverage asserting which npm leads the install's `PATH`, the gap that let the behavior above go unnoticed
