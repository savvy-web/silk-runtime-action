---
"@savvy-web/silk-runtime-action": patch
---

## Bug Fixes

### Workspace discovery stays inside the checkout, and single-package repos stop warning

* The dependency-cache step no longer logs `Workspace discovery failed (WorkspaceRootNotFoundError)` for a
  single-package repository (a `package.json` with no `workspaces` field and no `pnpm-workspace.yaml`). The step
  still caches the root `node_modules`, and the notice is now a debug line. Any other discovery failure still warns.
* Workspace discovery now stops at the checkout root. Before this, a checkout nested inside a directory with its
  own `pnpm-workspace.yaml` or `workspaces` manifest (common on self-hosted runners, or with a nested
  `actions/checkout` `path:`) adopted that outer workspace, and its members' `node_modules` paths were
  added to the cache.
