---
type: Convention
title: PATH publication rules
description: addPath only reaches later workflow steps, so this-process probes must use absolute paths and spawned children need an explicit, correctly-cased PATH prepend.
tags: [compat, dx]
status: draft
stale_after: "2027-03-13T00:00:00Z"
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 07b3621245ece011d30ba2ef7bfd216b773e3032c0a699f0f5e8513353e8a511
sources:
  - id: install-runtimes-verify
    resource: ../../src/steps/install-runtimes.ts
  - id: install-dependencies-child-env
    resource: ../../src/steps/install-dependencies.ts
  - id: program-path-joins
    resource: ../../src/program.ts
---

# PATH publication rules

The single most important runner fact in this codebase:

> **`ActionOutputs.addPath` appends to `GITHUB_PATH`. It takes effect only in *later
> workflow steps*, and it never mutates this process's own `PATH`.**

Every rule below exists because of that one fact, and legacy got at least one of them wrong
in each direction — verifying against the wrong binary, and leaving a spawned child unable
to find a runtime this same run had just installed.

## 1. A same-step probe must use an absolute path, never a bare command name

`installRuntimes` (`../../src/steps/install-runtimes.ts`) calls `outputs.addPath(toolPath)`
and then, in the same step, verifies the install by spawning `path.join(toolPath,
plan.binary) --version` — by absolute path, never the bare runtime name. `addPath` has not
taken effect yet in this process, so a bare-name probe would silently verify *whatever the
runner image already had on `PATH`*, not the version this run just installed.

The probe uses `spawner.exitCode`, which **leaves stdout and stderr undrained**. That is
safe for `--version` — a line or two fits the pipe buffer and the process exits — but a
chattier command spawned the same way would fill the buffer and block forever. Any command
whose output cannot be assumed to fit one pipe buffer belongs on a spawner member that
drains it, such as `string` or `lines`, not on `exitCode`.

## 2. A spawned child needs an explicit, correctly-cased PATH prepend

`ActionOutputs.addPath` reaching only later steps means the dependency install's own child
process is in exactly the same position as a same-step probe: unless the child is told
where a manager or runtime landed, it cannot find it. `installDependencies`
(`../../src/steps/install-dependencies.ts`) builds that child environment through the kit's
`ChildEnv.prependPath`, which owns the two traps a hand-rolled version would otherwise have
to spell out itself:

- **The `PATH` key's casing has to be respected, not assumed.** Windows spells the
  environment variable `Path`, and a naive assignment of a literal `PATH` key can produce an
  environment carrying both spellings, with no promise from the platform about which one a
  spawned process actually reads. `ChildEnv.prependPath` resolves this rather than assuming
  one spelling.
- **`extendEnv: true` is what keeps the write a prepend rather than a replacement** — without
  it, the child would run with only the constructed `PATH` and nothing else the runner
  normally provides.

The list handed to `ChildEnv.prependPath` — `installPathPrepends` in `../../src/program.ts:110-116` —
is the ordered, first-seen-deduplicated set of every directory this run put a binary in: the
activated package manager's bin directory first (via `onInstallPath`,
`../../src/program.ts:70-76`, which fills in a bun/deno-as-package-manager's `binDir` from
the matching installed runtime when the manager step itself reports none), then every
installed runtime's directory. The manager leads so its shims win any name collision with a
same-named runtime.

**The runtimes are not optional garnish on that list.** The install is not a leaf: a package
manager's install spawns lifecycle scripts, and a `postinstall` running `deno install` or
`bun install` resolves that binary off the `PATH` it inherited from the install child.
Prepending only the manager's own directory left those scripts looking at the runner image's
bare `PATH`, where a `devEngines` runtime this action had just installed simply is not —
`deno: not found`, on every runner, in a multi-runtime workspace. This was a real,
reproduced cross-OS failure, not a hypothetical edge case.

## 3. Spawn by bare name with the directory prepended, not by absolute path

The manager is still spawned by its **bare name**, with its directory prepended onto the
child's `PATH` — never invoked by the absolute path this action resolved it to. Children
inherit `PATH` as an environment variable, not the absolute path their parent happened to
invoke; spawning by absolute path here would silently stop testing that the prepend itself
is doing its job, which is the exact thing this rule exists to guarantee for every
downstream lifecycle script.

See [../gotchas/add-path-is-for-later-steps.md](../gotchas/add-path-is-for-later-steps.md)
for the gotcha framing of rule 1's underlying fact, and
[../decisions/pinned-package-manager-leads-path.md](../decisions/pinned-package-manager-leads-path.md)
for why the pinned manager, not an ambient one, leads the prepend list.
