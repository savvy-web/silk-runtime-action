---
type: Convention
title: Verification means the built artifact
description: For any literal that must reach disk verbatim, check it against the built dist bundle, never against source, tsc, Biome or the unit tests alone.
tags: [bundle, ci, testing]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 0fe1f30bafad48598d383260b82a1415642578dc30a8c44febac668775b06f50
sources:
  - id: bats-mock-loader
    resource: ../../src/steps/install-bats.ts
  - id: bats-kcov-fixture
    resource: ../../__fixtures__/bats-kcov
  - id: root-claude-build
    resource: ../../CLAUDE.md
---

# Verification means the built artifact

**This action is bundled and minified, and CI runs the committed `dist`, never `node_modules`
or `src/`. A string that survives `tsc`, Biome and the unit tests has not thereby been
verified. Anything that must reach disk *verbatim* has to be checked against the built
bundle.**

This is not a caution added for symmetry. It shipped a production crash that failed before
the action did anything at all, and the change that caused it was reviewed clean twice on
the way in.

## The `BASH_SOURCE` account

`install-bats` (`../../src/steps/install-bats.ts:90-91`) synthesizes a `load.bash` for
`bats-mock` when the tarball ships none. Its content must be exactly:

```bash
source "$(dirname "${BASH_SOURCE[0]}")/stub.bash"
```

Here `${BASH_SOURCE[0]}` is **bash** interpolation, evaluated by the installed script at its
own load time. It is not a placeholder for JavaScript to fill in, and it must land on disk
unevaluated.

It was originally written as an escaped template literal spelled `` `…$${"{BASH_SOURCE[0]}"}…` ``
— an escaped `$` followed by a substitution producing the literal brace text. That
construction **evaluates correctly in source**: it was verified by hand, verified
independently by a reviewer, and passed the unit suite, which exercises the synthesis path
directly. The minifier then **constant-folded the substitution back into a live template
substitution**, so the bundled `dist/main.js` carried a real `${BASH_SOURCE[0]}` inside a
template literal. Every run of the built action died at module load with:

```text
ReferenceError: BASH_SOURCE is not defined
```

Before input parsing. Before the first log group. A green source-level review, a green
typecheck and a green test run, and a completely dead action.

The fix is a **plain single-quoted string literal**, inside which `${…}` is inert text that
no JavaScript stage can evaluate:

```ts
// biome-ignore lint/suspicious/noTemplateCurlyInString: shell interpolation for the installed script, not a JS template — see remarks
const BATS_MOCK_LOADER = 'source "$(dirname "${BASH_SOURCE[0]}")/stub.bash"\n';
```

Biome's `noTemplateCurlyInString` exists to catch a `${…}` that *was* meant to be a
template. This one was not, and the rule cannot tell the difference — so it is **suppressed
rather than worked around, because the workaround is what broke.** Concatenating
`"$" + "{BASH_SOURCE[0]}"` invites exactly the same folding and is not an escape either:
write the plain single-quoted literal and suppress the lint, do not look for a cleverer
JavaScript-level construction to dodge it.

## Three generalizations

1. **The minifier is part of the semantics of any literal that must reach disk.**
   Source-level equivalence is not output-level equivalence. Anything clever enough about a
   string's construction to need reasoning about is exactly what a minifier will reason
   about too, and it is not obliged to preserve the reasoning you did.
2. **A unit test proves the source, not the bundle.** The synthesis test passed the whole
   time this bug shipped. Only a check against `dist/*.js` — or a fixture running the built
   action — could have caught it.
3. **Review cannot substitute for either of the above.** Two people read the escaped form
   and both concluded, correctly, that it evaluated to the right string *in source*. The
   wrongness was downstream of what they were reading, in a stage neither reviewer's mental
   model included.

## The practical check and its standing structural version

The practical check is one grep against the built bundle after `pnpm build`, for any literal
that has to survive verbatim — the same grep a reviewer should run on any change to a string
synthesized in source and consumed by something other than this action's own JavaScript.

The `bats-kcov` fixture (`../../__fixtures__/bats-kcov`) is the standing structural version of
that check: it runs the **built** action (`.github/actions/local`, not source), and its
`test-command` is `bats --version && bats test/`, which fails end to end if the synthesized
loader is wrong in the bundle. A loader synthesized wrong takes `bats_load_library` down with
it, on a real runner, against real dist output — the one place this specific bug is
observable.

## Always commit both directories, and rebuild after any source change

Build and commit `dist/` **and** `.github/actions/local/` together (`git add src/ dist/
.github/actions/local/`, per `../../CLAUDE.md`). A change that is not rebuilt is a change CI
does not run: GitHub Actions loads this action directly from the checked-out ref with no
build step of its own, so whatever is missing from the committed bundle is simply absent
from every job that consumes it, however correct the source looks.

## A passing unit test proves the source, not the bundle

The `BASH_SOURCE` story is the general case of a narrower rule worth stating on its own: a
green suite over `src/**/*.ts` says nothing about what the minifier did to any literal that
needed to survive verbatim. For any string, template or otherwise, whose exact bytes matter
after bundling — a shell script fragment, a synthesized config file, anything written to
disk for a *different* interpreter to read — treat the unit test as necessary and not
sufficient, and reach for the fixture matrix or a direct `dist/` grep to close the gap the
unit tier structurally cannot close.

See [../gotchas/minifier-folds-escaped-templates.md](../gotchas/minifier-folds-escaped-templates.md)
for the reader-sees / actually-true framing of the same incident; this Convention carries the
rule and the full account of it.
