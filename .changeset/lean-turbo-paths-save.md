---
"@savvy-web/silk-runtime-action": patch
---

## Bug Fixes

* Fixed the post step running large monorepos out of memory when saving the dependency cache. The built-in Turbo cache path was the glob `**/.turbo/cache`, which made the cache save read the entire checkout into memory and failed the job with a V8 heap error. The action now caches a literal `.turbo/cache` path for each workspace member (`.turbo/cache` for the root, `<dir>/.turbo/cache` for the others), so nothing is walked.
* The `cache-paths` output now lists these literal `.turbo/cache` paths instead of `**/.turbo/cache`. Workspace members that do not run Turbo are tolerated and simply contribute nothing to the archive.
