---
"@savvy-web/silk-runtime-action": major
---

## Features

### v2 Library Standardization

Migrates the action's internals to the v2 conventions provided by `@savvy-web/github-action-effects`, aligning service structure, logging, input handling, and caching with the library's current APIs.

The action's `action.yml` inputs and outputs are unchanged with two exceptions noted below.

## Breaking Changes

### `additional-lockfiles` accepts only newline-separated values

The `additional-lockfiles` input previously documented comma-separated support. It now only accepts newline-separated values, matching the `ActionInput.multiline` contract from `@savvy-web/github-action-effects` v2.

**Before:**

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    additional-lockfiles: "custom.lock, another.lock"
```

**After:**

```yaml
- uses: savvy-web/silk-runtime-action@v1
  with:
    additional-lockfiles: |
      custom.lock
      another.lock
```

### Cache keys will invalidate on first deploy

The cache-key hash algorithm changed from a local `fast-glob` + SHA-256 implementation to the library `Glob.hashFiles` hash-of-hashes. Existing CI caches will miss on the first run after upgrading to this version. Subsequent runs populate and hit the new hash format normally. No action is required — caches rebuild automatically.

## Refactoring

Comprehensive internal modernization targeting the v2 library conventions:

- Source reorganized into a canonical layout: `services/`, `errors/`, `schemas/`, `layers/`, `state.ts`
- `main.ts` split into a thin entry point, `program.ts`, and `layers/app.ts`
- Errors migrated to `Schema.TaggedError` with `.message` getters
- `RuntimeInstaller` converted to a `Context.Tag` class
- Logging replaced with `Step.groupStep` / `Step.success` (quiet on success, verbose on failure)
- `src/emoji.ts` removed; log formatting uses `Step.success` and plain strings
- Inputs use `ActionInput.multiline` and `ActionInput.boolean` from the library
- `fast-glob` direct dependency removed; replaced by the library `Glob` service
- `post.ts` reads typed `CacheState` and is wrapped in `Effect.catchAll` + `Effect.catchAllDefect` so post-action failures never fail the workflow

## Tests

- Test suite migrated to library `<Service>Test` test layers from `@savvy-web/github-action-effects/testing`
- Tests relocated alongside source files under the canonical `src/` layout
