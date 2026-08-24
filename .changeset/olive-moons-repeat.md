---
"@savvy-web/silk-runtime-action": patch
---

## Dependencies

| Dependency | Type | Action | From | To |
| --- | --- | --- | --- | --- |
| @effected/git | dependency | updated | ^0.9.0 | ^0.10.0 |
| @effected/github | dependency | updated | ^0.7.0 | ^0.8.0 |
| @effected/github-actions | dependency | updated | ^0.9.2 | ^0.10.0 |
| @effected/lockfiles | dependency | updated | ^0.6.3 | ^0.7.0 |
| @effected/npm | dependency | updated | ^0.11.1 | ^0.12.0 |
| @effected/package-json | dependency | updated | ^0.10.2 | ^0.11.0 |

## Refactoring

Adopted the one-class-per-failure error split. `@effected/github-actions@0.10.0` splits four monolithic tagged errors into one
class per failure, each of the old names surviving only as a type-only union
alias. Failures are now matched on `_tag` rather than a `reason` field:

| Was | Now |
| --- | --- |
| `ActionOutputError` | `RunnerFileUnavailableError` \| `RunnerFileWriteError` \| `InvalidOutputNameError` \| `OutputEncodeError` \| `DetachedOutputError` |
| `CacheKeyError` | `CacheKeyReadError` \| `CacheKeyBadPatternError` |
| `DetachedProcessError` | `DetachedLogUnavailableError` \| `DetachedSpawnFailedError` \| `InvalidPidError` \| `DetachedSignalFailedError` \| `DetachedNotReadyError` |
| `BlobEnvelopeError` | `NotABlobEnvelopeError` \| `TruncatedBlobEnvelopeError` \| `UnsupportedBlobEnvelopeVersionError` \| `BlobMetadataDecodeError` \| `BlobMetadataEncodeError` |

Behavior is unchanged; the visible difference is that a lockfile, spawn or
cache-key failure now names its class where it previously named a `reason`
literal — `Lockfile discovery failed (CacheKeyReadError)` rather than
`(readFailed)`. The turbo cache handler still treats every unreadable envelope
as a miss, now by catching all five envelope tags. `ToolInstallerError` also
gained a required `subject`.
