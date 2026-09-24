---
title: devEngines manifest — the config shape consumers must satisfy
description: What a consuming repository's package.json devEngines block must look like, and how it normalizes.
status: draft
type: Interface
kind: config
resource: ../../src/schema/domain.ts
generated:
  by: okfit/claude-code
  at: 2026-09-24T01:33:32Z
  body_sha256: 4d39887d96c939640232490d15fdc6309d5747133b91853ebcd6bbc1025b6392
sources:
  - id: domain-schema
    resource: ../../src/schema/domain.ts
  - id: domain-test
    resource: ../../__test__/unit/schema/domain.test.ts
---

# devEngines manifest — the config shape consumers must satisfy

A consuming repository's root `package.json` is the action's only source of runtime and
package-manager version configuration. There are no version inputs on the action itself —
see [action-contract](./action-contract.md) — precisely so `package.json` and workflow files
cannot drift apart.

## Required shape

```json
{
  "devEngines": {
    "packageManager": { "name": "pnpm", "version": "10.20.0", "onFail": "error" },
    "runtime": [
      { "name": "node", "version": "24.11.0", "onFail": "error" },
      { "name": "bun", "version": "1.3.3", "onFail": "error" }
    ]
  }
}
```

`packageManager` is a single object; `runtime` is one object **or** a non-empty array of
them.[^domain-schema] `RuntimeConfig` is the fully-decoded form: one `PackageManagerSpec` plus
a `Schema.NonEmptyArray<RuntimeSpec>` (`domain.ts:85-88`).

## Names

`RuntimeName` accepts `node`, `bun`, `deno` (`domain.ts:7`). `PackageManagerName` accepts
`npm`, `pnpm`, `yarn`, `bun`, `deno` — **five** values, not four, because `deno` is a package
manager as well as a runtime and `action.yml` documents the `package-manager` output over that
same five-name set; dropping the fifth would be a silent parity break (`domain.ts:10-20`).

## Versions must be exact

`AbsoluteVersion` is `SemVer.ExactVersionString` from `@effected/semver` — no range operators,
no wildcards, no partial versions (`^24.0.0`, `24.x`, `1.2`, `*` are all rejected)
(`domain.ts:22-45`). The `Type` stays `string` rather than transforming into a `SemVer`
instance, because `devEngines` values are stored and re-serialized as plain strings, and the
accepted string is interpolated verbatim into runtime download URLs — padding or a range
operator has to fail here rather than turn into a 404 later. Build metadata is allowed and
exercised: pnpm carries an integrity hash in its `devEngines` version
(`11.8.0+sha512.c1f5…`).

## Normalization rules

- A single `runtime` object normalizes to an array of one; nothing else changes.
- Duplicate runtime entries survive normalization — a manifest naming the same runtime twice
  is not de-duplicated by the schema (installing it twice is `install-runtimes`'s concern, not
  this schema's).
- Declaration order is preserved.
- Names are case-sensitive and no field is defaulted.
- `runtime: []` is a decode failure, which is what keeps the decoded `runtimes` array
  non-empty by construction rather than by a runtime check downstream.
- A top-level corepack `packageManager` pin (the field Corepack itself reads) is **ignored**
  — `Schema.Struct` decodes only the keys it declares and discards every other manifest key
  along with it, so a repository carrying both a corepack pin and a `devEngines` block gets
  its runtime and package-manager versions from `devEngines` alone.
- `onFail` (`warn | error | ignore | download`) is parsed on both `packageManager` and each `runtime`
  entry, but the action never acts on it — it decodes and is otherwise inert.

## Failure

Every rejection — a missing `devEngines` field, an unsupported name, a semver range where an
absolute version belongs, `onFail: "download"` under any manager but pnpm — collapses into one
`ConfigError` with `reason: "invalid-dev-engines"`. The parse issue is rendered into the message,
naming the field path (`at ["devEngines"]["packageManager"]["version"]`), because the action's
failure annotation prints the message alone; it is also carried as `cause`. A missing
or unreadable `package.json` and a JSON parse failure get their own reasons,
`missing-package-json` and `malformed-json` respectively, so a consumer's failure message can
tell "no manifest" apart from "manifest present but decode failed."

## A root manifest is a hard requirement

`load-config` reads `package.json` from the working directory — there is no search upward and
no support for a manifest that lives anywhere else. A monorepo with several independent
projects, each carrying its own `devEngines`, is not a shape this interface serves; a
consumer in that position is expected to run the action once per project directory rather
than expect discovery.

[^domain-schema]: domain-schema
