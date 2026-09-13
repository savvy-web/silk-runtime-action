---
title: Per-step error taxonomy, no central error union
type: Decision
status: draft
description: Each pipeline step owns its own Data.TaggedError with a stored message and a reason literal union, rather than a central ActionError type; the standing rules for that shape and its prose.
tags: [architecture, dx, observability]
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: b368f5c580be7a802f76d09fe944e88333a6be52d374fcb1a3d758e995f2ed09
sources:
  - id: restore-cache
    resource: ../../src/steps/restore-cache.ts
  - id: install-bats
    resource: ../../src/steps/install-bats.ts
  - id: install-kcov
    resource: ../../src/steps/install-kcov.ts
  - id: setup-package-manager
    resource: ../../src/steps/setup-package-manager.ts
  - id: install-runtimes
    resource: ../../src/steps/install-runtimes.ts
  - id: main
    resource: ../../src/main.ts
  - id: post
    resource: ../../src/post.ts
---

# Per-step error taxonomy, no central error union

## Context

Thirteen pipeline steps each fail in ways specific to what they do — a
download that 404s, a build that will not compile, a state read that decodes
to garbage. A single shared `ActionError` type would need either a giant
reason union covering every step's failure modes, or a generic
`{ step, message }` shape that throws away the structure a `catchTag` or a
`switch` could otherwise use.

## Decision

There is **no central `ActionError` union and no `errors/` module**. Each
step exports its own `Data.TaggedError` subclass — not `Schema.TaggedErrorClass`
— with a `reason` literal union, a **stored** `message` field, and an
optional `cause`:

```ts
export class CacheError extends Data.TaggedError("CacheError")<{
  readonly reason: "key" | "restore" | "state" | "save";
  readonly message: string;
  readonly cause?: unknown;
}> {}
```

(`src/steps/restore-cache.ts:59`.) `program.ts`'s error channel is the union
of every step's by inference — nothing declares it by hand. Thirteen of these
exist: `ConfigError` (`load-config`), `BiomeDetectError`, `TurboDetectError`,
`BatsDetectError`, `CacheError` (also used by `post`), `RuntimeInstallError`,
`PackageManagerError`, `InstallError`, `BiomeInstallError`, `BatsInstallError`,
`KcovInstallError`, `TurboCacheError`, `SummaryError`.

Some reason literals are **declared and never raised**, and that is
deliberate rather than dead code: the error type is the shape a failure is
*logged as*, and keeping a literal on the contract leaves room for a
genuinely unexpected case without making today's tolerance a lie. One literal
was **removed** for the opposite reason during the rebuild — `TurboCacheError`
no longer carries a `backend` reason, because the activation table resolves
every input combination to one of its four rows, so no code path can raise
it.

Two of the newer unions carry a distinction the older ones do not need.
`BatsInstallError` has **four** reasons where the tool-installer's own has
three: `"download" | "extract" | "install" | "publish"`, and `install` is this
step's own — copying an extracted library into `$HOME/.local/share`, or
synthesizing bats-mock's `load.bash` — with no counterpart in the
provisioner's reasons (`src/steps/install-bats.ts:26-30`). `KcovInstallError`
splits `"build"` from `"verify"` (`"detect" | "download" | "build" | "verify" |
"publish"`, `src/steps/install-kcov.ts:29-33`) because "did not compile" and
"compiled and then would not run" are different problems with different
remedies, and the warning a consumer reads should say which one happened.

Classification helpers are written to be **exhaustive by construction**:
`setup-package-manager.ts` narrows the kit's reason union in a `switch` with a
`const unhandled: never` default arm[^setup-package-manager];
`install-biome.ts` uses a `switch` with **no** default and an annotated
return type. Either shape turns a new upstream reason literal into a
typecheck failure here, rather than a silent fall-through that logs the wrong
classification.

Two prose helpers in `install-runtimes.ts` stay deliberately separate[^install-runtimes]:
`extractErrorReason(error)` returns the sentence a human reads and **prefers
`message` over `reason`** — swapped relative to legacy, because `@effected`
errors carry their discriminant in `reason` (e.g. `downloadFailed`) and their
prose in `message`, where the legacy order rendered every install failure as
one bare word. `classify(error)` reads the `reason` **discriminant** to pick
this step's own literal; unifying the two helpers would tie a routing
decision to a message string that could change independently. Every wrap
names the failure exactly once — legacy nested its own prose inside itself
(`Failed to install dependencies with pnpm: Failed to install dependencies:
…`); every wrap here adds exactly one prefix and carries the inner error's
message verbatim.

`main` deliberately has **no** `catchDefect`[^main] — a defect is a bug in
this action, and failing the job is the correct response to one. `post` and
`startTurboCache` both keep one, as defence in depth for a phase that must
never fail a workflow whose real work already succeeded[^post].

## Alternatives rejected

- **A single `ActionError` union covering every step.** Would force every
  `catchTag` and every log line to discriminate on a step field before it
  could discriminate on a reason, and would make adding a step a change to a
  shared type every other step's exhaustiveness check has to re-verify.
- **`Schema.TaggedErrorClass` instead of `Data.TaggedError`.** These errors
  are never decoded from an external representation — they are constructed at
  a raise site and read by a log line or a `catchTag` — so a schema's
  construction-time validation cost buys nothing, and a schema-backed error
  would invite persisting an error across the main/post phase boundary, which
  nothing here does.
- **Computed-getter `message` (the legacy shape).** A getter cannot see the
  arguments the raise-site call had; a stored field, assembled where the
  context lives, can.

## Consequences

- Adding a step means adding its own tagged error class rather than extending
  a shared union — additive by construction, at the cost of no single place
  listing every possible failure reason across the whole action.
- A reason literal with no producer is legitimate and expected, not a lint
  finding to clean up; each such case is documented at its definition site
  rather than removed defensively.
- `main`'s missing `catchDefect` means a genuine bug in this action fails the
  job loudly, by design — this is not itself a gap, but any future step added
  to `main`'s pipeline inherits that same fail-fast posture unless it is
  explicitly self-catching.

[^main]: ../../src/main.ts
[^post]: ../../src/post.ts
[^setup-package-manager]: ../../src/steps/setup-package-manager.ts
[^install-runtimes]: ../../src/steps/install-runtimes.ts
