---
type: Limitation
title: The post-bundle import check is disabled for every entry because the turbo-server worker refuses to load without its token
description: effected action build's importCheck is a single switch across all bundles, and the turbo-server worker exits at import without TURBOGHA_TOKEN, so the check is off and main and post lose an automated load guard.
status: draft
bounds: ../modules/silk-runtime-action.md
generated:
  by: okfit/claude-code
  at: 2026-11-10T18:06:20Z
sources:
  - id: effected-toml
    title: "effected.toml [action.build]"
    resource: ../../effected.toml
  - id: turbo-server
    resource: ../../src/turbo-server.ts
  - id: owner
    resource: conversation with the repository owner
    author: human:spencer
    last_modified: "2026-11-10T00:00:00Z"
tags:
  - bundle
  - ci
  - dx
integrity:
  generated:
    body: fdf886810e85a3a1
---

# The post-bundle import check is disabled for every entry

## Trigger

`effected action build` can run `importCheck` after bundling: it imports each emitted bundle
in a bare Node process carrying only `HOME` and `TMPDIR`, and fails the build if any of them
does not load. The option is one switch for every entry, workers included.[^effected-toml]

The `turbo-server` worker deliberately refuses to start without its configuration: at import
it reads `TURBOGHA_TOKEN` and the rest of its `TURBOGHA_*` environment, and on failure logs
one line and calls `process.exit(1)`, because a spawn whose environment did not survive would
otherwise leave an unauthenticated cache server listening on the runner.[^turbo-server]

## Symptom

With `importCheck` on, the build fails on `dist/turbo-server.js` even though the bundle is
correct. So `effected.toml` sets `importCheck = false`, and **no bundle** gets the automated
load check — including `main` and `post`, which are `GITHUB_ACTIONS`-guarded and do load
cleanly under it (verified by hand).[^effected-toml][^owner]

A bundling regression that makes `main` or `post` fail at import is therefore caught by the
fixture workflows running the committed `.github/actions/local/` copy, not by the build.

## Why this is acceptable

The worker's refusal is a security posture worth more than the check, and the fixture
matrices exercise every bundle as a real runner loads it. The cost is a later, slower signal
for an import-time failure in `main` or `post`.

## What a fix would take

A per-entry (or workers-only) opt-out in `effected action build`, so `main` and `post` keep
the check while `turbo-server` skips it. An upstream request for that option is being filed
in the effected repository; once it ships, re-enable `importCheck` with the worker
excluded.[^owner]

[^effected-toml]: ../../effected.toml
[^turbo-server]: `../../src/turbo-server.ts`
[^owner]: conversation with the repository owner
