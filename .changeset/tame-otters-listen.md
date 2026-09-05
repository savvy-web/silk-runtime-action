---
"@savvy-web/silk-runtime-action": patch
---

## Bug Fixes

* `installBats` now refuses to provision when the resolved library root is relative, instead of silently installing into the checkout. With `$HOME` unset (a container entrypoint, `env -i`, a self-hosted runner service account), the library root previously resolved to the relative `.local/share`, `BATS_LIB_PATH` was exported as that relative path, and every `bats_load_library` in the consuming repository failed with nothing in the log naming the cause. The default now falls back to `os.homedir()`, and the resolved path is checked absolute before any files move — a failure now names the missing `$HOME` up front.
* `installBats` now copies each helper library with `overwrite` enabled. Previously, a warm `~/.local/share` — for example a second invocation of this action in one job — made the copy refuse on the existing tree, and bats was not provisioned at all.
* `main.ts` now guards its entry point with the same `if (process.env.GITHUB_ACTIONS)` check `post.ts` already used, so importing the module no longer triggers module-level execution of the action.
* Fixed the fixture test workflow watching `changesets-release/main` — a typo — instead of the actual branch changesets creates, `changeset-release/main`, so the test matrix now runs on release PRs as intended.
