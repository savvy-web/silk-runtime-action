---
"@savvy-web/silk-runtime-action": minor
---

## Refactoring

Migrates the action's internals from Effect v3 to Effect v4 (`effect@4.0.0-beta.98`). This is an internal framework upgrade — the action's public contract is unchanged. Inputs and outputs (`action.yml`), cache-key generation, the turbo remote-cache wire format, and all error messages are identical to the previous release. Existing workflows need no changes.

Under the hood:

* `@effect/platform` is dissolved into core `effect` in v4 — `FileSystem` and `Path` now import from `effect`, and Node platform layers come from `@effect/platform-node` (`NodeFileSystem.layer`, `NodeHttpClient.layerUndici`).
* Services move from `Context.Tag`/`Context.GenericTag` to class-based `Context.Service` with exported `*Shape` companion types (e.g. `RuntimeInstaller` + `RuntimeInstallerShape`).
* Schema, error, and combinator call sites are updated to the v4 surface (`Schema.Literals`, `Schema.TaggedErrorClass`, `.check(...)` filters, `Schema.decodeUnknownEffect`, `Effect.catch`, `Cause.findErrorOption`, string `LogLevel` values).
* JSONC parsing moves from `jsonc-effect` to `@effected/jsonc`.

The full v4 suite (217 tests) passes and the bundled `dist/` is rebuilt against the migrated source.

## Dependencies

| Dependency                         | Type          | Action  | From    | To             |
| :--------------------------------- | :------------ | :------ | :------ | :------------- |
| effect                             | dependency    | updated | 3.22.0  | 4.0.0-beta.98  |
| @effect/platform-node              | dependency    | updated | 0.107.0 | 4.0.0-beta.98  |
| @savvy-web/github-action-effects   | dependency    | updated | 2.4.0   | 3.0.1          |
| @effected/jsonc                    | dependency    | added   | —       | 0.2.0          |
| @effect/platform                   | dependency    | removed | 0.96.3  | —              |
| @effect/cluster                    | dependency    | removed | 0.59.0  | —              |
| @effect/rpc                        | dependency    | removed | 0.75.1  | —              |
| @effect/sql                        | dependency    | removed | 0.51.1  | —              |
| jsonc-effect                       | dependency    | removed | 0.3.1   | —              |
| @savvy-web/github-action-builder   | devDependency | updated | 1.1.2   | 2.0.2          |
| @savvy-web/silk                    | devDependency | updated | 2.4.4   | 3.0.2          |
| @vitest-agent/plugin               | devDependency | updated | 1.1.9   | 2.0.0          |
