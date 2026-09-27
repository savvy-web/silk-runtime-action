---
"@savvy-web/silk-runtime-action": minor
---

## Features

### pnpm package-manager verification against the lockfile

For pnpm, the action now cross-checks the package manager against
`pnpm-lock.yaml`'s recorded integrity — the `packageManagerDependencies`
entries in the lockfile's env preamble, covering both the wrapper tarball and
the host's `@pnpm/exe.<target>` native binary — instead of relying solely on
the inline `+sha512.<hex>` hash carried on `devEngines.packageManager.version`.

* When both the inline hash and the lockfile's integrity are present, they
  must agree, or the install fails.
* When the lockfile pins a different pnpm version than `devEngines`, it is
  ignored with a warning and verification falls back to the inline hash.
* When the lockfile exists but can't be read, or its preamble can't back its
  own claim, the step fails rather than silently skipping verification.
* When there is no lockfile, or no preamble, behavior is unchanged.

npm, yarn, bun, and deno installs are unaffected. This keeps pnpm
verification working once `silk-update-action` stops writing the inline
`devEngines` hash.
