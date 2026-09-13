---
type: Limitation
title: kcov collects no coverage on macOS, and none at all on Windows
description: kcov is installed on every supported platform, but SIP blocks the ptrace it needs on macOS, and it refuses to build at all on Windows before the cache is ever consulted.
status: draft
bounds: ../modules/silk-runtime-action.md
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 5a1819e9813cf45ec1df88778ab5f25aefa368884c2bfc08be1e15538a8c98c0
sources:
  - id: kcov-descriptor
    resource: ../../src/descriptors/kcov.ts
  - id: vitest-bats
    resource: "npm:vitest-bats"
tags:
  - compat
---

# kcov collects no coverage on macOS, and none at all on Windows

## Trigger

`descriptors/kcov.ts`'s `plan` function refuses any platform that is neither `linux` nor
`darwin` as a `Result` failure, before the cache is ever consulted — there is no key that
could be right for a platform with no build, so a restore attempt would only spend a round
trip to say so.[^kcov-descriptor] macOS does build and install successfully, but the kernel's
System Integrity Protection blocks the `ptrace` syscall kcov's instrumentation depends on, so
the binary that does get installed there produces no coverage data when run.

## Symptom

On Windows, `kcov-enabled` reports `false` and the install step's warning renders the
descriptor's own refusal message, `` `Unsupported platform for kcov: ${platform}-${arch}` ``,
naming the exact platform/arch pair that was rejected.[^kcov-descriptor]

On macOS, the opposite and more surprising symptom: `kcov-enabled` reports `true`, `KCOV_PATH`
is exported, and the binary runs without error — but the coverage data it produces is empty.
`vitest-bats`, the consumer this action's `bats`/`kcov` inputs exist for, documents this
itself and marks its own kcov dependency `required: !onMacOS` so a macOS run does not treat
missing coverage as a failure.[^vitest-bats]

## Why this is acceptable

The Windows refusal is unconditional and has no workaround — kcov ships no Windows build at
all, so failing fast before touching the cache is strictly better than a restore that could
never hit.

The macOS behavior is a deliberate, forward-looking choice rather than an oversight: kcov is
installed on macOS regardless of the SIP restriction, on the reasoning that if a future macOS
image ever lifts it, consuming repositories start collecting real coverage with no change to
this action at all. The cost of carrying that bet is bounded by the cache — a cold macOS
cache pays one build, and every run after that pays a cheap restore rather than a rebuild.

## What a fix would take

The Windows case is not fixable from this side; it needs kcov itself to publish a Windows
build. The macOS case needs Apple's SIP to stop blocking `ptrace` for the class of process
kcov instruments, or kcov to adopt an instrumentation strategy that does not need `ptrace` at
all — neither is in this action's control, which is exactly why the current stance is to keep
installing the binary and let the day the restriction lifts be a silent win rather than a
follow-up change.

[^kcov-descriptor]: kcov-descriptor
[^vitest-bats]: vitest-bats
