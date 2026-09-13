# Consumer

* [spencerbeggs/effected](effected.md) - The reference consumer and the dogfood upstream — the repository whose fixture layout, dependency provenance, and one production incident have shaped this action's cache logic directly.
* [spencerbeggs/vitest-bats](vitest-bats.md) - The consumer of the BATS and kcov toolchains this action provisions — what it reads, how it discovers helper libraries without reading the variable this action exports for them, and why bats detection needs two independent signals.
