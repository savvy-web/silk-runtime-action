---
title: Action contract — inputs, outputs, and exported environment
description: The inputs, outputs, and exported environment a consuming workflow can rely on.
status: draft
type: Interface
x-okfit-kind: runtime
resource: ../../action.yml
generated:
  by: okfit/claude-code
  at: 2026-11-22T05:18:42Z
sources:
  - id: action-yml
    resource: ../../action.yml
  - id: outputs-schema
    resource: ../../src/schema/outputs.ts
  - id: state-schema
    resource: ../../src/state.ts
  - id: runtime-installation-env
    resource: ../../src/steps/install-bats.ts
  - id: turbo-server-config
    resource: ../../src/turbo-cache/server-config.ts
  - id: outputs-parity-test
    resource: ../../__test__/unit/schema/outputs.test.ts
  - id: inputs-parity-test
    resource: ../../__test__/unit/schema/inputs.test.ts
x-okfit-integrity:
  generated:
    body: 90eae2f77591c8a2
---

# Action contract — inputs, outputs, and exported environment

This is the promise a consuming workflow can rely on: 13 inputs (`action.yml:6-58`), all
optional and auto-detected when omitted; **22 outputs** (`action.yml:59-105`), published in a
fixed order every run; and a small set of environment variables exported for later workflow
steps to read.[^action-yml]

## Inputs

Every input is optional. There are no runtime or package-manager version inputs at all —
`devEngines` in `package.json` is the only source of versions (see
[dev-engines-manifest](./dev-engines-manifest.md)). `cache-bust` (default `"false"`) exists
for testing only and should not be wired into normal workflow logic.[^action-yml]

`turbo-api` names a hosted Turborepo remote cache and has **no default**: the action is
public and the URL is the caller's. It must be an `https` URL, and the job needs the
`id-token: write` permission for the sign-in to succeed. When it cannot, the action logs one
warning and uses the embedded server; `turbo-api` never fails a job. It takes precedence
over `turbo-token` and `turbo-team`, and `turbo-cache: off` takes precedence over all of
them. There are no `turbo-s3-*` inputs: a workflow that still passes one gets the runner's
"unexpected input" warning and the embedded server.[^action-yml] `turbo-api` and the removal
are on an unreleased branch as of 2026-11-22; the released 1.x action still has the S3
inputs and no `turbo-api`.

## Outputs

`emitOutputs` publishes all 22 outputs in one fixed declaration order, rendering booleans with
`String(v)`.[^outputs-schema] The order and the name set are both parity surface: a test reads
`action.yml` itself and asserts the code names every output `action.yml` declares, nothing
`action.yml` does not declare, and in the same order it declares them.[^outputs-parity-test]
The same discipline covers inputs, on the other side of the boundary — a test reads
`action.yml` and asserts the code's `INPUT_NAMES` matches it exactly.[^inputs-parity-test]

`dependenciesInstalled` (surfaced through the `cache-hit`/install path, not a literal output
name) is **truthful**: it is true only when a dependency-install command actually ran and
succeeded, never an echo of the `install-deps` input. A consumer must not read `install-deps:
true` as proof that dependencies landed — deno's install is always skipped regardless of the
input, and a truthful flag is what tells a reader that.

`turbo-cache-backend` is one of `github` (the embedded server on the GitHub Actions cache),
`hosted` (signed in to `turbo-api`), `remote` (Vercel passthrough) and `none`.
`turbo-cache-port` is the embedded server's port and is empty for every other
backend.[^action-yml][^outputs-schema]

A consumer relying on `bats-enabled` or `kcov-enabled` must read them as **install success**,
not detection success — the same posture `biome-enabled` already documents: an install that
could not be fetched degrades to a warning and reports disabled, even when the auto-detection
that asked for it fired correctly.

## Exported environment

Three variables are exported for a later workflow step to read directly, independent of the
outputs:

| Variable | Value |
| --- | --- |
| `BATS_LIB_PATH` | `$HOME/.local/share` |
| `BATS_PATH` | Absolute path to the `bats` executable |
| `KCOV_PATH` | Absolute path to the `kcov` executable |

`BATS_LIB_PATH` is the load-bearing one: it is what makes `bats_load_library bats-support`
resolve in a plain `.bats` file, because `$HOME/.local/share` is the one location both
`bats_load_library` (which reads `BATS_LIB_PATH`) and `vitest-bats`'s own fixed-directory scan
(which never reads that variable) can find. `BATS_PATH` and `KCOV_PATH` exist so a consumer
that spawns the binary directly does not have to re-derive the tool-cache layout by shelling
out to `command -v`.

For the turbo cache, the exported set follows the resolved backend rather than being
constant:

| Resolution | Exported environment |
| --- | --- |
| off | none |
| passthrough | `TURBO_TOKEN`, `TURBO_TEAM` |
| embedded, ready | `TURBO_API`, `TURBO_TOKEN`, `TURBO_TEAM` |
| embedded, not ready | none |
| hosted, signed in | `TURBO_API` (the service's URL), `TURBO_TOKEN`, `TURBO_TEAM=silk` |
| hosted, not signed in | as the two embedded rows |

Passthrough deliberately exports no `TURBO_API`: turbo's own default is Vercel's endpoint,
and naming a URL here would pin one this action does not own. A consumer must not assume
`TURBO_API` is always set whenever turbo caching is active, and must not read a loopback
`TURBO_API` as the only alternative to none: an embedded run exports
`http://127.0.0.1:<port>` and a hosted run exports the service's own URL.
`turbo-cache-backend` is the output that says which.

## Stability contract

A consuming workflow may rely on: the input names and defaults never changing meaning within
a major version; the output name set, order, and truthiness semantics above; and the three
exported environment variables' names and values. `action.yml`↔code parity is enforced by
tests under `__test__/unit/schema/`, so a name drifting out of sync with the code is a build
failure here, not a silent consumer break.[^outputs-parity-test][^inputs-parity-test]

[^action-yml]: action-yml
[^outputs-schema]: outputs-schema
[^outputs-parity-test]: outputs-parity-test
[^inputs-parity-test]: inputs-parity-test
