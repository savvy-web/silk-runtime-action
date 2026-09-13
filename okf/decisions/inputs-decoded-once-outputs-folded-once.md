---
title: Inputs decoded once, outputs folded once
type: Decision
status: draft
description: One typed Inputs record decoded at the top of the pipeline, and one outputs fold from all-disabled defaults, rather than reads and writes scattered across steps.
tags: [architecture, dx]
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: d2cbadfc64b79c7f9ec43b081c09fa2b468df6bd491be55126962db8d1e748c1
sources:
  - id: schema-inputs
    resource: ../../src/schema/inputs.ts
  - id: program
    resource: ../../src/program.ts
---

# Inputs decoded once, outputs folded once

## Context

The action has 18 inputs and 22 outputs. Each step could read the inputs it
needs directly off `ActionInput` and each could write the outputs it produces
directly through `ActionOutputs`, but that spreads `INPUT_` naming and
empty-string-is-absent semantics across every module that touches an input,
and leaves no single place answering "what does a run that skipped every
optional feature report?"

## Decision

`loadInputs` decodes all 18 inputs into one typed `Inputs` record, once, at
the top of `program.ts`'s pipeline, through `ActionInput.*` combinators
composed with `Config.all`[^schema-inputs]. `ActionInput`'s naming and
absence rules — the runner uppercases an input name and preserves hyphens
(`INPUT_BIOME-VERSION`, not `INPUT_BIOME_VERSION`), and an unsupplied input
and an empty string decode identically — stay entirely inside that one
module. Every step downstream receives `Inputs` as plain data; none of them
spell an environment variable or a `Config` read of their own.

Outputs run the same shape in reverse: the fold starts from `initialOutputs`,
an all-disabled-defaults `OutputsModel`, and each step's result maps over it
in `program.ts` before the fold is emitted once through `emitOutputs`. A
feature that did not run — Biome that failed to install, kcov gated off
because bats did not land — reports its default rather than a value nobody
computed, because the fold only ever *adds* a fact a step actually produced.

Two normalizations are folded into `loadInputs`'s own `Config.map` rather than
handled at a use site, because both are properties of the *input itself*, not
of any one consumer of it:

```ts
Config.map((raw) => ({
  ...raw,
  turboCache: raw.turboCache === "off" ? ("off" as const) : ("auto" as const),
  cacheBust: Option.filter(raw.cacheBust, (v) => v !== "false" && v !== ""),
}));
```

(`src/schema/inputs.ts:108-113`.) `turbo-cache` collapses to the two-member
`"auto" | "off"` union the activation table actually branches on, so nothing
downstream has to re-parse an arbitrary string. `cache-bust` filters out the
`"false"` and empty-string sentinels a workflow author might write, so
downstream code sees a plain `Option` where "was a bust requested" is either
`Some` or `None` and never a stringly-typed false positive.

`main.ts` is kept to one call — `Action.run(program, { layer: MainLive })` —
by holding the pipeline itself in `program.ts` and the layer composition in
`layers/app.ts`[^program]. That split is what lets `program.test.ts` import
`program` directly and exercise the whole input-to-output fold without
triggering a module-level `Action.run`.

## Alternatives rejected

- **Each step reads its own inputs directly off `ActionInput`.** Spreads
  naming and empty-string handling across every step that needs an input, and
  makes "what inputs does this action have" a fact recoverable only by
  grepping every module rather than reading one schema.
- **Each step writes its own outputs as it completes.** Loses the guarantee
  that a step which did not run — or failed and degraded — reports a
  meaningful default rather than nothing at all; `emitOutputs` publishing a
  fixed 22-entry order is what makes every output present on every run,
  successful or not.
- **Normalizing `turbo-cache` / `cache-bust` at each call site.** Would
  duplicate the sentinel-filtering logic wherever the raw string is consumed,
  and risks one call site handling `"false"` and another not.

## Consequences

- `INPUT_NAMES` and `OUTPUT_NAMES` are const tuples checked against
  `action.yml` by tests, so both halves of the input/output contract are
  guarded against drift from the manifest.
- A new step that needs an existing input takes it as a field of `Inputs`
  rather than reaching for `ActionInput` itself, keeping the decode-once
  property intact as the pipeline grows.
- Because the outputs fold starts from all-disabled defaults, adding a new
  output requires adding it to `initialOutputs` first — there is no path to a
  22nd output that skips the default a failed or skipped run should report.

[^schema-inputs]: ../../src/schema/inputs.ts
[^program]: ../../src/program.ts
