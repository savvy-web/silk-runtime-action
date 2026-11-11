---
type: Limitation
title: The turbo-server worker is exempt from the post-bundle import check because it refuses to load without its token
description: The turbo-server worker exits at import without TURBOGHA_TOKEN, so its own effected.toml table sets importCheck = false; main and post keep the check, and only the worker's load is left to the fixture workflows.
status: draft
bounds: ../modules/silk-runtime-action.md
generated:
  by: okfit/claude-code
  at: 2026-11-11T16:39:59Z
sources:
  - id: effected-toml
    title: "effected.toml [action.entries.workers.turbo-server]"
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
    body: 52069262da68dc89
---

# The turbo-server worker is exempt from the post-bundle import check

## Trigger

`effected action build` runs `importCheck` after bundling: it imports each emitted bundle
in a bare Node process carrying only `HOME` and `TMPDIR`, and fails the build if any of them
does not load. It is on by default for every entry, and a worker given its own
`[action.entries.workers.<name>]` table can turn it off for itself alone.[^effected-toml]

The `turbo-server` worker deliberately refuses to start without its configuration: at import
it reads `TURBOGHA_TOKEN` and the rest of its `TURBOGHA_*` environment, and on failure logs
one line and calls `process.exit(1)`, because a spawn whose environment did not survive would
otherwise leave an unauthenticated cache server listening on the runner.[^turbo-server]

## Symptom

With the check on for the worker, the build fails with `turbo-server does not load:
turbo-server: TURBOGHA_TOKEN is not set` even though the bundle is correct. So
`effected.toml` gives the worker its own table with `importCheck = false`. `main` and `post`
keep the check and load cleanly under it, being `GITHUB_ACTIONS`-guarded.[^effected-toml]

A bundling regression that makes `dist/turbo-server.js` fail at import is therefore caught
by the fixture workflows running the committed `.github/actions/local/` copy, not by the
build.

## Why this is acceptable

The worker's refusal is a security posture worth more than the check, and the fixture
matrices exercise the worker as a real runner spawns it. The cost is a later, slower signal
for an import-time failure in the worker only.

## History

Until `@effected/plugin` 0.5.1, `importCheck` was one switch under `[action.build]` for every
bundle, so the worker's exemption turned the check off for `main` and `post` too. The
per-worker table replaced that global switch, and the check is back on for both lifecycle
bundles.[^owner]

[^effected-toml]: ../../effected.toml
[^turbo-server]: `../../src/turbo-server.ts`
[^owner]: conversation with the repository owner
