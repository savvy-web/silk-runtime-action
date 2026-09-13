---
title: "`Secret.adopt` looks like the right member for the turbo server's config reader, and is wrong twice over"
description: Why the kit's Secret.adopt is the wrong fit for readServerConfig even though its shape matches the detached worker's Redacted.make calls exactly.
type: Gotcha
status: draft
stale_after: 2027-03-13T00:00:00Z
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 594af42b7183ac9ee9ea938453a06e3b3b47428f516663f34fa261787a13890b
resource: ../../src/turbo-cache/server-config.ts
sources:
  - id: server-config
    resource: ../../src/turbo-cache/server-config.ts
tags:
  - security
  - dx
---

# `Secret.adopt` looks like the right member for the turbo server's config reader, and is wrong twice over

A reader who opens `@effected/github-actions` looking for a way to re-wrap a plaintext
environment variable as a redacted value will find `Secret.adopt` and reasonably conclude it
is exactly what `server-config.ts`'s `s3ConfigFrom` needs: the kit ships it as the far side of
a handoff, and its job is precisely what the worker is doing at every
`Redacted.make(read(env, …))` call site.[^server-config] What is actually true is that
`Secret.adopt` is wrong for this call site in two ways that are both invisible from its
signature alone, and it was deliberately not adopted here.

## First: `adopt` is effectful, `readServerConfig` is deliberately pure

`Secret.adopt` is a `Config` — an effectful reader, requiring an environment to run against.
`readServerConfig` takes the environment as a plain **parameter** and returns a
`Result.Result<TurboServerConfig, string>` with no `Effect` in its signature at
all.[^server-config] That purity is not incidental: it is what lets the config-reading logic
be tested by handing it a plain record, with no runtime, no layer composition, and no service
to provide. Adopting `Secret.adopt` at this call site would make the cache server's whole boot
path effectful and drag that test suite along with it.

## Second: `adopt` reverses the pass-through-empty ruling

`Secret.adopt`'s contract is that a missing **or empty** value fails as a `ConfigError` naming
the variable. `s3ConfigFrom` and `readServerConfig` deliberately do the opposite for a missing
or empty S3 credential: `read(env, name)` returns `""` for both unset and empty, and an empty
bucket or credential is passed straight through rather than refused, so the S3 backend itself
can report its own misconfiguration — carrying the bucket name and the failed request's HTTP
status — which is a better diagnostic than anything synthesizable at config-read time.[^server-config]
Using `Secret.adopt` here would turn that deliberately permissive path into an early,
less-informative failure.

## What actually happened with this ask

This was raised with the kit maintainers and accepted as a real gap: the residual ask — a
`Result`-shaped primitive over `string | undefined`, which would let a config reader express
"maybe present, maybe absent" without forcing either `Config`'s effectful shape or a manual
`read` helper — was logged as a data point rather than built. `server-config.ts`'s own `read`
helper (`env[name] ?? ""`) is the workaround that exists until such a primitive does.[^server-config]

See [turbo secret handling](../decisions/turbo-secret-handling.md) for the fuller decision
record on how secrets are masked, declassified, and threaded through the detached worker.

[^server-config]: server-config
