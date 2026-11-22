---
title: A hosted cache signed in to by OIDC is tried first, and the embedded server on the GitHub cache is the fallback
description: Why turbo-api selects a hosted remote cache the job signs in to with its GitHub OIDC token, why every sign-in failure falls back to the embedded detached server instead of failing the job, why the S3 backend and its stored keys are gone, and the choices about the embedded server that still stand.
type: Decision
status: draft
supersedes: ./embedded-turbo-server.md
generated:
  by: okfit/claude-code
  at: 2026-11-22T05:18:42Z
sources:
  - id: activation
    resource: ../../src/turbo-cache/activation.ts
  - id: sign-in
    resource: ../../src/turbo-cache/sign-in.ts
  - id: handler
    resource: ../../src/turbo-cache/handler.ts
  - id: server-config
    resource: ../../src/turbo-cache/server-config.ts
  - id: turbo-cache-step
    resource: ../../src/steps/turbo-cache.ts
  - id: turbo-server
    resource: ../../src/turbo-server.ts
  - id: inputs
    resource: ../../src/schema/inputs.ts
  - id: state
    resource: ../../src/state.ts
  - id: post
    resource: ../../src/post.ts
  - id: changeset
    resource: ../../.changeset/hosted-turbo-cache-signin.md
  - id: e2e-workflow
    resource: ../../.github/workflows/test-turbo-cache.yml
  - id: remote-cache-design
    resource: "the hosted remote build cache design of 2026-11-21, section silk-runtime-action; a git-ignored file in savvy-web/infra, moving to savvy-web/cache"
    title: "Hosted remote build cache (savvy-web/cache): design"
    last_modified: 2026-11-21T00:00:00Z
  - id: owner-approval
    resource: conversation with the repository owner
    author: human:spencer
    last_modified: 2026-11-21T00:00:00Z
  - id: cache-service
    resource: https://github.com/savvy-web/cache
tags:
  - architecture
  - caching
  - ci
  - security
integrity:
  generated:
    body: 5c1c6fc268244b97
---

# A hosted cache signed in to by OIDC is tried first, and the embedded server on the GitHub cache is the fallback

## Context

Turbo speaks an HTTP remote-cache protocol (`/v8/artifacts/*`). The decision this one
replaces gave every consumer a cache with no Vercel account by starting a server inside the
job, over one of two stores: the GitHub Actions cache or an S3 bucket. The S3 store was
reached with access keys held as hand-set organization secrets, had no public route, and so
served CI only.[^remote-cache-design]

The owner approved a hosted cache service, `savvy-web/cache`, that CI signs in to with
GitHub's OIDC token so that no cache secret is stored in any repository or
organization.[^remote-cache-design][^owner-approval][^cache-service] The design's
anti-goal binds this action directly: a job must not fail, or get slower than an uncached
build, because the cache is down or refuses it.[^remote-cache-design]

As of 2026-11-22 this is on the local branch `feat/hosted-turbo-cache`: not pushed, not
released, and the two integration jobs that exercise the hosted path
(`hosted-double-build` and `hosted-fallback`) have never run.[^e2e-workflow] The changeset
marks it a major version.[^changeset]

## Decision

**Four first-match rules, in this order** (`resolveTurboCache`):[^activation]

1. No `turbo.json`, or `turbo-cache: off`: nothing.
2. `turbo-api` set: **hosted**. Sign in to that service; when sign-in is not possible, use
   the embedded server.
3. `turbo-token` and `turbo-team` both set: passthrough to Vercel.
4. Otherwise: the **embedded** server on the GitHub Actions cache.

**`off` is decided before anything else.** A shared workflow turns the cache off for a
fork's code, and nothing else a caller passes may mint a token or send a request after
that. Hosted precedes passthrough because a workflow that names a hosted service means it,
whatever Vercel credentials an organization also publishes.[^activation]

**Sign-in is the job's own OIDC token and nothing stored.** `signIn` mints a token whose
audience is the origin of `turbo-api`, trades it at `POST <turbo-api>/auth/github`, and
gets back `{ token, expiresAt }`. The step then exports `TURBO_API` (the service's URL,
rebuilt from origin and path so a userinfo, query or fragment in the input reaches neither
the request nor the exported value), a masked `TURBO_TOKEN`, and `TURBO_TEAM=silk`. The
team is a fixed word: the service decides what a job may read and write from its token and
ignores the team, while turbo refuses to use a remote cache without
one.[^sign-in][^turbo-cache-step]

**Https or nothing, with no exception for loopback.** The request carries a token that
proves which repository and ref a job runs for, and the answer is a credential turbo sends
with every artifact.[^sign-in]

**Every sign-in failure is one warning and the embedded server.** `SignInError` has six
reasons (`notHttps`, `oidc`, `refused`, `timeout`, `malformed`, `transport`), and
`signInOrWarn` answers each of them, and a defect, the same way: a warning naming the
reason, then `startEmbeddedServer`. Sign-in as a whole is bounded at ten seconds, one bound
over the mint, the trade and the read, because what it protects is the job. From the first
spawn on, a hosted run that could not sign in is an embedded run: same server, same
exports, same state for `post`.[^sign-in][^turbo-cache-step] How the tokens are handled,
and why a failure carries nothing but its kind, is
[turbo-secret-handling](./turbo-secret-handling.md).

**`turbo-api` has no default.** The action is public and the URL is the caller's; the
shared workflows pass it. It is read verbatim at the input boundary, and whether it is
usable is decided where it is used, so a bad value degrades to the embedded server instead
of failing the input decode and the job with it.[^inputs][^remote-cache-design]

**The S3 backend is removed.** The seven `turbo-s3-*` inputs are gone and
`turbo-cache-backend` reports `hosted` where it once could report `s3`. The embedded
server has one store, so `TurboServerConfig.backend` and `TurboServerState.backend` are the
single literal `github`.[^server-config][^state][^changeset]

### What still stands about the embedded server

These choices carry over unchanged from the superseded decision, and are restated here so
this record is complete on its own.

- **Detached process, not an in-process server.** The main phase has to return so the
  workflow can reach the consumer's own `turbo run` steps. The child is spawned detached
  (`src/turbo-server.ts`, the third bundle), with stdout and stderr redirected to a log
  file whose path is derived from the port, so the spawn, the failed-readiness error and
  `post` all name the same file without passing it between
  them.[^turbo-cache-step][^turbo-server]
- **A `BlobStore` seam and the kit's `BlobEnvelope`.** The handler is written against
  `BlobStore`, which now has one layer behind it, `GitHubCacheBlobStore`; a second store
  would again be a layer and nothing else. The envelope owns framing and revisioning, so an
  unreadable blob is a typed error the handler classifies as a miss.[^handler][^server-config]
- **The port is fixed (`41230`) rather than negotiated**, and a listen that fails says so
  and exits. See
  [one-embedded-server-per-runner](../limitations/one-embedded-server-per-runner.md).[^server-config][^turbo-server]
- **Readiness gates the export.** Nothing is exported for a server that never answered: a
  `TURBO_API` pointing at a dead port would turn every cache call into a connection
  error.[^turbo-cache-step]
- **The state save sits between the spawn and the readiness wait**, so a child that hangs
  half-started is still reapable, and `post`'s reap runs first and
  unconditionally.[^turbo-cache-step][^post]
- **Non-fatal, twice over.** `startTurboCache` catches its own typed channel and defects
  and answers a disabled resolution; the handler catches everything to a `500`; the worker
  exits cleanly on a config or listen failure.[^turbo-cache-step][^turbo-server]
- **Blob keys use a `/` separator, inserted only when a non-empty prefix does not already
  end in one**, and there is no version segment in the key.[^handler]
- **`/events` is authenticated and `/status` is open**, because `/status` is the readiness
  probe the spawning step polls before it has anything to authenticate with.[^handler]
- **`"remote"` is absent from `TurboCacheResolution`**: it is the output vocabulary for
  passthrough, and the rename happens where outputs are written. Passthrough exports no
  `TURBO_API`, since turbo's own default is Vercel's endpoint.[^activation][^turbo-cache-step]
- **Partial passthrough credentials fall through to the embedded server with a warning.**
  A hosted run is past that check already: it named a service, so half a Vercel credential
  is not what it meant and missed.[^activation][^turbo-cache-step]

## Alternatives rejected

- **Keeping the S3 backend with stored keys.** It needs an access key that outlives every
  job, held as an organization secret, which is the credential the design set out to
  remove; and a bucket with no public route serves CI only. With the hosted service
  reached by OIDC, nothing is left for the stored keys to do.[^remote-cache-design]
- **Failing the job when sign-in fails.** A cache is an optimization over a build that
  works without it. A fork's pull request, a job without `id-token: write`, and an outage
  of the service would each turn a slow build into a failed one, which the design names as
  an anti-goal.[^remote-cache-design]
- **A default URL for `turbo-api`.** The action is public: a default would send every
  consumer's OIDC token request to one organization's service. The shared workflows that
  want the service pass its URL.[^remote-cache-design][^inputs]
- **Requiring a Vercel Remote Cache account.** Excludes every consumer without one from
  cross-job artifact sharing.
- **An in-process server, a negotiated port, a hand-rolled artifact frame, an open
  `/events`.** Rejected for the embedded server as the superseded decision records, and
  still rejected.

## Consequences

A job that passes `turbo-api` and has `id-token: write` shares one cache with every other
such job, with no secret to configure. Every other job, and every job whose sign-in fails,
gets what it got before: an embedded server on the GitHub Actions cache, one detached child
that `post` reaps. The hosted path holds no server and no state, so `post` has nothing to
do for it.

A workflow that still passes a `turbo-s3-*` input gets the runner's "unexpected input"
warning and the embedded server.[^changeset] What the hosted path cannot do is in
[hosted-cache-reach](../limitations/hosted-cache-reach.md).

[^activation]: activation
[^sign-in]: sign-in
[^handler]: handler
[^server-config]: server-config
[^turbo-cache-step]: turbo-cache-step
[^turbo-server]: turbo-server
[^inputs]: inputs
[^state]: state
[^post]: post
[^changeset]: changeset
[^e2e-workflow]: e2e-workflow
[^remote-cache-design]: remote-cache-design
[^owner-approval]: owner-approval
[^cache-service]: cache-service
