---
"@savvy-web/silk-runtime-action": patch
---

## Bug Fixes

Corrects three wrong cells in the default package-manager cache-directory table, which archived directories the manager never writes to. Nothing failed — a wrong cell costs a cold cache rather than a broken run, which is why it survived a release. The table now comes from `@effected/npm`'s `PackageManagerCache`, which cites an authority per row.

* pnpm on macOS now archives `~/Library/pnpm/store` rather than the Linux `~/.local/share/pnpm/store`
* The yarn rows are unscrambled: Classic is `~/Library/Caches/Yarn` on macOS and `~/.cache/yarn` on Linux, Berry is `~/.yarn/berry/cache`. `~/.yarn/cache` was never either one
* bun on Windows now archives `~/.bun/install/cache`, the path bun documents on every platform, rather than a path under `AppData`

A tag push now keys its cache under the tag name. It previously fell through to the branchless bucket every other tag also shared; the cross-branch restore rung means a cold tag still restores what the branch it was cut from saved.

## Refactoring

Adopts the upstream surfaces that replace hand-rolled equivalents, with no change to the cache keys a run produces.

* `GitHubContext.branch` replaces the raw `GITHUB_HEAD_REF`/`GITHUB_REF` fallback chain, and encodes the trap that the runner writes `GITHUB_HEAD_REF` as the empty string on non-pull-request events
* `CacheKey.digest` replaces both hand-rolled `sha256(…).slice(0, 8)` call sites
* `ChildEnv.prependPath` and `ChildEnv.needsShell` replace the local `pathKeyOf`, `childEnv` and `needsShell`. The child's `PATH` is now joined with the target platform's delimiter rather than the host's
* `filenamesFor` from `@effected/lockfiles` supplies the lockfile names; the workspace-config extras (`pnpm-workspace.yaml`, `.pnpmfile.cjs`, `.pnp.cjs`, `.yarn/install-state.gz`) and deno's row stay local

## Dependencies

| Dependency | Type | Action | From | To |
| :--- | :--- | :--- | :--- | :--- |
| @effected/github-actions | dependency | updated | ^0.3.0 | ^0.4.0 |
| @effected/npm | dependency | updated | ^0.7.0 | ^0.8.0 |
| @effected/lockfiles | dependency | updated | ^0.2.3 | ^0.3.0 |
| @effected/package-json | dependency | updated | ^0.7.0 | ^0.7.1 |
| @effected/workspaces | dependency | updated | ^0.9.2 | ^0.9.3 |
| @vitest-agent/plugin | devDependency | updated | ^2.0.10 | ^2.0.11 |
