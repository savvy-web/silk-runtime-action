# DataModel

* [Cache config — key formats, ladders, lockfile patterns, and archived paths](cache-config.md) - The pure decisions every cache key and archived path set derives from, and what breaks when one is wrong.
* [Cross-phase state — STATE_KEYS and the four Schema.Class bundles](cross-phase-state.md) - What main writes and post reads across the GitHub Actions main/post process boundary, and what breaks when an entry's shape is wrong.
* [Runtime descriptors — the per-tool download plans installs derive from](runtime-descriptors.md) - RuntimeDescriptor and RuntimePlan, the per-runtime tables, and the pinned BATS/kcov versions every install reads from.
