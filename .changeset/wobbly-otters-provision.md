---
"@savvy-web/silk-runtime-action": patch
---

## Bug Fixes

* Fixed pnpm 12 provisioning: pnpm's npm tarball ships `bin.pnpm` as a shebang-less shell placeholder that a lifecycle script normally replaces with the native binary from `@pnpm/exe.<platform>`. Pinning `devEngines.packageManager` to pnpm 12 or later previously failed during "Install dependencies" with `SyntaxError: Invalid or unexpected token`, since the installer shimmed the placeholder directly instead of resolving the native binary.
* The installer now detects the placeholder layout, downloads the matching `@pnpm/exe.*` tarball from the same registry, verifies it against the packument integrity, overlays the native binary, and shims that instead. A tool-cache entry left over from an older version of this action (still holding the placeholder) is reinstalled automatically.
* pnpm 11 and earlier, npm, yarn, and bun provisioning are unaffected.
