# Contributing to Workflow Runtime Action

Thank you for your interest in contributing! This document provides guidelines
and information for developers working on this action.

## Development Setup

### Prerequisites

* **Node.js** at the version specified in `devEngines.runtime` in `package.json`
* **pnpm** at the version specified in `devEngines.packageManager` in `package.json`

### Installation

```bash
# Clone the repository
git clone https://github.com/savvy-web/silk-runtime-action.git
cd silk-runtime-action

# Install dependencies
pnpm install
```

## Development Workflow

### Making Changes

1. **Create a branch** for your feature or fix
2. **Make your changes** in the `src/` directory
3. **Add or update tests** co-located next to the source module (e.g. `src/services/cache.test.ts`)
4. **Run tests** to ensure everything works
5. **Build the action** (required before committing!)
6. **Commit your changes** including built files

```bash
# Run type checking
pnpm typecheck

# Run tests
pnpm test

# Run linting
pnpm lint:fix

# Build the action (REQUIRED before commit!)
pnpm build

# Commit both source and dist (including .github/actions/local/)
git add src/ dist/ .github/actions/local/
git commit -m "feat: add new feature"
```

### Build Process

The build process compiles TypeScript to JavaScript and creates two copies:

1. **Production build** (`dist/`) - Used by the published action
2. **Local testing copy** (`.github/actions/local/`) - Used by integration
   tests

**Important:** Always run `pnpm build` and commit both directories!

See [CLAUDE.md](CLAUDE.md) for detailed build process documentation.

## Code Quality Standards

### TypeScript

* **Module system:** ESNext with bundler resolution
* **Target:** ES2022
* **Strict mode:** Enabled
* **Import extensions:** Required (`.js` for all imports, even TypeScript files)

### Biome Configuration

* **Indentation:** Tabs, width 2
* **Line width:** 120 characters
* **Import organization:** Lexicographic order
* **Import extensions:** Forced `.js` extensions
* **Import types:** Separated type imports
* **Node.js imports:** Must use `node:` protocol
* **Type definitions:** Prefer `type` over `interface`

### Common Commands

```bash
# Linting
pnpm lint              # Check with Biome
pnpm lint:fix          # Auto-fix Biome issues
pnpm lint:md           # Lint markdown
pnpm lint:md:fix       # Fix markdown

# Type Checking
pnpm typecheck         # Run TypeScript compiler

# Testing
pnpm test              # Run unit tests with coverage
pnpm test --watch      # Run tests in watch mode

# Building
pnpm build             # Build action with @savvy-web/github-action-builder
```

## Testing

### Unit Tests

Unit tests are co-located with their source modules in `src/` (e.g. `src/services/cache.test.ts`) and use Vitest:

```bash
pnpm test
```

See [src/CLAUDE.md](src/CLAUDE.md) for testing guidelines.

### Integration Tests

Integration tests use real GitHub Actions workflows with test fixtures in
`__fixtures__/`:

```bash
# Push to trigger workflow tests
git push
```

See [.github/workflows/CLAUDE.md](.github/workflows/CLAUDE.md) for workflow
testing documentation.

### Testing the Action Locally

The action can be tested in GitHub Actions workflows:

#### Quick Demo

**Workflow:** `.github/workflows/demo.yml`

Demonstrates usage patterns:

* Auto-detect configuration from package.json devEngines
* Skip dependency installation
* Biome and Turbo integration

**To run:** Actions → "Demo - Quick Test" → Run workflow

#### Comprehensive Tests

**Workflow:** `.github/workflows/test.yml`

Full test suite across:

* Multiple operating systems (Ubuntu, macOS, Windows)
* Multiple package managers (npm, pnpm, yarn)
* Multiple runtimes (Node.js, Bun, Deno)
* Cache testing (create and restore)

**To run:** Automatically runs on push/PR

## Project Structure

```text
.
├── src/                          # TypeScript source code (tests co-located as *.test.ts)
│   ├── main.ts                   # Thin entry: Action.run(program, { layer: MainLive })
│   ├── post.ts                   # Post-action hook (cache save, turbo server teardown)
│   ├── program.ts                # Main Effect pipeline
│   ├── state.ts                  # Cross-phase state schemas (CacheState, TurboServerState)
│   ├── turbo-server.ts           # Detached turbo remote-cache server entry
│   ├── layers/app.ts             # MainLive layer composition
│   ├── services/                 # Effect services
│   │   ├── runtime-installer.ts  # RuntimeInstaller service + descriptor layers
│   │   ├── cache.ts              # Dependency cache operations (restore/save)
│   │   ├── config-loader.ts      # devEngines parsing and detection helpers
│   │   ├── summary.ts            # Job-summary panel and step-line formatters
│   │   └── turbo-cache/          # Embedded turbo remote cache implementation
│   ├── descriptors/              # Per-runtime download descriptors (node, bun, deno, biome)
│   ├── schemas/domain.ts         # Effect Schema definitions
│   └── errors/errors.ts          # TaggedError hierarchy
├── dist/                         # Compiled JavaScript (committed!)
│   ├── main.js
│   ├── post.js
│   ├── turbo-server.js
│   └── package.json
├── __fixtures__/                 # Integration test fixtures
├── .github/
│   ├── actions/
│   │   ├── test-fixture/         # Unified test helper
│   │   └── local/                # Local copy of action for testing (committed!)
│   └── workflows/                # CI/CD workflows
├── action.config.ts              # Build configuration for github-action-builder
├── action.yml                    # Action definition
├── package.json                  # Dependencies and scripts
└── CLAUDE.md                     # Detailed documentation
```

## Documentation

This repository uses modular documentation:

* **[CLAUDE.md](CLAUDE.md)** - Comprehensive developer documentation
* **[src/CLAUDE.md](src/CLAUDE.md)** - Source code architecture and testing guidelines
* **[**fixtures**/CLAUDE.md](__fixtures__/CLAUDE.md)** - Test fixtures
* **[.github/workflows/CLAUDE.md](.github/workflows/CLAUDE.md)** - Workflow
  testing patterns

## Release Process

This project uses [Changesets](https://github.com/changesets/changesets) for
version management:

### Creating a Changeset

```bash
pnpm changeset
```

Follow the prompts to:

1. Select the type of change (patch, minor, major)
2. Provide a description of the change
3. Commit the changeset file

### Release Workflow

1. **Create changeset** for your changes
2. **PR is merged** to main
3. **Changesets bot** creates a release PR
4. **Merge release PR** to publish:
   * Updates version in `package.json`
   * Updates `CHANGELOG.md`
   * Creates GitHub release with tags
5. **Users reference by tag:**

   ```yaml
   - uses: savvy-web/silk-runtime-action@v1
   - uses: savvy-web/silk-runtime-action@v1.2.3
   ```

## Common Issues

### dist/ not updated

**Issue:** Changes don't take effect in CI

**Solution:** Always run `pnpm build` and commit `dist/` files

```bash
pnpm build
git add dist/ .github/actions/local/
git commit --amend --no-edit
```

### Import errors

**Issue:** "Module not found" or import errors

**Solution:** Always use `.js` extensions and `node:` protocol

```typescript
// Correct
import { loadPackageJson } from "./config.js";
import { readFile } from "node:fs/promises";

// Incorrect
import { loadPackageJson } from "./config";
import { readFile } from "fs/promises";
```

### Linting errors

**Issue:** Biome or markdown linting failures

**Solution:** Run the fix commands

```bash
pnpm lint:fix       # Fix Biome issues
pnpm lint:md:fix    # Fix markdown issues
```

## Pull Request Guidelines

### Before Submitting

* [ ] All tests pass (`pnpm test`)
* [ ] Type checking passes (`pnpm typecheck`)
* [ ] Linting passes (`pnpm lint`)
* [ ] Action is built (`pnpm build`)
* [ ] Both `dist/` and `.github/actions/local/` are committed
* [ ] Changeset created (`pnpm changeset`)
* [ ] Documentation updated if needed

### PR Description

Please include:

* **What** changed
* **Why** it changed
* **How** to test the changes
* **Breaking changes** (if any)

### Commit Messages

We follow conventional commit format:

* `feat:` - New features
* `fix:` - Bug fixes
* `docs:` - Documentation changes
* `test:` - Test additions or changes
* `chore:` - Maintenance tasks
* `refactor:` - Code refactoring

## Code of Conduct

Be respectful and professional in all interactions. We're here to build great
tools together!

## Questions?

* **Issues:** [GitHub Issues](https://github.com/savvy-web/silk-runtime-action/issues)
* **Discussions:** [GitHub Discussions](https://github.com/savvy-web/silk-runtime-action/discussions)

## License

By contributing, you agree that your contributions will be licensed under the
MIT License.

---

Thank you for contributing!
