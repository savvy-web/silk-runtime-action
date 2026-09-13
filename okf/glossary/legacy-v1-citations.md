---
type: Glossary
title: "Legacy / v1 / oracle N / ruling N / quirk N citations"
description: Provenance labels scattered through src/ comments that cite a pre-rebuild tree this repository does not carry — the prose beside each label is the authority, never the number.
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: a945d005bb7356b5eb7e6380aeeed72f82945ef444a0050e785ad8081e790a6b
sources:
  - id: src-claude-md
    resource: ../../src/CLAUDE.md
  - id: post-example
    resource: ../../src/post.ts
tags:
  - dx
---

# Legacy / v1 / "oracle N" / "ruling N" / "quirk N" citations

Roughly sixty comments in `src/` carry a label of the form `oracle N`, `ruling N`, or
`quirk N` — for example, `src/post.ts:38`'s `(oracle 35)`, attached to the statement that a
cache save is deliberately not re-checked twice.[^post-example] "Legacy" and "v1" appear
alongside them, referring to the pre-rebuild implementation these labels were derived from.

In this repository these are **stable labels for decisions already made, not live
cross-references to anything that still exists.** The source tree they cite — the v1
implementation and the rulings ledger that assigned each number — lived under
`docs/superpowers/`, a directory `.gitignore` excludes. It is gitignored local-only state:
a clean checkout of this repository has none of it, and that absence is correct rather than
a missing file to go find.[^src-claude-md]

## Why this repository uses the term this way

`src/CLAUDE.md` states the rule directly: **the sentence beside a citation is the authority,
and the number is only provenance.** Every one of these labels sits next to a prose statement
of the decision it names, because the tree the label points to was already being deleted when
the label was written. If a citation ever appears with no such statement beside it, the
statement is what is missing — it gets written from the code and the tests that exist today,
not recovered by finding the vanished document.[^src-claude-md]

New decisions do not get a new numbered citation: `src/CLAUDE.md` is explicit that a new
decision earns prose, and where it cost something, the incident that forced it — not another
`ruling N`.[^src-claude-md]

## The trap

An agent — or a person — encountering `(oracle 35)` or `(ruling 74)` for the first time will
reasonably go looking for "oracle 35" or a rulings ledger to read the fuller reasoning. There
is no such document to find in this repository, in any branch or history, because it was
never checked in; `docs/superpowers/` is local-only working state that this project's own
`.gitignore` excludes. The prose immediately beside the number is the complete account, and
searching further only costs time.

[^post-example]: post-example
[^src-claude-md]: src-claude-md
