---
title: Turbo credentials are masked unconditionally, declassified only through Secret.*
description: Why every turbo-cache secret is masked before the activation table runs, why the embedded bearer credential is a fresh randomUUID per run, and why a missing token fails the worker closed.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-09-13T20:36:06Z
  body_sha256: 39751fa42c6f2b9999b9d44249d862859a0c688b1e835ddcf1a15c9daafa03bf
sources:
  - id: turbo-cache-step
    resource: ../../src/steps/turbo-cache.ts
  - id: server-config
    resource: ../../src/turbo-cache/server-config.ts
  - id: inputs
    resource: ../../src/schema/inputs.ts
tags:
  - security
---

# Turbo credentials are masked unconditionally, declassified only through Secret.*

## Context

The turbo-cache subsystem handles a Vercel passthrough token, an S3 access key ID, an S3
secret access key, and an S3 session token — any of which can arrive as a workflow input
whether or not the resolution the activation table lands on ends up using it.

## Decision

Three things happen before anything is spawned, all in `maskSuppliedSecrets`:

1. **Masking is unconditional and runs before the activation table.** A secret a workflow
   supplied is worth redacting whether or not the resolution uses it: a run that sets
   `turbo-s3-secret-access-key` alongside passthrough credentials resolves to Vercel and never
   touches S3, and would otherwise carry an unmasked key through a job that logs its
   environment.[^turbo-cache-step]
2. **`turbo-s3-access-key-id` is masked too**, which an earlier implementation did not do. It
   is the least sensitive of the four secrets, and pairing it with the value it authenticates
   alongside costs nothing.[^turbo-cache-step]
3. **Masking and declassification both go through `Secret.*`, never `Redacted.value`.**
   `Secret.mask` registers a value with the log filter and returns nothing — the mask-only
   call, and the reason the member exists at all: this call site previously used
   `Secret.forSigning` purely for its masking side effect and discarded the plaintext it
   returned, which recorded "declassified for signing" in the kit's audit trail about a value
   that never signs anything. `Secret.forSigning` masks first and *then* returns plaintext,
   for a value genuinely about to be used. `Secret.forChildEnv(record)` masks the whole
   record before returning any of it, and is the one sanctioned way a `Redacted` becomes a
   detached child's environment variable. `Secret.forRunnerFile` covers the passthrough
   token on its way to `exportVariable`.[^turbo-cache-step]

**The embedded bearer credential is a fresh `randomUUID` per run**, replacing an earlier
implementation's constant compiled into the source. It is simultaneously the server's
`expectedToken` and the `TURBO_TOKEN`/`TURBO_TEAM` value Turbo authenticates with, so both
sides come from one value and a leaked build no longer discloses every runner's cache
credential.[^turbo-cache-step]

**Fail closed on a missing token.** `readServerConfig`, run inside the detached worker,
**fails** rather than booting degraded when `TURBOGHA_TOKEN` is absent. An earlier
implementation read an absent token as an empty one, which the handler treats as
"authentication disabled" — so a spawn that lost its environment would leave an **open**
cache server listening on the runner. The check lives in the worker rather than the handler
on purpose: the handler's permissive branch on an empty token is what a handler test needs,
while the step that spawns the worker always supplies a token, so a missing one at that point
means something is wrong and exiting says so.[^server-config]

**Secrets are `Redacted` at the input boundary.** `turbo-token`, `turbo-s3-secret-access-key`,
and `turbo-s3-session-token` are read with `ActionInput.redacted` rather than
`ActionInput.string`, and are declassified only through `Secret.*`, never by unwrapping a
`Redacted` directly.[^inputs]

See [`../gotchas/secret-adopt-looks-like-the-right-fit.md`](../gotchas/secret-adopt-looks-like-the-right-fit.md)
for why the kit's `Secret.adopt` — which matches this shape at a glance — is deliberately not
used here, and [`../conventions/detached-worker-outputs-layer.md`](../conventions/detached-worker-outputs-layer.md)
for the companion rule that keeps a masked value from being written to disk in plaintext by
the detached worker's own layer.

## Alternatives rejected

- **Masking only the secrets the resolved backend actually uses.** Would leave an unmasked
  S3 secret in the log filter on a run that resolves to passthrough or the GitHub backend
  while a workflow happened to also set S3 credentials.
- **Leaving `turbo-s3-access-key-id` unmasked**, on the reasoning that an access key ID alone
  is not highly sensitive. Rejected because pairing its masking with the secret it
  authenticates alongside costs nothing.
- **Declassifying through `Redacted.value` directly** at any call site. Bypasses the log
  filter registration `Secret.*` performs and was the shape of the bug `Secret.mask` exists to
  correct.
- **A compiled-in constant bearer credential**, as an earlier implementation used. A single
  leaked build would disclose every runner's cache credential rather than just the one run's.
- **Booting the worker degraded when `TURBOGHA_TOKEN` is absent**, treating a missing token as
  an empty one. Leaves an unauthenticated cache server listening on the runner.

## Consequences

No turbo-cache secret this action reads ever reaches a log unmasked, regardless of which
backend the activation table resolves to. A build that leaks cannot disclose more than the
one run's embedded credential. A spawn that loses its environment fails loudly in the
worker's own log rather than silently opening the cache server to anyone who can reach the
port.

[^turbo-cache-step]: turbo-cache-step
[^server-config]: server-config
[^inputs]: inputs
