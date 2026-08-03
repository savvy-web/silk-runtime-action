# .github/workflows/CLAUDE.md

GitHub Actions workflow testing strategy and reusable composite actions.

**See also:** [Root CLAUDE.md](../../CLAUDE.md) |
[**fixtures**/CLAUDE.md](../../__fixtures__/CLAUDE.md) for available test
fixtures.

## Overview

This directory contains GitHub Actions workflows for testing the runtime action
using a **matrix-based testing approach** with a **unified test-fixture
composite action** that handles setup, execution, and verification.

## Test Workflows

### [test.yml](test.yml)

Main test workflow that runs on push and pull requests. Includes comprehensive
test coverage:

* **test-node-create-cache** - Node.js tests creating dependency cache
* **test-node-restore-cache** - Node.js tests restoring from cache
* **summary** - Aggregates test results and reports overall status

### [test-turbo-cache.yml](test-turbo-cache.yml)

Exercises the embedded Turbo remote-cache server end to end: a within-job
double build on the GitHub backend, a cross-job cache hit, an S3 backend run
against MinIO, and a real-S3 job gated on the `TURBO_S3_*` secrets being
present. Fixtures install their own dependencies in `run:` steps
(`install-deps: "false"`) because `uses:` steps always execute at the
repository root.

## Reusable Composite Actions

### [test-fixture](../actions/test-fixture/action.yml)

Complete test workflow that sets up a fixture, runs the runtime action, and
verifies outputs - all in one action.

**Purpose:** Simplify testing by combining fixture setup, action execution,
and output validation into a single reusable action.

**How it works:**

1. **Setup fixture** (Python script):
   * Cleans workspace by removing all files except `.github`, `.git`, and
     `__fixtures__`
   * Copies all files from the fixture directory to the repository root
   * Removes `__fixtures__` directory to prevent glob pattern interference

2. **Run runtime action** - Executes the runtime setup action using
   `.github/actions/local` (the local copy built by `pnpm build`)

3. **Verify outputs** (Python script) - Compares actual vs expected values and
   generates summary

4. **Fail if mismatches** - Exits with error if any validation fails

**Inputs:**

* `fixture` (required) - Name of the fixture directory in `__fixtures__/`
* `title` (required) - Title for the test results section (including emoji)
* Feature inputs (optional): `biome-version`, `install-deps`
* Turbo inputs (optional): `turbo-token`, `turbo-team`
* Expected values for validation (all optional):
  * `expected-node-version`, `expected-node-enabled`
  * `expected-bun-version`, `expected-bun-enabled`
  * `expected-deno-version`, `expected-deno-enabled`
  * `expected-package-manager`, `expected-package-manager-version`
  * `expected-biome-version`, `expected-biome-enabled`
  * `expected-turbo-enabled`
  * `expected-cache-hit`

**Example usage:**

```yaml
- name: Test PNPM
  uses: ./.github/actions/test-fixture
  with:
    fixture: node-pnpm
    title: "PNPM Test Results"
    expected-package-manager: pnpm
    expected-node-enabled: "true"
```

**Why this approach?**

* **Simple** - One action instead of three separate steps
* **Fast** - Files copied in-place, action runs in same directory
* **Isolated** - Repository config removed, only fixture config remains
* **Comprehensive** - Combines setup, execution, and validation

### [local](../actions/local/)

Local copy of the compiled action used by `test-fixture`. Built automatically
by `pnpm build` from `action.config.ts`. This copy is committed to git along
with `dist/` and must be rebuilt whenever source changes are made.

## Matrix-Based Testing Pattern

All test jobs use a matrix strategy to test multiple configurations:

```yaml
test-node:
  name: Node.js - ${{ matrix.name }}
  runs-on: ubuntu-latest
  strategy:
    fail-fast: false
    matrix:
      include:
        - name: NPM
          fixture: node-npm
          expected-package-manager: npm
          title: "NPM Test Results"

        - name: PNPM
          fixture: node-pnpm
          expected-package-manager: pnpm
          title: "PNPM Test Results"

  steps:
    - name: Checkout
      uses: actions/checkout@v7

    - name: Test fixture
      uses: ./.github/actions/test-fixture
      with:
        fixture: ${{ matrix.fixture }}
        title: ${{ matrix.title }}
        expected-node-enabled: ${{ matrix.expected-node-enabled || '' }}
        expected-package-manager: ${{ matrix.expected-package-manager || '' }}

    - name: Test runtime
      if: matrix.test-command != ''
      run: ${{ matrix.test-command }}
```

## Standard Test Pattern

Every test follows this pattern:

1. **Checkout** - Check out the repository
2. **Test fixture** - Use `test-fixture` action to setup environment, run
   action, and verify outputs
3. **Test runtime** - Run commands to verify runtime is working (optional)
4. **Additional verification** - Custom verification steps (optional)

## Test Scenarios

### Node.js Cache Tests

Tests are split into two jobs that share cache state:

* **Create Cache** (`test-node-create-cache`) - Tests npm, pnpm, yarn, and
  multi-runtime on all platforms (Ubuntu, macOS, Windows). First run creates
  dependency cache.
* **Restore Cache** (`test-node-restore-cache`) - Same tests but restores from
  cache created in previous job. Validates cache effectiveness.

### Cache Testing Mode

The `test-fixture` action supports a special cache testing mode via the
`test-cache: "true"` input:

1. **First run** - Installs dependencies, saves to cache
2. **Verify dependencies** - Checks that dependencies were installed
3. **Clear node_modules** - Removes installed dependencies
4. **Second run** - Should restore from cache
5. **Verify cache** - Checks that cache was restored correctly

## Adding New Tests

### Option 1: Add to Existing Matrix

Add a new entry to an existing matrix:

```yaml
matrix:
  include:
    # ... existing entries ...

    - name: My New Test
      fixture: my-fixture
      expected-package-manager: npm
      title: "My New Test Results"
```

### Option 2: Create New Test Job

Create a new test job for complex scenarios:

```yaml
test-my-feature:
  name: My Feature Test
  runs-on: ubuntu-latest
  steps:
    - name: Checkout
      uses: actions/checkout@v7

    - name: Test fixture
      uses: ./.github/actions/test-fixture
      with:
        fixture: my-fixture
        title: "My Feature Test Results"
```

### Option 3: Create New Fixture

If you need a new configuration, create a fixture in [../../**fixtures**/](../../__fixtures__/):

```bash
mkdir -p __fixtures__/my-new-fixture
```

Then add a `package.json` with `devEngines.packageManager` and `devEngines.runtime` fields, and reference the fixture in the workflow.

## Debugging Test Failures

### View GitHub Actions Logs

1. Go to the Actions tab in GitHub
2. Click on the failing workflow run
3. Click on the failing job
4. Expand the failing step to see details

### Common Issues

| Error | Cause | Solution |
| --- | --- | --- |
| `Fixture 'X' not found` | Fixture doesn't exist | Create in `__fixtures__/` |
| `Expected X but got Y` | Output mismatch | Check action or update expected |
| `Command not found` | Runtime not installed | Check runtime installation |
| `Permission denied` | File permissions | Check fixture permissions |

### Local Testing with act

You can run workflows locally using [nektos/act](https://github.com/nektos/act):

```bash
# Install act
brew install act

# Run all tests
act -j test-node
```

## Matrix Strategy Best Practices

1. **Use fail-fast: false** - Continue testing other matrix entries even if one fails
2. **Use descriptive names** - Make matrix entry names clear and specific
3. **Group related tests** - Keep similar tests in the same matrix job
4. **Validate outputs** - Always verify action outputs match expectations
5. **Keep fixtures simple** - Minimal configuration needed for the test

## Test Summary Job

The `summary` job aggregates results from all test jobs and uses `if: always()`
to ensure it runs even when tests fail. It reports overall pass/fail status
as a GitHub step summary.

## Related Documentation

* [Root CLAUDE.md](../../CLAUDE.md) - Repository overview
* [**fixtures**/CLAUDE.md](../../__fixtures__/CLAUDE.md) - Available test fixtures
* [src/CLAUDE.md](../../src/CLAUDE.md) - Source code architecture (unit tests live in `__test__/unit/`)
* [GitHub Actions Documentation](https://docs.github.com/en/actions) - GitHub Actions reference
* [nektos/act](https://github.com/nektos/act) - Run GitHub Actions locally
