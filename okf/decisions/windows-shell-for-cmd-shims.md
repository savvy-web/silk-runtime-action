---
title: Windows launches every manager through a shell; POSIX never does
description: Why shell is true on win32 for all four node-based/bun package managers, the CVE it works around, and the exit-code semantic shift that follows from it.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 49f8f889873365a7deda37d294b15871a8e1c1c803f84694490da13708b1c34c
sources:
  - id: install-dependencies
    resource: ../../src/steps/install-dependencies.ts
  - id: cve-2024-27980
    resource: https://nvd.nist.gov/vuln/detail/CVE-2024-27980
tags:
  - compat
  - security
---

# Windows launches every manager through a shell; POSIX never does

## Context

On Windows every node-based package manager on `PATH` is a `.cmd` batch shim, not a real
executable. `CreateProcess` cannot execute one directly, and since **CVE-2024-27980** Node
refuses to pass `.cmd`/`.bat` to it at all unless a shell is asked for.[^cve-2024-27980]
Spawning `pnpm` by bare name on win32 fails at launch (`NotFound: ChildProcess.spawn`)
before the install has a chance to run.[^install-dependencies]

## Decision

`spawnInstall` decides the launch via `ChildEnv.needsShell(platform)` and sets `shell: true`
on the spawned command whenever it answers true.[^install-dependencies] **All four managers
shell on win32, bun included**, and that is deliberate rather than collateral: `cmd.exe`
resolves a bare `bun` through `PATHEXT`, where `.EXE` precedes `.CMD`, so it finds the same
`bun.exe` in the same prepended directory a direct spawn would have found. The argv is
static either way, so the shell buys one launch path to reason about at no
cost.[^install-dependencies] `cmd.exe` resolves the bare name off the **child's** `PATH`, so
`installPathPrepends`'s prepends keep working exactly as they do without a shell — see
[pinned-package-manager-leads-path](./pinned-package-manager-leads-path.md).

**POSIX gets no shell.** The direct spawn already works there, and a shell would only add a
layer between the step and the manager's exit code.[^install-dependencies]

**Known semantic shift, documented rather than normalized:** under a shell, a manager
missing from the child's `PATH` comes back as `reason: "exit-code"` — `cmd.exe`'s own 9009,
"is not recognized as an internal or external command" — rather than the `spawn` reason a
POSIX runner reports for the same missing binary.[^install-dependencies] `InstallError`'s
`spawn` covers every platform failure around running the command *up to* getting a verdict —
including reading stderr and waiting on the exit code — while `exit-code` is reserved for a
command that ran and reported failure; the shell moves "manager not found" from the first
bucket to the second on Windows only.[^install-dependencies]

**Argument quoting is not a hazard here**, even though Node concatenates the command and its
arguments into a single `cmd.exe` command line under `shell: true`, which is ordinarily a
quoting risk for anything containing a space or a shell metacharacter. It is not one in this
action because every argument comes from the static `PLANS` table or `ignoreScriptsArgs` —
no path, no version, nothing derived from a workflow input reaches the argv.[^install-dependencies]

## Alternatives rejected

- **Shelling only the three genuinely `.cmd`-shimmed managers (npm, pnpm, yarn) and spawning
  bun directly.** `bun.exe` is a real binary, and bun-as-manager was the one Windows job
  passing before the shell was introduced for it too — but the asymmetry buys nothing:
  `cmd.exe`'s `PATHEXT` resolution finds the identical binary a direct spawn would, so
  shelling bun anyway trades a second launch path for zero behavioral difference and one
  fewer branch to reason about.
- **Normalizing the `exit-code` vs `spawn` distinction** so a missing manager reports the
  same reason on every platform. `cmd.exe`'s own exit code (9009) is the signal available
  under a shell; manufacturing a `spawn` failure from it would require parsing the shell's
  own error text rather than trusting the platform-native exit code.
- **Shelling POSIX spawns too, for launch-path symmetry.** POSIX's direct spawn already
  succeeds and reports the manager's own exit code untouched by an intermediary; adding a
  shell there would only insert a layer with no problem to solve.

## Consequences

Any new command this action spawns on Windows must go through the same `ChildEnv.needsShell`
decision, or it inherits the same CVE-2024-27980 failure mode the package-manager install
worked around. A caller branching on `InstallError.reason` must treat `"exit-code"` and
`"spawn"` as platform-dependent for the same underlying fault ("the manager was not found")
rather than assuming a fixed mapping from symptom to reason. Cross-OS validation for this
behavior is necessarily a real-runner concern — see
[kit-test-layers-and-real-volume](./kit-test-layers-and-real-volume.md) — because the
`.cmd`-shim resolution, the shell launch, and `PATHEXT` ordering cannot be reproduced from a
POSIX CI host.

[^install-dependencies]: install-dependencies
[^cve-2024-27980]: cve-2024-27980
