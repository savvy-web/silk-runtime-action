---
"@savvy-web/silk-runtime-action": patch
---

## Bug Fixes

### Lockfile discovery ignores test and fixture directories

Cache-key generation hashes the repository's lockfiles. Lockfile discovery now
excludes test and fixture trees — `__fixtures__/`, `__test__/` (including nested
`fixtures/`), and the Jest `__tests__/` convention — at any depth, in addition
to the existing `node_modules/` and `.git/` exclusions. Repositories that keep
fixture lockfiles (files named like real lockfiles, used by tests) no longer
have those files pollute the dependency cache key, which previously caused
spurious cache invalidation when a fixture changed. Real lockfiles at the
workspace root or in workspace packages are still discovered.
