---
"@savvy-web/silk-runtime-action": patch
---

## Refactoring

Adopts three members `@effected/github-actions` 0.7.0 added for this action, replacing local constructs that existed only because the kit did not ship them. No behavior changes.

* The turbo cache server's readiness check is now `DetachedProcess.httpProbe`, replacing a local probe. Refused connections, transport errors and non-2xx answers still all mean "not ready yet", and a server that never answers still degrades to a cacheless run
* The detached-process test seams — one in the main phase, one in `post` — collapse onto the kit's `DetachedProcessOps` / `makeTestOps`
* Secrets supplied to the action are registered with the runner's log filter through `Secret.mask`, which masks and returns nothing, rather than through a declassification member whose plaintext was discarded

## Dependencies

| Dependency | Type | Action | From | To |
| :--------- | :--- | :----- | :--- | :- |
| @effected/github-actions | dependency | updated | 0.6.1 | 0.7.0 |

## Tests

* The readiness cases run against a stubbed `HttpClient` instead of standing up a loopback server, and now assert the probe's exact URL against the exported `TURBO_API`
