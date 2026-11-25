---
title: Turbo credentials are masked unconditionally, declassified only through Secret.*
description: Why the supplied turbo-token is masked before the activation table runs, how the hosted cache token and the job's OIDC token are handled during sign-in, why a sign-in failure carries nothing but its kind, why the embedded bearer credential is a fresh randomUUID per run, and why a missing token fails the worker closed.
type: Decision
status: draft
generated:
  by: okfit/claude-code
  at: 2026-11-22T05:18:42Z
sources:
  - id: turbo-cache-step
    resource: ../../src/steps/turbo-cache.ts
  - id: server-config
    resource: ../../src/turbo-cache/server-config.ts
  - id: inputs
    resource: ../../src/schema/inputs.ts
  - id: sign-in
    resource: ../../src/turbo-cache/sign-in.ts
tags:
  - security
x-okfit-integrity:
  generated:
    body: cc9d578da519e85c
---

# Turbo credentials are masked unconditionally, declassified only through Secret.*

## Context

The turbo-cache subsystem handles four credentials. One is supplied: `turbo-token`, the
Vercel passthrough token, which can arrive as a workflow input whether or not the
resolution the activation table lands on ends up using it. Three are obtained or made
during the run: the job's GitHub OIDC token and the cache token a hosted service issues for
it, both during sign-in, and the embedded server's bearer credential.

## Decision

**The supplied secret is masked unconditionally, before the activation table runs.**
`maskSuppliedSecrets` registers `turbo-token` with the runner's log filter first: a secret
a workflow supplied is worth redacting whether or not the resolution uses it. A run that
sets `turbo-token` alongside `turbo-cache: off` never talks to Vercel, and would otherwise
carry an unmasked token through a job that logs its environment.[^turbo-cache-step]

**Masking and declassification both go through `Secret.*`, never `Redacted.value`.**
`Secret.mask` registers a value with the log filter and returns nothing: the mask-only
call, for a site that never needs the plaintext. `Secret.forRunnerFile` masks first and
then returns the string `GITHUB_ENV` needs, and is how the passthrough token, the hosted
cache token and the embedded credential each become a `TURBO_TOKEN` on their way to
`exportVariable`.[^turbo-cache-step]

**The hosted cache token is masked twice, and the first mask is inside `signIn`.** The
service's answer is wrapped in `Redacted` and passed to `Secret.mask` while it is still a
local of `signIn`, before the function returns, so no caller can hold it unmasked.
`useHostedCache` then declassifies it through `Secret.forRunnerFile`, which masks again
before it returns: the token is in the log filter before the first variable is
exported.[^sign-in][^turbo-cache-step]

**The OIDC token is never unwrapped.** `OidcTokenIssuer.token` returns a `Redacted` the
live issuer masked at issuance, and `signIn` hands that value to core's
`HttpClientRequest.bearerToken`, which takes the `Redacted` itself. No line of this
repository turns it into a string.[^sign-in]

**A sign-in failure carries its kind and nothing else.** `SignInError` has a closed
`reason` union and an optional `detail`, and no `cause`. `detail` is never free text: it is
one of the issuer's own reason literals or an HTTP status code, both of which `signIn`
spells itself. A transport error from core's `HttpClient` holds the request it was sending,
bearer token included, and a refusal's body is whatever the far side chose to write, so
both are dropped where the error is made rather than trusted not to be logged later. The
warning `signInOrWarn` prints follows the same rule: the reason and the detail, never the
`turbo-api` input (a URL can carry a userinfo), never a response, never a cause. A defect
is named as a defect and its message is dropped.[^sign-in][^turbo-cache-step]

**The embedded bearer credential is a fresh `randomUUID` per run**, replacing an earlier
implementation's constant compiled into the source. It is simultaneously the server's
`expectedToken` and the `TURBO_TOKEN`/`TURBO_TEAM` value Turbo authenticates with, so both
sides come from one value and a leaked build no longer discloses every runner's cache
credential. It is masked before the spawn, through `Secret.forRunnerFile`.[^turbo-cache-step]

**Fail closed on a missing token.** `readServerConfig`, run inside the detached worker,
**fails** rather than booting degraded when `TURBOGHA_TOKEN` is absent. An earlier
implementation read an absent token as an empty one, which the handler treats as
"authentication disabled" — so a spawn that lost its environment would leave an **open**
cache server listening on the runner. The check lives in the worker rather than the handler
on purpose: the handler's permissive branch on an empty token is what a handler test needs,
while the step that spawns the worker always supplies a token, so a missing one at that point
means something is wrong and exiting says so.[^server-config]

**The supplied secret is `Redacted` at the input boundary.** `turbo-token` is read with
`ActionInput.redacted` rather than `ActionInput.string`. `turbo-api` is a plain string: it
is a URL, not a credential, and what a URL can smuggle is handled by rebuilding it from its
origin and path before it is used or exported.[^inputs][^sign-in]

See [`../conventions/detached-worker-outputs-layer.md`](../conventions/detached-worker-outputs-layer.md)
for the companion rule that keeps a masked value from being written to disk in plaintext by
a detached worker.

## Alternatives rejected

- **Masking a supplied secret only when the resolved mode uses it.** Would leave an
  unmasked `turbo-token` in a job that resolves to `off`, hosted or embedded while a
  workflow happened to also set the token.
- **Masking the hosted cache token only at the export.** Leaves it unmasked between the
  service's answer and the export, in the hands of whatever caller `signIn` has.
- **Carrying the underlying error as `cause` on `SignInError`.** The transport error holds
  the request and its bearer token; any later log of the failure would print it.
- **Declassifying through `Redacted.value` directly** at any call site. Bypasses the log
  filter registration `Secret.*` performs.
- **A compiled-in constant bearer credential**, as an earlier implementation used. A single
  leaked build would disclose every runner's cache credential rather than just the one run's.
- **Booting the worker degraded when `TURBOGHA_TOKEN` is absent**, treating a missing token as
  an empty one. Leaves an unauthenticated cache server listening on the runner.

## Consequences

No turbo-cache credential this action reads, obtains or makes reaches a log unmasked,
whichever mode the activation table resolves to. A sign-in that fails leaves one warning
with a reason word and at most a status, and nothing a reader could use. A build that leaks
cannot disclose more than the one run's embedded credential. A spawn that loses its
environment fails loudly in the worker's own log rather than silently opening the cache
server to anyone who can reach the port.

[^turbo-cache-step]: turbo-cache-step
[^server-config]: server-config
[^inputs]: inputs
[^sign-in]: sign-in
