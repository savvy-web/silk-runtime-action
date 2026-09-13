---
title: Add a runtime
description: The full set of places a new devEngines.runtime value (beyond node, bun, deno) has to be added, derived from the code rather than from prose, since a parity test fails until every one of them agrees.
type: Runbook
status: draft
resource: ../../src/descriptors
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: b95830e940a5ea7d9c3ee082dd5fc8e097b919a85e19940bef0112aca25d7dcc
sources:
  - id: descriptor
    resource: ../../src/descriptors/descriptor.ts
  - id: bun-descriptor
    resource: ../../src/descriptors/bun.ts
  - id: install-runtimes
    resource: ../../src/steps/install-runtimes.ts
  - id: domain-schema
    resource: ../../src/schema/domain.ts
  - id: outputs-schema
    resource: ../../src/schema/outputs.ts
  - id: outputs-test
    resource: ../../__test__/unit/schema/outputs.test.ts
  - id: cache-config
    resource: ../../src/steps/cache-config.ts
  - id: test-workflow
    resource: ../../.github/workflows/test.yml
tags:
  - dx
  - compat
---

# Add a runtime

There is no single "runtime table" this repository maintains — a new `devEngines.runtime`
name (`node`, `bun`, `deno` today) has to be added in several independent places, and a
parity test fails until all of them agree with each other. This runbook lists the steps in
the order they are easiest to do, derived directly from where each name currently appears in
the code, not from a design doc's prose account of them.

## Trigger

A new JavaScript runtime needs `devEngines.runtime` support — a consuming repository wants to
pin a runtime this action does not yet know how to install.

## Steps

1. **Add `src/descriptors/<name>.ts` implementing `RuntimeDescriptor.plan`.** The interface
   is `plan: (version: string, platform: string, arch: string) => Result.Result<RuntimePlan,
   string>` — pure, with the host passed as **arguments** rather than read from `process`
   inside the descriptor, so every platform is exercisable in a unit test without
   monkey-patching the process. An unsupported host is a `Result.fail` carrying the message
   the installer reports, not a thrown exception; `bun.ts` is the reference example, failing
   closed on platforms bun publishes no build for.[^descriptor][^bun-descriptor]
2. **Add the row to `DESCRIPTORS` in `src/steps/install-runtimes.ts`.**
   `const DESCRIPTORS: Record<RuntimeName, RuntimeDescriptor> = { node, bun, deno };` is the
   one dispatch table `installRuntimes` reads by name — grep for `DESCRIPTORS` to find it,
   since it is the single place a new descriptor gets wired in.[^install-runtimes]
3. **Add the literal to the runtime-name schema in `src/schema/domain.ts`.**
   `export const RuntimeName = Schema.Literals(["node", "bun", "deno"]);` is what
   `devEngines.runtime.name` decodes against; a descriptor with no matching literal here can
   never be selected by a consumer's manifest.[^domain-schema]
4. **Add outputs `<name>-version` / `<name>-enabled`** to `action.yml`, `src/schema/outputs.ts`
   (`OUTPUT_NAMES`, currently the 22 names in that const tuple), and the emission list in the
   same file. A parity test asserts `OUTPUT_NAMES` names every `action.yml` output and
   nothing `action.yml` does not declare, and a second test asserts every name in
   `OUTPUT_NAMES` is written exactly once — either will fail until `action.yml`, the schema,
   and the emission call sites all agree.[^outputs-schema][^outputs-test]
5. **Add the manager-activation rule in `src/steps/cache-config.ts` if the runtime is its own
   package manager.** `activePackageManagers` treats `node` as the one runtime whose package
   manager comes from `devEngines.packageManager`; every other runtime activates its own name
   as a manager directly (`active.add(runtime.name === "node" ? config.packageManager.name :
   runtime.name)`) — a runtime that is not its own package manager needs the equivalent
   special case added here, not assumed.[^cache-config]
6. **Add unit tests under `__test__/unit/descriptors/`** covering every platform the new
   descriptor supports, plus at least one unsupported host that must return `Result.fail`.
7. **Add a fixture under `__fixtures__/`** whose `package.json` names the new runtime in
   `devEngines.runtime`, and **a matrix row in `.github/workflows/test.yml`** naming that
   fixture and its `expected-<name>-version` / `expected-<name>-enabled` values, across the
   existing `os` axis (`ubuntu-latest`, `macos-latest`, `windows-latest`).[^test-workflow]
8. **`pnpm build` and commit `dist/`** along with the source change and
   `.github/actions/local/` — the fixture matrix runs the built action, not `src/`.

## End state

The parity tests are green (`OUTPUT_NAMES` against `action.yml`, the emission-coverage test,
and the `RuntimeName` schema decode), and the fixture matrix is green on all three OSes for
the new runtime's row.

See also [`../models/runtime-descriptors.md`](../models/runtime-descriptors.md) for the
`RuntimeDescriptor`/`RuntimePlan` shape step 1 implements,
[`../decisions/descriptors-are-pure-data.md`](../decisions/descriptors-are-pure-data.md) for
why the host is an argument rather than a service, and
[`../conventions/prose-is-parity-surface.md`](../conventions/prose-is-parity-surface.md) for
the parity-test discipline steps 3–4 exist to satisfy.

[^descriptor]: descriptor
[^bun-descriptor]: bun-descriptor
[^install-runtimes]: install-runtimes
[^domain-schema]: domain-schema
[^outputs-schema]: outputs-schema
[^outputs-test]: outputs-test
[^cache-config]: cache-config
[^test-workflow]: test-workflow
