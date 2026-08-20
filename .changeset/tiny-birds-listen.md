---
"@savvy-web/silk-runtime-action": minor
---

## Features

Added auto-detected support for the BATS bash-testing toolchain and kcov coverage.

- New inputs `bats` and `kcov` (`auto | true | false`, default `auto`). `bats: auto`
  installs when the repo shows bash testing — any `**/*.bats` file, or a `vitest-bats`
  dependency in the root manifest. `kcov: auto` follows the bats decision.
- Provisions bats-core `1.14.0` into the tool cache, and `bats-support` `0.3.0`,
  `bats-assert` `2.2.4`, `bats-file` `0.4.0` and `bats-mock` `1.2.5` into
  `$HOME/.local/share` — one location that satisfies both `bats_load_library` and
  `vitest-bats`'s own directory scan, with no `sudo` required.
- Builds kcov `43` from source and caches it under its own Actions cache entry with a
  restore-key ladder, verifying a restored binary before trusting it and rebuilding when
  that probe fails.
- Exports `BATS_LIB_PATH`, `BATS_PATH` and `KCOV_PATH`, and adds six new outputs:
  `bats-enabled`, `bats-version`, `bats-lib-path`, `kcov-enabled`, `kcov-version` and
  `kcov-cache-hit`.
- Every failure degrades to a warning and a `false` enabled-output — neither install can
  fail the job.
- Windows is not supported for this toolchain: the kcov descriptor refuses `win32`, and
  the bats install path is validated on Linux and macOS only.
