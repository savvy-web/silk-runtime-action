---
type: Limitation
title: What the hosted turbo cache cannot reach — forks, jobs without id-token, long jobs, and the prefix input
description: A fork's pull request and any job without id-token write always take the embedded fallback, turbo cannot refresh the hosted cache token mid-job so a job that outlives it loses the cache late, and the hosted service ignores turbo-cache-prefix.
status: draft
x-okfit-bounds: ../modules/turbo-cache-server.md
generated:
  by: okfit/claude-code
  at: 2026-11-22T05:18:42Z
sources:
  - id: sign-in
    resource: ../../src/turbo-cache/sign-in.ts
  - id: turbo-cache-step
    resource: ../../src/steps/turbo-cache.ts
  - id: layers-app
    resource: ../../src/layers/app.ts
  - id: e2e-workflow
    resource: ../../.github/workflows/test-turbo-cache.yml
  - id: remote-cache-design
    resource: "the hosted remote build cache design of 2026-11-21, sections Sign-in, Lanes and Constraints; a git-ignored file in savvy-web/infra, moving to savvy-web/cache"
    title: "Hosted remote build cache (savvy-web/cache): design"
    last_modified: 2026-11-21T00:00:00Z
tags:
  - caching
  - ci
  - github
x-okfit-integrity:
  generated:
    body: 3548cf629c1883bc
---

# What the hosted turbo cache cannot reach — forks, jobs without id-token, long jobs, and the prefix input

`turbo-api` selects a hosted cache the job signs in to with its GitHub OIDC token (see
[turbo-cache-backends](../decisions/turbo-cache-backends.md)). Three things bound what that
mode gives a job. None of them fails a job. As of 2026-11-22 the mode is on an unreleased
branch and its integration jobs have not run, so the symptoms below are read from the code
and the service's design, not observed in CI.

## A fork's pull request, and any job without `id-token: write`, always take the fallback

**Trigger.** The workflow passes `turbo-api`, and either the run is a pull request from a
fork, or the job does not have the `id-token: write` permission.

**Symptom.** `turbo-cache-backend` is `github`, not `hosted`, and the step logs one
warning: `Hosted turbo cache sign-in failed (oidc: unavailable); using the embedded cache
server on the GitHub Actions cache instead.` The job passes, with the embedded server's
cache.[^turbo-cache-step][^sign-in]

**Why.** GitHub issues a fork's run no OIDC token whatever the workflow file asks for, and
a job without the permission is published no token service. `OidcTokenIssuer`'s layer is
built for every run and fails at use, which sign-in reports as `oidc` and the step answers
with the embedded server.[^layers-app][^remote-cache-design] The workflow's own
`hosted-fallback` job exists to pin exactly this, and `hosted-double-build` is skipped on a
fork for the same reason.[^e2e-workflow]

**Why this is acceptable.** The permission is the caller's to grant, and a job should get it
only when it builds code the workflow's owner trusts: it lets a job mint a token for any
audience. A job without it loses nothing it had before the hosted mode existed. What it
does not get is the shared cache: artifacts it writes go to the GitHub Actions cache, where
jobs that signed in never look, and the reverse.

## Turbo cannot refresh the cache token mid-job

**Trigger.** A job that signed in runs longer than the cache token lives. The service sets
the lifetime, six hours in its design, chosen as the longest a GitHub-hosted job
runs.[^remote-cache-design] A self-hosted runner's job can outlive it.

**Symptom.** Cache requests late in the job are refused by the service, while everything
earlier succeeded. Unlike the embedded server's expired runtime token (see
[actions-runtime-token-lifetime](./actions-runtime-token-lifetime.md)), nothing in this
action sees those refusals or names them: turbo talks to the service directly.

**Why.** The action signs in once, in `main`, and exports `TURBO_TOKEN` through
`GITHUB_ENV`. Turbo reads the variable when each `turbo run` starts and has no way to ask
for a new one, and the action has no later step in which to sign in again. `signIn` returns
the service's `expiresAt` and nothing acts on it.[^sign-in][^turbo-cache-step]

**What a fix would take.** A second sign-in needs a point in the job to run from, which an
action with only a `main` and a `post` phase does not have. Nothing has been attempted.

## The hosted service ignores `turbo-cache-prefix`

**Trigger.** A workflow sets `turbo-cache-prefix` to keep two sets of artifacts apart, and
also passes `turbo-api`.

**Symptom.** On a job that signs in, the prefix does nothing: both sets share whatever
namespace the service gives the job. On a job that falls back, the prefix works as it
always has, so the same workflow isolates its artifacts on a fork's pull request and does
not on a branch build.

**Why.** The prefix is passed in one place, the embedded server's `TURBOGHA_PREFIX`. The
hosted path sends the service an OIDC token and nothing else, and the service derives where
a job reads and writes from that token alone; it also ignores turbo's own team and slug,
which is why the action exports the fixed `TURBO_TEAM=silk`.[^turbo-cache-step][^remote-cache-design]

**Why this is acceptable.** The service's namespaces are a security boundary it decides
from verified claims, and a caller-supplied prefix must not be able to move a job across
it. A workflow that needs a private namespace within a repository has no way to ask for
one in hosted mode; it can leave `turbo-api` unset for those jobs.

[^sign-in]: sign-in
[^turbo-cache-step]: turbo-cache-step
[^layers-app]: layers-app
[^e2e-workflow]: e2e-workflow
[^remote-cache-design]: remote-cache-design
