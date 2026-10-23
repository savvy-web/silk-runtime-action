---
"@savvy-web/silk-runtime-action": patch
---

## Bug Fixes

* The embedded turbo cache server's per-run credential is now masked before it is exported, so `TURBO_TOKEN` and `TURBO_TEAM` no longer appear in plain text in the env block every later step logs.
