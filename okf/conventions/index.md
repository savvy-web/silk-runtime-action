# Convention

* [A detached worker never gets the real ActionOutputs layer](detached-worker-outputs-layer.md) - The detached turbo-server process must compose ActionOutputs.layerDetached, never the real ActionOutputs.layer, because masking on a detached process's stdout leaks rather than protects.
* [Commit source and dist together](commit-source-and-dist-together.md) - Every commit that touches src/ must also carry a rebuilt dist/ and .github/actions/local/, be GPG-signed with the maintainer's verified key, and land on dev rather than main.
* [Cross-phase state's encoded form must be plain JSON](plain-json-cross-phase-state.md) - Every Schema field that crosses the main-to-post boundary must encode to plain JSON, and must be tested against the real ActionState layer, never an in-memory double.
* [Dependency honesty](dependency-honesty.md) - Every declared @effected/* dependency must be imported by src/ or be a required peer of one that is, and no resolved version ever gets written into prose.
* [Log levels and buffering](log-levels-and-buffering.md) - Which Effect.log* level a line belongs at, which steps buffer their transcript, and why warnings are never buffered.
* [PATH publication rules](path-publication-rules.md) - addPath only reaches later workflow steps, so this-process probes must use absolute paths and spawned children need an explicit, correctly-cased PATH prepend.
* [Prose is parity surface](prose-is-parity-surface.md) - One formatter per fact, kept in a pure module, and pinned codepoint-verbatim against action.yml and the emitted prose because a consumer reads it as a contract.
* [The step-contract rule](step-contract.md) - Every module under src/steps/ freezes four things, and touching any one is a contract change.
* [Unit test conventions](unit-test-conventions.md) - How src/ tests are organized, doubled, and asserted, and which operations a unit test must never perform for real.
* [Verification means the built artifact](verify-against-the-built-artifact.md) - For any literal that must reach disk verbatim, check it against the built dist bundle, never against source, tsc, Biome or the unit tests alone.
