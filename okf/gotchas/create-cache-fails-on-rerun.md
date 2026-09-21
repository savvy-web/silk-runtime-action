---
title: Re-running the fixture matrix fails every "create cache" job
description: A second attempt of test.yml reports a cache hit where the first-run job asserts a miss, because the cache-bust key was scoped to run_id and run_id is stable across attempts; run_attempt is now part of the key.
type: Gotcha
status: draft
stale_after: 2027-03-21T00:00:00Z
generated:
  by: okfit/claude-code
  at: 2026-09-21T20:35:07Z
  body_sha256: 5b59297bd0195fb2823dca3f058c4ca200af279fafa51c259067dae296879b2a
resource: ../../.github/workflows/test.yml
sources:
  - id: test-workflow
    resource: ../../.github/workflows/test.yml
  - id: fixtures-guide
    resource: ../../__fixtures__/CLAUDE.md
  - id: pr-417-run
    resource: https://github.com/savvy-web/silk-runtime-action/actions/runs/35647935296
tags:
  - ci
  - caching
  - testing
---

# Re-running the fixture matrix fails every "create cache" job

A reader who re-runs `test.yml` after an unrelated transient failure (a GitHub 502 on a
sibling check, say) sees every `node | <pm> | create cache | <os>` row go red with the same
single assertion:

```text
"cache-hit": {"actual": "true", "expected": "false", "status": "failed"}
```

Every other assertion in the row — runtime version, package manager, Biome, turbo — passes.
The natural conclusion is that the action started saving caches it should not, or that the
PR under test broke cache-key derivation. What is actually true: the action behaved
correctly, and the **test premise** was false. The "create cache" row asserts a miss, but the
per-row `cache-bust` was `${pm}-${os}-${run_id}`, and `github.run_id` is the same across
re-run attempts of one workflow run. Attempt 1 saved an entry under that exact key; attempt 2
restored it.[^test-workflow] Run 35647935296 on PR 417 is the reference instance: attempt 1
was 30/30 green, attempt 2 failed 21 matrix rows on nothing but this check.[^pr-417-run]

## The tell

`run_attempt` on the failing run is greater than 1, and the first attempt's "create cache"
jobs all succeeded. Check with
`gh api repos/<owner>/<repo>/actions/runs/<id> --jq .run_attempt` before reading any job
log; if it says `1`, this gotcha does not apply and the hit is a real regression.

## What now holds

Both matrices key the bust on `${pm}-${os}-${run_id}-${run_attempt}`, the same shape
`test-turbo-cache.yml` already used for its `turbo-cache-prefix`.[^test-workflow] A re-run is
a fresh namespace; "Re-run failed jobs" works as expected.[^fixtures-guide] Runs that
predate the change cannot be re-run cleanly — push a new commit or purge the run-keyed entries
with the `clear-caches` skill instead.

[^test-workflow]: `../../.github/workflows/test.yml`
[^fixtures-guide]: `../../__fixtures__/CLAUDE.md`
[^pr-417-run]: <https://github.com/savvy-web/silk-runtime-action/actions/runs/35647935296>
