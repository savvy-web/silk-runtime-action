---
"@savvy-web/silk-runtime-action": patch
---

## Bug Fixes

The action no longer crashes on Windows runners. The committed bundle had a
build-machine absolute path frozen into `@azure/storage-common`'s
`createRequire(import.meta.url)` call (reached via the cache service's
`@azure/storage-blob` dependency). That driveless POSIX `file://` path was
accepted on macOS/Linux but rejected by `createRequire` on Windows, throwing at
module load. Rebuilt with a bundler that keeps `import.meta.url` as a runtime
expression, so the path resolves correctly on every platform.
