---
"@savvy-web/silk-runtime-action": patch
---

## Maintenance

The workflow log is restructured onto the `@effected/github-actions` step log, so a run reads as a short summary you can expand rather than one long stream.

* The main run prints two bold phase headings, **Detect** and **Install**, with one result line per step marked with a check, a warning, or a cross.
* Step detail is folded when the step succeeds and unfolded when it fails. A step still running after 30 seconds, or any step under `RUNNER_DEBUG`, streams its output live.
* Each runtime installs as its own nested step. The `Detected ...` headline is an unfolded line in the Detect phase, and the closing `Runtime Setup Complete` summary is an unfolded phase.
* The dependency install's output is now piped through the logger instead of inherited, so its transcript folds under the `Install dependencies` step.
* A Biome, BATS, or kcov install that degrades to a warning now marks its line with a warning instead of a check.
* The post step runs each cache save and the turbo server stop as steps. The `Turbo remote cache activity` step's result line shows the hit and miss totals.
