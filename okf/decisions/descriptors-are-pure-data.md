---
title: Runtime descriptors are pure, total data — no host reads, no service
description: Why per-tool install plans are pure functions over an explicit host argument instead of a service, and why Biome and kcov are shaped differently from a runtime.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 3f9d680375caa7148ddc038ab7b904c20d559c9704c6ca06170a3e5d3fc95002
sources:
  - id: descriptor
    resource: ../../src/descriptors/descriptor.ts
  - id: install-runtimes
    resource: ../../src/steps/install-runtimes.ts
  - id: install-biome
    resource: ../../src/steps/install-biome.ts
tags:
  - architecture
  - compat
  - dx
---

# Runtime descriptors are pure, total data — no host reads, no service

## Context

Installing Node, Bun, and Deno needs a per-tool, per-platform download URL, archive kind,
and internal layout, and the platform matrix has to be exercisable in a unit test on a
single CI runner.[^descriptor]

## Decision

`RuntimeDescriptor.plan(version, platform, arch)` is a **pure, total** function: the host
arrives as arguments, never as an internal `process.platform` read, and a host a runtime
publishes no build for is a `Result` failure carrying the message the installer reports,
never a thrown exception.[^descriptor] `installRuntimes` and `installBiome` both take a
`host`/parameter that defaults to `currentHost()` — `process.platform` / `process.arch` read
in exactly one place — so a test can pass any host without touching the real
process.[^install-runtimes][^install-biome]

`RuntimePlan` distinguishes two subpath fields that a legacy implementation conflated:
`archiveSubPath`, the archive's own wrapper directory, stripped **before** the tool is
cached; and `binSubPath`, the directory *inside* the cached tool that holds the binary
(node's `bin` on Unix), joined **after** the cache, on hit and miss alike.[^descriptor] Both
are relative segments joined through the `Path` service by the caller, never interpolated
with a literal `/`.[^descriptor]

**Layout-canonical tool caching.** `<RUNNER_TOOL_CACHE>/<tool>/<version>/<arch>` is a
**shared** location — the runner image writes it, and so do `setup-node` and `setup-bun`.
None of them nest the tool inside a wrapper directory such as
`node-v24.11.0-win-x64/`. Caching the wrapper would put a directory there that only this
action knows how to read — and that its **own** hit path could not read either, since a hit
returns the cached root with no extracted archive left to descend into. Stripping the
wrapper pre-cache keeps hit and miss resolving to the same path.[^descriptor]

The runtime install flow in `installOne` follows six steps: plan against the host (a
`Result` failure becomes `unsupported-platform`); `ToolInstaller.find(name, version)`, where
a hit skips the download entirely (unlike a legacy implementation, which re-downloaded every
run); on a miss, download → extract → strip `archiveSubPath` → `cacheDir`; join
`binSubPath` through the `Path` service, never a literal separator; publish the tool
directory with `ActionOutputs.addPath`; and verify by spawning the binary **by absolute
path** with `--version`, checking the exit code.[^install-runtimes]

**Biome is not a runtime descriptor.** Biome ships a bare executable — no archive, no
extraction, no layout fixup — so `BiomePlan` is just the two fields that vary (`url`,
`binary`), which is exactly what `ToolInstaller.provisionFile` takes. The whole install is
one `provisionFile` call: the provisioner owns the cache lookup, the download, the
executable bit, and the cache write, including the **cache-hit short-circuit** a legacy
implementation never had (it re-downloaded Biome every run). What stays in `install-biome.ts`
is host-specific: the asset table, publishing the provisioned directory to `PATH`, and the
error taxonomy. There is **no verify probe** — a runtime is verified because everything
after it runs on it, while Biome is a lint tool a later step either invokes or does not.[^install-biome]

**No local `RuntimeInstaller` service.** A `Record<RuntimeName, RuntimeDescriptor>` lookup
(`DESCRIPTORS` in `install-runtimes.ts`) selects the descriptor for a given runtime name,
with no per-iteration layer swap and no failing-layer edge case for an unknown name — the
schema already makes an unknown runtime name unrepresentable. The descriptors themselves are
kept deliberately stable as the design input for a possible upstream `RuntimeInstaller`
service.[^install-runtimes]

## Alternatives rejected

- **Reading `process.platform` / `process.arch` inside the descriptor or the installer.** A
  legacy implementation did exactly this, and no legacy test ever covered a second platform
  because none could — purity is what makes the platform matrix testable at all.
- **One combined `getDownloadUrl` + `getToolInstallOptions` pair per runtime**, each deriving
  the platform/arch mapping separately. Computing the mapping twice is how the two answers
  can disagree — a legacy Bun descriptor resolved its arch string once per call in each half.
- **A `Context.Service` class per runtime with a per-iteration layer swap**, as a legacy
  implementation used. That whole apparatus existed only to select a descriptor; a plain
  lookup table does the same job with no layer and no failing-layer state to guard against.
- **Sharing `RuntimePlan` for Biome.** Biome has no archive, no extraction, and no layout
  fixup, so reusing the runtime shape would mean adding flags to every runtime descriptor for
  a case none of them have.
- **A verify probe for Biome**, matching the runtime pattern uniformly. Biome is a lint tool
  a later step either invokes or does not; there is nothing analogous to "everything after
  this runs on it" to verify.

## Consequences

Adding a runtime is a data addition — a new descriptor plus a row in `DESCRIPTORS` — with no
new service or layer wiring. Every platform branch in a descriptor is exercisable from a
plain unit test without monkey-patching `process`. The descriptors are treated as a stable
design surface: a future upstream `RuntimeInstaller` in `@effected/github-actions` can
consume them largely as-is, so their shape should not be changed lightly even where a local
convenience would favor it.

[^descriptor]: descriptor
[^install-runtimes]: install-runtimes
[^install-biome]: install-biome
