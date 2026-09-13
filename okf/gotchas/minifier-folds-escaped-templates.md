---
title: A green tsc, Biome, unit suite and two reviews still shipped a dead bundle
description: A shell-interpolation string escaped as a template literal passes every check that runs against source and dies at module load in the minified dist.
type: Gotcha
status: draft
stale_after: 2027-03-13T00:00:00Z
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 3fcfaf894712f1564fda4de9c2e4f5f7d7a3943635d22f9b8d063ddf0312b5e9
resource: ../../src/steps/install-bats.ts
sources:
  - id: install-bats
    resource: ../../src/steps/install-bats.ts
tags:
  - bundle
  - ci
---

# A green tsc, Biome, unit suite and two reviews still shipped a dead bundle

## What a reader sees

`BATS_MOCK_LOADER`, the synthesized `load.bash` fallback for a `flat`-layout bats library
that ships none, needs to write `${BASH_SOURCE[0]}` to disk verbatim so **bash** evaluates
it at the installed script's own load time.[^install-bats] An earlier version spelled the
literal as a template literal escaped with a doubled `$` —
``` `…$${"{BASH_SOURCE[0]}"}…` ``` — which type-checks under `tsc`, satisfies Biome, passes
the unit suite, and was verified correct in source **twice, by hand, in two separate
reviews**.[^install-bats]

## What that leads you to conclude

That the escape worked: `tsc` was green, the unit tests exercised the value and matched it,
Biome raised nothing, and two humans read the literal and confirmed it evaluated to the
literal text `${BASH_SOURCE[0]}` rather than to a JavaScript template substitution. Four
independent checks agreeing looks like proof the string is safe to ship.

## What is actually true

None of those four checks run against what actually reaches the runner. This action is
**bundled and minified**, and CI runs the committed `dist/main.js`, never `node_modules` or
raw `src/`.[^install-bats] The minifier **constant-folds** the escaped template literal back
into a real substitution: `dist/main.js` came out of the build carrying a live
`${BASH_SOURCE[0]}` inside an actual template literal, so the very first time the module
loaded — before the action did anything at all — it threw
`ReferenceError: BASH_SOURCE is not defined`.[^install-bats] `tsc`, Biome, and the unit suite
all evaluate the pre-minification source; the minifier is a transform none of them run
through, so a string that survives every one of those checks is not a string that survives
minification. Concatenation (`"$" + "{BASH_SOURCE[0]}"`) invites the identical fold and is
not an escape either.[^install-bats]

The fix, at `src/steps/install-bats.ts:91`, is a **plain single-quoted string literal**:
`'source "$(dirname "${BASH_SOURCE[0]}")/stub.bash"\n'`, held in the `BATS_MOCK_LOADER`
constant. Inside a plain string, `${…}` is inert text no JavaScript stage — not `tsc`, not
Biome, not the minifier — can evaluate, so there is nothing left for the minifier to fold.
Biome's `noTemplateCurlyInString` exists precisely to flag a `${…}` that *was* meant to be a
template substitution; it cannot tell this one is deliberate shell interpolation, so it is
suppressed at that line with
`// biome-ignore lint/suspicious/noTemplateCurlyInString: shell interpolation for the
installed script, not a JS template — see remarks` rather than worked around, because the
workaround is what broke the first time.[^install-bats]

See [`verify-against-the-built-artifact`](../conventions/verify-against-the-built-artifact.md)
for the convention this incident produced: grep `dist/` for any verbatim literal rather than
trusting source-level review or the unit suite to speak for the shipped bundle.

[^install-bats]: install-bats
