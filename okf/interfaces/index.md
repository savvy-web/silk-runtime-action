# Interface

* [Action contract — inputs, outputs, and exported environment](action-contract.md) - The inputs, outputs, and exported environment a consuming workflow can rely on.
* [Turbo artifacts wire protocol — routes, auth, keys, and metadata](turbo-artifacts-protocol.md) - The /v8/artifacts HTTP contract the embedded turbo remote-cache server implements, and the framing rules a client depends on.
* [Turbo worker environment — the main-to-worker handoff contract](turbo-worker-environment.md) - The TURBOGHA\_\* environment variables the detached turbo cache server reads, and how they are assembled and consumed.
* [devEngines manifest — the config shape consumers must satisfy](dev-engines-manifest.md) - What a consuming repository's package.json devEngines block must look like, and how it normalizes.
