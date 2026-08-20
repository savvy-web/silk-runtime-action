---
status: current
module: silk-runtime-action
category: architecture
created: 2026-03-21
updated: 2026-08-20
last-synced: 2026-08-20
completeness: 95
related:
  - ./architecture.md
  - ./effect-service-model.md
  - ./caching-strategy.md
dependencies: []
---

# Runtime installation

Descriptors, the tool-cache layout, `PATH` publication, package-manager provisioning, dependency installation, the Biome binary, and the BATS/kcov toolchain.

## Table of contents

1. [Overview](#overview)
2. [Current state](#current-state)
3. [The BATS toolchain and kcov](#the-bats-toolchain-and-kcov)
4. [The PATH problem](#the-path-problem)
5. [Rationale](#rationale)
6. [Implementation details](#implementation-details)
7. [Related documentation](#related-documentation)

---

## Overview

Installing tools is the action's core work: Node.js, Bun and Deno from official sources, the pinned package manager, the dependency install, and optionally Biome. The design splits *what to install* (pure descriptors) from *how to install* (kit services driven by a step function).

**Key features:**

- `RuntimeDescriptor` — a pure, total `plan(version, platform, arch) -> Result<RuntimePlan, string>`.
- Find-first installs: `ToolInstaller.find` short-circuits a runner that already has the exact version.
- Layout-canonical caching: the archive's wrapper directory is stripped **before** the cache write.
- `PackageManagerInstaller` provisions npm/pnpm/yarn/bun — no corepack, no sudo, no shim cleanup.
- Biome is one `ToolInstaller.provisionFile` call over a bare-executable descriptor.
- The dependency install prepends every directory this run put a binary in to the child's `PATH`.
- bats-core goes into the tool cache; its four helper libraries go to `$HOME/.local/share`, which is the one location that satisfies both consumers.
- kcov is compiled from source on every platform, because no usable prebuilt exists.

**When to load this doc:**

- Adding a runtime or changing a download URL or archive layout.
- Debugging "command not found" during an install or a lifecycle script.
- Touching package-manager provisioning or the Windows launch path.
- Changing where the BATS libraries land, or anything about how kcov is built.

---

## Current state

### `RuntimeDescriptor` and `RuntimePlan`

```ts
// src/descriptors/descriptor.ts
export interface RuntimeDescriptor {
  readonly plan: (version: string, platform: string, arch: string) => Result.Result<RuntimePlan, string>;
}

export interface RuntimePlan {
  readonly url: string;
  readonly archive: "tar.gz" | "zip";
  readonly archiveSubPath?: string;  // wrapper stripped BEFORE the cache write
  readonly binSubPath?: string;      // directory INSIDE the cached tool
  readonly tarFlags?: ReadonlyArray<string>;
  readonly binary: string;           // file name, including the Windows extension
}
```

Descriptors are **pure and total**: the host arrives as arguments, never as a `process.platform` read inside. A host a runtime publishes no build for is a `Result` failure carrying the message the installer reports, not a thrown exception. This replaced legacy's `getDownloadUrl` + `getToolInstallOptions` pair, where both halves derived from the same platform mapping and could disagree (bun's legacy descriptor resolved its arch string once in each).

`archiveSubPath` and `binSubPath` are two different things and the distinction is the fix for a real legacy defect:

| Field | When | Applied |
| --- | --- | --- |
| `archiveSubPath` | The archive nests everything in a wrapper directory | Stripped **pre-cache**, so the cached root is canonical |
| `binSubPath` | The binary lives in a subdirectory *of the tool itself* | Joined **after** the cache, on hit and miss alike |

### Per-runtime descriptors

| Runtime | Source | Archive | Layout notes |
| --- | --- | --- | --- |
| node | `https://nodejs.org/dist/v{v}/node-v{v}-{plat}-{arch}.{ext}` | `tar.gz` (POSIX) / `zip` (win32) | POSIX: `--strip=1` removes the wrapper, `binSubPath: "bin"`. Windows: `archiveSubPath` names the wrapper, binary at its root. Arch map `x64/arm64/arm→armv7l`, anything unmapped passes through |
| bun | `https://github.com/oven-sh/bun/releases/download/bun-v{v}/{target}.zip` | `zip` | `archiveSubPath` = the target name. Windows is pinned to `x64` — bun publishes no aarch64 Windows build, so an arm64 runner gets x64 + emulation rather than a 404 |
| deno | `https://github.com/denoland/deno/releases/download/v{v}/deno-{target}.zip` | `zip` | Rust target triples in a closed table; a host outside it is a refusal. No wrapper, no `binSubPath` — the cached directory *is* the bin directory |
| biome | `https://github.com/biomejs/biome/releases/download/%40biomejs%2Fbiome%40{v}/{asset}` | none (bare executable) | Not a `RuntimeDescriptor` — `BiomePlan` is `{ url, binary }`. Six published assets; the cached name is `biome`/`biome.exe`, deliberately not the asset's own `biome-linux-x64` |

### Runtime install flow (`steps/install-runtimes.ts`)

Sequential over `config.runtimes`, in `devEngines` declaration order, fatal on the first failure. Duplicates are **not** de-duplicated — a manifest naming the same runtime twice installs it twice, matching v1, and the tool-cache hit makes the second pass free.

Per runtime, inside `logger.withBuffer(name, …, { onSuccess: "discard" })`:

1. `descriptor.plan(version, host.platform, host.arch)` — a `Result` failure becomes `reason: "unsupported-platform"`.
2. `ToolInstaller.find(name, version)` — a hit skips the download entirely. **Legacy had no such check and re-downloaded every run.**
3. On a miss: `download(url)` → `extractZip` / `extractTar(archive, { flags })` → strip `archiveSubPath` → `cacheDir(source, name, version)`.
4. `toolPath = binSubPath ? path.join(root, binSubPath) : root`, joined through the `Path` service — not interpolated with a literal `/` as in legacy, which is wrong on the one platform that needs it.
5. `ActionOutputs.addPath(toolPath)`.
6. Verify: spawn `path.join(toolPath, plan.binary) --version` **by absolute path** and check the exit code.

Every stage collapses into one `RuntimeInstallError` carrying the runtime and version in its message, with `classify` reading the kit's `reason` discriminant (`downloadFailed` → `download`, `extractFailed` → `extract`, `cacheFailed` → `cache`) and everything else falling to `verify`.

### Package manager provisioning (`steps/setup-package-manager.ts`)

```text
bun | deno  -> complete no-op ("<name> is its own package manager, no additional setup needed")
otherwise   -> PackageManagerPin.parse(`${name}@${version}`)
               PackageManagerInstaller.install(pin, { allowAmbient: false })
               source === "tool-cache" ? ActionOutputs.addPath(installed.binDir) : (ambient — unreachable, arm kept)
```

The whole corepack apparatus v1 carried is **gone**: no `corepack enable`, no `corepack prepare --activate`, no `sudo npm install -g`, no `~/.npm` chown, no tmpdir cwd to dodge `pnpm-workspace.yaml` hangs, no Node-25 corepack bootstrap, no stale-shim retry. `PackageManagerInstaller` owns all of it. Its npm ambient short-circuit is suppressed here with `allowAmbient: false` (see the PATH section below), so every manager arrives from its exact pin.

The pin string is assembled from `devEngines` and handed to `PackageManagerPin.parse`, which owns the `<name>@<version>[+<integrity>]` grammar — a `devEngines` version may carry an integrity tail (`10.20.0+sha512.…`) and the first `+` always begins integrity, so the split is the pin's to make. `install` runs with default options; `requireIntegrity` stays **off** because in-the-wild pins routinely carry no hash, and the installer already warns when one does not.

The reported name and version are a pure **echo of the request**, never a probe's answer: the `package-manager` and `package-manager-version` outputs are what the caller asked for. `binDir` is the one field that is not an echo — it is where this run actually put the command, and it exists for the dependency install downstream.

Recorded deviations from v1: the error message drops legacy's redundant `Package manager setup failed:` middle clause and its stderr tail, and the group title is `Install <pm>` rather than legacy's "via corepack", which was a lie for bun and deno even before corepack left.

### Dependency install (`steps/install-dependencies.ts`)

| Manager | Lockfile probe | With lockfile | Without |
| --- | --- | --- | --- |
| npm | `package-lock.json` | `npm ci` | `npm install` |
| pnpm | `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` | `pnpm install` |
| yarn | `yarn.lock` | `yarn install --immutable` | `yarn install --no-immutable` |
| bun | `bun.lock`, then `bun.lockb` | `bun install --frozen-lockfile` | `bun install` |
| deno | — | skipped entirely | skipped entirely |

Probes are bare, working-directory-relative names, and any `access` failure reads as absent. yarn is the only manager that adds a flag in the *absent* case; `--no-immutable` explicitly permits a lockfile rewrite in CI, carried over from v1 deliberately.

`install-deps: false` and deno both skip without probing or spawning. The returned `ran` is **truthful** — `true` only when a command actually ran and succeeded — where v1 echoed the raw input and reported deno's skipped install as done. There is no timeout and no retry, and the failure is fatal: `program.ts` deliberately does not catch it.

`stdout` is inherited so the install's transcript streams live; `stderr` is piped, echoed line by line, and the last ten lines ride in the failure message.

### Biome install (`steps/install-biome.ts`)

One call:

```ts
installer.provisionFile({ tool: "biome", version: requested, url: plan.url, binary: plan.binary })
```

The provisioner owns the cache lookup, the download, the executable bit and the cache write — including the **cache-hit short-circuit v1 never had** (v1 re-downloaded Biome every run). What stays here is host-specific: the asset table, publishing `provisioned.binDir` to `PATH`, and the error taxonomy. There is no verify probe, matching v1: a runtime is verified because everything after it runs on it, while Biome is a lint tool a later step either invokes or does not.

`version` is the **resolved** version from `detectBiome`, not the raw input. `Option.none()` is a no-op that touches neither the tool cache nor `PATH`.

---

## The BATS toolchain and kcov

Two optional steps (`install-bats`, `install-kcov`) provision the shell-testing toolchain: bats-core plus `bats-support`, `bats-assert`, `bats-file` and `bats-mock`, and kcov for shell coverage. Versions are **pinned constants in the descriptors**, bumped by changeset — there are no version inputs and no `devEngines` block, because the action's rule is absolute versions only and a constant is absolute by construction.

| Tool | Version | Source |
| --- | --- | --- |
| bats-core | `1.14.0` | `bats-core/bats-core` |
| bats-support | `0.3.0` | `bats-core/bats-support` |
| bats-assert | `2.2.4` | `bats-core/bats-assert` |
| bats-file | `0.4.0` | `bats-core/bats-file` |
| bats-mock | `1.2.5` | `jasonkarns/bats-mock` |
| kcov | `43` | `SimonKagstrom/kcov` |

The action **provisions and exports; it never runs bats or kcov.** That mirrors the Biome and Turbo posture: the consumer's own workflow steps invoke the tooling.

### `descriptors/bats.ts` takes no host, and that asymmetry is deliberate

Every other descriptor here — `node`, `bun`, `deno`, `biome`, `kcov` — takes the host as an argument and answers with a per-platform asset. `bats.ts` takes nothing. bats-core and all four helper libraries are **shell scripts**, published as one platform-independent source tarball each: there is no asset table because there are no assets to choose between. A `host` parameter would be a parameter no branch reads, and a reviewer looking for the "missing" platform matrix should stop here rather than add one.

`bats-mock` is spelled out in the table rather than derived from its name. It comes from `jasonkarns/bats-mock`, not the `bats-core` org, so deriving its URL uniformly would point at a `bats-core/bats-mock` that does not exist.

### bats-core needs no install step

In the release tarball `bats-core-<v>/bin/bats` is a regular 755 file — **not** a symlink into `libexec` — that locates its own `libexec/bats-core` relative to `$0` via `readlink -f`, with a `greadlink` fallback. Extracting the tarball and putting `<root>/bin` on `PATH` is the entire install. That is why this action needs neither `install.sh`, nor git, nor the `apt-get install git` the equivalent devcontainer feature script begins with.

The flow is the runtime pattern: `download` → `extractTar` → strip the `bats-core-<version>/` wrapper → `cacheDir` under tool `bats` → `addPath(<root>/bin)`. The wrapper strip matters for the same reason it does for the runtimes: the tool cache is shared, and a cached root that nests the real tree inside a version-stamped directory is readable only by the code that wrote it — including, critically, not by this action's own cache-hit path.

### The helper libraries go to `$HOME/.local/share`, and only that location works

Not the tool cache, and not the `/usr/lib` (`bats-core/bats-action`) or `/usr/local/lib` (the devcontainer script) that the obvious prior art uses. The location is dictated by having **two consumers that discover libraries differently**:

- `bats_load_library <name>` resolves `<entry>/<name>/load.bash` for each entry in `BATS_LIB_PATH`.
- `vitest-bats` **never reads `BATS_LIB_PATH`.** Its `detectBatsLibraryPath` scans a fixed directory list in order: `$XDG_CONFIG_HOME/<lib>`, `~/.config/<lib>`, `$XDG_DATA_HOME/<lib>`, `~/.local/share/<lib>`, `/opt/homebrew/lib/…`, `/usr/local/lib/…`, `/usr/lib/…`.

`$HOME/.local/share/<lib>/` is the single location on both lists: the scan finds it, and exporting `BATS_LIB_PATH=$HOME/.local/share` makes `bats_load_library` find it too. It is also under `$HOME`, so nothing needs `sudo` — which is what lets the whole bats install work on a self-hosted runner where kcov's cannot.

`bats-mock` ships a flat layout (`stub.bash`, `binstub`, and *sometimes* `load.bash`). When `load.bash` is absent one is synthesized: a one-line `source` of the sibling `stub.bash`, carried over from the devcontainer script, without which `bats_load_library bats-mock` does not work at all. That one-line string is the subject of a standing build constraint — see [build and distribution](./build-and-distribution.md#a-string-that-survives-tsc-is-not-a-string-that-reaches-disk). `binstub` keeps its executable bit; it is spawned, not sourced.

`home` is a parameter for the same reason the install steps take a `Host`: it is what lets a test exercise the layout without an `$HOME` on the machine running the suite.

`jq` is **probed and warned about, never installed**. It is preinstalled on GitHub-hosted runners, and `vitest-bats` needs it to record a mock; a self-hosted runner missing it fails loudly in the log now instead of mysteriously later.

### kcov is built from source because nothing else works

This is a conclusion, not a preference, and both halves cost a probe to establish:

- **The prebuilt Linux binary is unusable on current runners.** kcov v42 is the last release publishing a binary asset; v43 and later publish source only. Parsing `DT_NEEDED` out of the v42 ELF yields `libbfd-2.38-system.so` and `libopcodes-2.38-system.so` — binutils 2.38, i.e. Ubuntu 22.04. `ubuntu-latest` is 24.04 with binutils 2.42, so those sonames do not resolve. Downloading kcov is not an option.
- **Homebrew is not a fast macOS path either.** kcov 43 publishes exactly one bottle, `arm64_tahoe` (macOS 26). GitHub's `macos-latest` is macOS 15 (`arm64_sequoia`), where `brew install kcov` compiles inside Homebrew anyway — slow, and opaque to any cache this action controls.

So the build happens here, into a prefix this action owns and caches: `$RUNNER_TOOL_CACHE/kcov/43/<arch>`, tool-cache-shaped, with `<prefix>/bin` on `PATH`. That prefix is the single unit of Actions caching; see [caching strategy](./caching-strategy.md#the-kcov-cache) for the key, the ladder and the verify probe.

Build dependencies are installed **only on a cache miss** — the whole point of the cache is that a warm run needs neither apt nor Homebrew:

| Platform | Command |
| --- | --- |
| Linux | `sudo apt-get update`, then `sudo apt-get install -y --no-install-recommends cmake g++ libdw-dev binutils-dev libcurl4-openssl-dev zlib1g-dev pkg-config` |
| macOS | `brew install dwarfutils openssl@3` — `cmake` is deliberately absent, being preinstalled on the runner images |

This is the one place the action shells out to a **system** package manager, and the only place `sudo` matters. On a runner without it the dependency install fails, the step fails typed with `build`, and the caller degrades to a warning: bats without coverage, not a red build. cmake refuses an in-source build, so the object tree is a sibling of the unpacked source rather than a directory inside it.

`descriptors/kcov.ts` **refuses `win32` as a `Result` failure** rather than skipping silently. kcov has no Windows build at all, and the caller renders the refusal message as the warning that explains why `kcov-enabled` is `false`. The failure comes before the cache is consulted: there is no key that could be right, and a restore attempt would spend a round trip to say so.

### Known limitation: kcov collects nothing on macOS today

SIP blocks `ptrace`, so kcov produces no coverage on a macOS runner — `vitest-bats` states this in its README and marks kcov `required: !onMacOS`. **kcov is installed on macOS regardless**, deliberately and forward-lookingly: the binary being present and on `PATH` means that if a future macOS image lifts the restriction, consuming repositories start collecting coverage with no change to this action. The cost is bounded by the cache — a cold macOS cache pays one build, and every run after that pays a restore.

### Exported environment

| Variable | Value |
| --- | --- |
| `BATS_LIB_PATH` | `$HOME/.local/share` |
| `BATS_PATH` | Absolute path to the `bats` executable |
| `KCOV_PATH` | Absolute path to the `kcov` executable |

`BATS_LIB_PATH` is the load-bearing one: it is what makes `bats_load_library bats-support` work in a plain `.bats` file. `BATS_PATH` and `KCOV_PATH` are conveniences for `vitest-bats`, which otherwise shells out to `command -v` for each — a `PATH` entry alone leaves a consumer that spawns the binary directly re-deriving the tool-cache layout.

`bats-enabled` and `kcov-enabled` report a **successful install, not a successful detection**, following the `biome-enabled` precedent exactly.

## The PATH problem

This is the single most important runner fact in the codebase, and three separate defects trace back to it.

> **`ActionOutputs.addPath` appends to `GITHUB_PATH`. It takes effect in *later workflow steps* only, and never mutates the current process's `PATH`.**

Three consequences, each handled explicitly:

### 1. Same-step probes must use absolute paths

The runtime verify probe runs `path.join(toolPath, plan.binary) --version`, not a bare `node --version`. Legacy invoked the bare name and therefore verified *whatever the runner image already had* — which is why its broken Windows node layout (a `PATH` entry pointing at the cache root, never reaching `node.exe`) passed its own verification for as long as it existed.

The probe uses `spawner.exitCode`, which leaves stdout and stderr undrained. That is safe for `--version` — a line or two fits the pipe buffer and the process exits — but a chattier command would fill the buffer and block forever. Anything verbose belongs on a member that drains, such as `string` or `lines`.

### 2. Spawned children need an explicit, correctly-cased prepend

`installDependencies` builds the child environment itself:

```ts
const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
return { env: { [key]: [...pathPrepends, process.env[key] ?? ""].join(delimiter) }, extendEnv: true };
```

Two details are load-bearing. **The spelling is reused, not assumed**: Windows spells it `Path`, and while Node's `normalizeSpawnArguments` does de-duplicate the merged environment case-insensitively on win32 (keeping the lexicographically-first key, so an added `PATH` would win over an inherited `Path`), that is an undocumented internal nothing obliges Node to keep. **`extendEnv: true` keeps this a prepend rather than a replacement** — without it the child would run with `PATH` and nothing else.

The list itself is `installPathPrepends` in `program.ts`: the manager's bin directory first, then every installed runtime, de-duplicated first-seen. The manager leads so its shims win a name collision with a same-named runtime — exactly the bun/deno-as-package-manager case, where `onInstallPath` has already filled `binDir` from the runtime install and the two entries are the same directory.

The runtimes are in the list because **the install is not a leaf**. A package manager spawns lifecycle scripts, and a `postinstall` running `deno install` or `bun install` resolves that binary off the `PATH` it inherited. Prepending only the manager's directory left those scripts on the runner image's bare `PATH`, where a just-installed `devEngines` runtime is not — a real cross-OS failure (`deno: not found`) on a multi-runtime workspace, not a hypothetical.

The manager is still spawned by **bare name** with its directory prepended, rather than by absolute path, for the same reason: children inherit `PATH`, not the absolute path their parent was invoked with.

**The npm exception, now closed (issue #220).** `setupPackageManager` passes `allowAmbient: false`, so no manager reaches this list without a `binDir` and the head is always the pinned manager. That reverses an earlier ruling, and the reason is that the ruling described a rule the code did not actually implement.

The old shape: `PackageManagerInstaller` probed the runner's npm with `npm --version` and, on an exact match, short-circuited without caching — reporting no `binDir`, so it contributed nothing to the list while node's own bin directory did, carrying the npm *bundled with* the pinned node. That was defended as "the npm belonging to the node you pinned." But it only held when the probe **hit**. On a **miss** the installer tool-cached the pin, its `binDir` led, and the pinned npm ran. So which npm executed was a function of the runner image's npm version — the pin honoured on a miss and quietly dropped on a hit, and the `package-manager-version` output (an echo of the request, ruling 47) reporting the pin either way. For an action whose premise is "absolute versions only, so builds are reproducible," that is the wrong non-determinism to keep, and the kit's own docstring names this repo's case: the probe interrogates the runner's npm, whose match can diverge from the npm that executes once the pinned node shadows it.

Suppressing the probe makes npm behave like every other tool here — node, bun, deno, pnpm and yarn are all installed to their exact pin, npm was the lone short-circuit — and costs one small tarball on runs where the runner's npm happened to match. The rule the list implements is now uniform: **the manager you pinned leads**.

The "no fixture asserts which npm executes" gap closed with it. The integration matrix structurally cannot catch this (its fixture versions coincide), so the coverage is a unit fixture: `program.test.ts`'s *runs the pinned npm, not the one bundled with the pinned node*, whose `PackageManagerInstaller` double reproduces the installer's own ambient branch. Drop the option and the double answers `ambient`, the pinned npm falls out of the list, and the case fails on the real symptom.

### 3. Windows `.cmd` shims need `shell: true`

On Windows every node-based manager on `PATH` is a `.cmd` batch shim, not a real executable. `CreateProcess` cannot execute one, and since **CVE-2024-27980** Node refuses to pass `.cmd`/`.bat` to it at all unless a shell is asked for. Spawning `pnpm` by bare name fails at launch (`NotFound: ChildProcess.spawn`) before the install has a chance to run.

All four managers shell on win32, bun included, and that is deliberate rather than collateral: `cmd.exe` resolves a bare `bun` through `PATHEXT`, where `.EXE` precedes `.CMD`, so it finds the same `bun.exe` in the same prepended directory a direct spawn found. The argv is static either way, so the shell buys one launch path to reason about at no cost. `cmd.exe` resolves the bare name off the **child's** `PATH`, so the prepends keep working exactly as they do without a shell.

POSIX gets no shell — the direct spawn already works, and a shell would only add a layer between the step and the manager's exit code.

**Known semantic shift:** under a shell, a manager missing from the child's `PATH` comes back as `reason: "exit-code"` (`cmd.exe`'s own 9009, "is not recognized…") rather than the `spawn` a POSIX runner reports for the same fault. Documented rather than normalized.

Argument quoting is *not* a hazard here even though Node concatenates command and args into a single `cmd.exe` command line under `shell`: every argument comes from the static `PLANS` table — no path, no version, nothing derived from an input.

---

## Rationale

### Descriptors are pure data

No `postInstall` hook, no side-effectful methods, no `process` reads. Adding a runtime is a data addition plus a row in `DESCRIPTORS`. Purity is also what makes the platform matrix testable: legacy read `process.platform` inside the installer and `os.platform()` inside the Biome descriptor, and neither was reachable from a test, which is why no legacy test ever covered a second platform.

### Layout-canonical tool caching

`<RUNNER_TOOL_CACHE>/<tool>/<version>/<arch>` is a **shared** location — the runner image writes it, and so do `setup-node` and `setup-bun`. None of them nest the tool inside a `node-v24.11.0-win-x64/` wrapper. Caching the wrapper would put a directory there that only this action knows how to read, and that its *own* hit path could not read either: a hit returns the cached root with no extracted archive left to descend into. Stripping pre-cache keeps hit and miss resolving to the same path.

### Biome is not a runtime descriptor

Biome ships a bare executable: no archive, no extraction, no layout fixup. `BiomePlan` is the two fields that vary, which is exactly what `ToolInstaller.provisionFile` takes. Sharing `RuntimePlan` would mean adding flags to every descriptor for a case that has none of an archive's problems.

### No local `RuntimeInstaller` service

The legacy implementation defined a `Context.Service` class per runtime with `makeRuntimeInstaller(descriptor)` and an `installerLayerFor(name)` swap inside the `forEach`. That whole apparatus existed to select a descriptor. A `Record<RuntimeName, RuntimeDescriptor>` lookup does the same thing with no layer, no per-iteration `Effect.provide`, and no failing-layer edge case for an unknown name — which the schema already makes unrepresentable. The descriptors themselves are deliberately kept stable: they are the design input for a possible upstream `RuntimeInstaller`.

### Echoing the request, not probing

`package-manager` / `package-manager-version` report what `devEngines` asked for. A probe would report what happens to be first on `PATH`, which on a runner with a preinstalled manager is a different answer to the same question — and the outputs are documented as the configuration, not the discovery.

---

## Implementation details

### Host injection

```ts
export const currentHost = (): Host => ({ platform: process.platform, arch: process.arch });
export const installRuntimes = (config: RuntimeConfig, host: Host = currentHost()) => /* … */;
```

`currentHost` is the **only** place this step touches `process`. `installBiome` takes the same defaulted `host`, and `installDependencies` takes a defaulted `platform` for the shell decision. No caller passes any of them; they exist so a Linux test can exercise the Windows layout and a platform a runtime publishes no build for.

### Tool-cache paths and the dependency cache

Every installed runtime's `<toolCacheBase>/<tool>/<version>` directory is archived alongside the package managers' stores, and the tools' name/version pairs feed the key's version digest — including Biome. One archive for everything is legacy's design and is kept: a runtime bump invalidates the dependency cache, which is a cost, but the alternative is two caches that can disagree about what was installed. See [caching strategy](./caching-strategy.md).

### Cross-OS validation

The Windows layout fix, the `shell: true` fix and the lifecycle-`PATH` fix are all provable only on real runners. The fixture matrix runs every fixture on ubuntu / macos / windows and is the pin for all three; the bun-as-package-manager Windows job specifically is what proves the `PATHEXT` reasoning. See [testing strategy](./testing-strategy.md).

---

## Related documentation

**Internal:**

- [Architecture](./architecture.md) — pipeline order and the two PATH joins in `program.ts`.
- [Effect service model](./effect-service-model.md) — the step contract, error classification, host/platform seams.
- [Caching strategy](./caching-strategy.md) — tool-cache paths in the archive and the version digest.
- [Testing strategy](./testing-strategy.md) — the cross-OS fixture matrix that pins these behaviours.

**Source files:**

- `src/descriptors/` — `descriptor.ts` plus `node`, `bun`, `deno`, `biome`, `bats`, `kcov`.
- `src/steps/install-runtimes.ts`, `setup-package-manager.ts`, `install-dependencies.ts`, `install-biome.ts`, `install-bats.ts`, `install-kcov.ts`.
- `src/program.ts` — `onInstallPath`, `installPathPrepends`.
