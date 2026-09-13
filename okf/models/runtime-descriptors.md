---
title: Runtime descriptors — the per-tool download plans installs derive from
description: RuntimeDescriptor and RuntimePlan, the per-runtime tables, and the pinned BATS/kcov versions every install reads from.
status: draft
type: DataModel
resource: ../../src/descriptors
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: deb264c46574d6187e655487be224f102d8dabf3138a61f302fd3e79762864e1
sources:
  - id: descriptor
    resource: ../../src/descriptors/descriptor.ts
  - id: node
    resource: ../../src/descriptors/node.ts
  - id: bun
    resource: ../../src/descriptors/bun.ts
  - id: deno
    resource: ../../src/descriptors/deno.ts
  - id: biome
    resource: ../../src/descriptors/biome.ts
  - id: bats
    resource: ../../src/descriptors/bats.ts
  - id: kcov
    resource: ../../src/descriptors/kcov.ts
---

# Runtime descriptors — the per-tool download plans installs derive from

`src/descriptors/` holds one file per tool: pure, total functions that turn a requested
version and a host into a download plan.[^descriptor] Every install step (`install-runtimes.ts`,
`install-biome.ts`, `install-bats.ts`, `install-kcov.ts`) reads its plan from here rather than
computing URLs or archive layouts itself.

## `RuntimeDescriptor` and `RuntimePlan`

```ts
// src/descriptors/descriptor.ts
export interface RuntimePlan {
  readonly url: string;
  readonly archive: "tar.gz" | "zip";
  readonly archiveSubPath?: string;
  readonly binSubPath?: string;
  readonly tarFlags?: ReadonlyArray<string>;
  readonly binary: string;
}

export interface RuntimeDescriptor {
  readonly plan: (version: string, platform: string, arch: string) => Result.Result<RuntimePlan, string>;
}
```

(`descriptor.ts:18-61`)

Descriptors are **pure and total**: the host arrives as arguments, never as a `process.platform`
read inside the function body. A host a runtime publishes no build for is a `Result` failure
carrying the message the installer reports, never a thrown exception — every platform is
exercisable in a unit test without monkey-patching `process`.

`archiveSubPath` and `binSubPath` name two different things, and the distinction fixes a real
defect class:

| Field | When | Applied |
| --- | --- | --- |
| `archiveSubPath` | The archive nests everything in a wrapper directory | Stripped **pre-cache**, so the cached root is canonical |
| `binSubPath` | The binary lives in a subdirectory *of the tool itself* | Joined **after** the cache, on hit and miss alike |

Both subpaths are relative segments, joined by the caller through the `Path` service rather
than interpolated with a literal `/`, which is what makes the joined path correct on every
platform including the one that spells its separator differently.

## Per-runtime descriptors

| Runtime | Source | Archive | Layout notes |
| --- | --- | --- | --- |
| node | `https://nodejs.org/dist/v{v}/node-v{v}-{plat}-{arch}.{ext}` | `tar.gz` (POSIX) / `zip` (win32) | POSIX: `--strip=1` removes the wrapper, `binSubPath: "bin"` (`node.ts:39-45`). Windows: `archiveSubPath` names the wrapper, binary at its root (`node.ts:32-38`). Arch map `x64`/`arm64`/`arm→armv7l`; anything unmapped passes through (`node.ts:14`)[^node] |
| bun | `https://github.com/oven-sh/bun/releases/download/bun-v{v}/{target}.zip` | `zip` | `archiveSubPath` = the target name; the binary sits at that folder's root, so nothing remains to descend into (`bun.ts:18-31`). Windows is **pinned to `x64`** regardless of the runner's architecture — bun publishes no aarch64 Windows build, so an arm64 Windows runner gets the x64 artifact and emulation rather than a 404 (`bun.ts:8-11,21`)[^bun] |
| deno | `https://github.com/denoland/deno/releases/download/v{v}/deno-{target}.zip` | `zip` | Rust target triples in a **closed table** (`deno.ts:9-13`); a host outside it is a `Result` refusal, not a guess (`deno.ts:25`). No wrapper, no `binSubPath` — the cached directory *is* the bin directory[^deno] |
| biome | `https://github.com/biomejs/biome/releases/download/%40biomejs%2Fbiome%40{v}/{asset}` | none (bare executable) | **Not a `RuntimeDescriptor`** — `BiomePlan` is `{ url, binary }` (`biome.ts:12-26`). Six published assets across linux/darwin/win32 × x64/arm64, no musl variant and no freebsd (`biome.ts:36-40`); the cached name is `biome`/`biome.exe`, deliberately not the asset's own `biome-linux-x64` spelling[^biome] |

## Biome is not a `RuntimeDescriptor`

Biome ships a bare executable: no archive, no extraction, no layout fixup. `BiomePlan`'s two
fields — `url` and `binary` — are exactly what `ToolInstaller.provisionFile` takes
(`biome.ts:12-26`). Sharing `RuntimePlan`'s shape would mean adding fields to every runtime
descriptor for a case only Biome has none of.

## The BATS/kcov pinned versions

Both toolchains version by a **pinned constant in the descriptor**, bumped by changeset —
there are no version inputs and no `devEngines` entry for either, because the action's rule is
absolute versions only and a constant is absolute by construction.

| Tool | Version | Source |
| --- | --- | --- |
| bats-core | `1.14.0` | `bats-core/bats-core` (`bats.ts:14`) |
| bats-support | `0.3.0` | `bats-core/bats-support` (`bats.ts:38`) |
| bats-assert | `2.2.4` | `bats-core/bats-assert` (`bats.ts:39`) |
| bats-file | `0.4.0` | `bats-core/bats-file` (`bats.ts:40`) |
| bats-mock | `1.2.5` | `jasonkarns/bats-mock` (`bats.ts:41,80-86`) |
| kcov | `43` | `SimonKagstrom/kcov` (`kcov.ts:21`)[^kcov] |

`bats-mock` is spelled out in the table rather than derived from the uniform `bats-core/<name>`
pattern the other three libraries share (`library`, `bats.ts:89-96`): it comes from
`jasonkarns/bats-mock`, not the `bats-core` org, so deriving its URL the same way the other
three are derived would point at a `bats-core/bats-mock` repository that does not exist.

## `descriptors/bats.ts` takes no host, and the asymmetry is deliberate

Every other descriptor here — node, bun, deno, biome, kcov — takes the host as an argument and
answers with a per-platform asset. `bats.ts` takes nothing (`bats.ts:1-11`). bats-core and all
four helper libraries are **shell scripts**, published as one platform-independent source
tarball each[^bats] — there is no asset table because there is no platform choice to make. A `host`
parameter here would be one no branch ever reads; a reviewer looking for a "missing" platform
matrix on this file should stop at this note rather than add one.

kcov, by contrast, does take a host (`kcov.ts:71-83`): it is compiled from source, and
`buildDeps` differs by platform (`LINUX_BUILD_DEPS`, `DARWIN_BUILD_DEPS`, `kcov.ts:39-58`),
with `win32` refused outright as a `Result` failure — kcov has no Windows build at all
(`kcov.ts:67-74`).

[^descriptor]: descriptor
[^node]: node
[^bun]: bun
[^deno]: deno
[^biome]: biome
[^bats]: bats
[^kcov]: kcov
