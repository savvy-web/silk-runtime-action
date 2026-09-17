# Runbook

* [Add a runtime](add-a-runtime.md) - The full set of places a new devEngines.runtime value (beyond node, bun, deno) has to be added, derived from the code rather than from prose, since a parity test fails until every one of them agrees.
* [Adopt a first-party release after a dogfood round](adopt-a-first-party-release.md) - How to take a released version of an @effected/\* package or the github-action-builder out of a dogfood link and back onto its published range, verified on a cold registry install.
* [Debug a cache miss or partial hit](debug-a-cache-miss.md) - How to read the debug log restore-cache.ts emits, interpret the one-line verdict, and trace an unexpected miss or partial hit back to a specific key segment or path pattern.
* [Release dev to main](release.md) - The full path from a changeset on dev to a published release, the shared workflow it delegates to, and the branch-sync jobs that keep dev and main coherent afterward.
