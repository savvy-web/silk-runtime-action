# Limitation

* [ACTIONS_RUNTIME_TOKEN expires under a long-running embedded Turbo server](actions-runtime-token-lifetime.md) - The GitHub Actions cache backend for the embedded Turbo server captures a short-lived runtime token at spawn time, so a very long job can lose cache writes partway through with no refresh channel to recover them.
* [One embedded Turbo cache server per runner](one-embedded-server-per-runner.md) - The embedded Turbo remote-cache server listens on a fixed port, so a second concurrent job on the same runner cannot start its own server and runs without a remote cache instead.
* [kcov collects no coverage on macOS, and none at all on Windows](kcov-platform-coverage.md) - kcov is installed on every supported platform, but SIP blocks the ptrace it needs on macOS, and it refuses to build at all on Windows before the cache is ever consulted.
* [post can seal a half-populated dependency cache after a failed install](post-can-seal-a-half-populated-archive.md) - post runs and saves the dependency cache even when main failed partway through the install, so a workflow that dies mid-install can seal an incomplete node_modules under the primary cache key.
