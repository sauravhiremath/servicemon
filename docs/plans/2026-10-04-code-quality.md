# Linting and formatting

> Language: ASD-STE100 style.

## Goal

Add Oxlint and Oxfmt with small configs based on active upstream projects.

## Acceptance criteria

- Local commands lint and format source, tests, scripts, and supported config files.
- CI rejects lint findings and formatting differences.
- EditorConfig and Oxfmt agree on indentation and quotes.
- Generated output and the npm lockfile are not formatted.
- Existing build, tests, and CLI smoke checks still pass.

## Existing behavior

The project uses npm, TypeScript, React, Tailwind, Vitest, and Playwright.
There are no lint or format commands.
EditorConfig requests two spaces and single quotes.
Source files use semicolons.
CI installs with `npm ci --ignore-scripts` before type checking and tests.

## Decisions

Use stable npm releases. Registry results at planning time are Oxlint 1.86.0 and Oxfmt 0.71.0.
Keep JSON configs and local JSON schema references.

Use [Vite's formatter config](https://github.com/vitejs/vite/blob/main/.oxfmtrc.json) for single quotes and grouped import sorting.
Keep semicolons and use Oxfmt's default 100-column width.
Keep package field sorting off, as Vite does.
Preserve Markdown prose wrapping.
Enable Tailwind class sorting against `src/web/styles.css`, including `cn`, `clsx`, and `cva` calls.

Use [Oxc's lint config](https://github.com/oxc-project/oxc/blob/main/oxlintrc.json) for correctness errors and explicit native plugins.
Enable TypeScript, Unicorn, Oxc, React, and JSX accessibility plugins.
Require valid React hook calls and complete hook dependencies.
Leave React Compiler rules off because this project does not use React Compiler.
Leave semantic tag preferences off; valid ARIA roles do not require tag changes.
Permit empty object parameters for Playwright fixture declarations.
Do not copy Oxc's console ban, performance category, generated-code exclusions, or experimental type checker.
Keep `npm run typecheck`.
Do not exclude this project's tests.
Fix findings without broad rule suppressions or unsafe automatic fixes.

[Oxfmt configuration](https://oxc.rs/docs/guide/usage/formatter/config) defines EditorConfig support.
Remove unsupported EditorConfig quote properties; put quote style in Oxfmt.
[Oxfmt sorting](https://oxc.rs/docs/guide/usage/formatter/sorting) defines import and Tailwind settings.

## Out of scope

Git hooks, shared config packages, ESLint, Prettier, and build-tool changes are out of scope.

## Interfaces and data flow

Add `lint`, `lint:fix`, `format`, and `format:check` npm scripts.
The lint commands reject warnings as well as errors, as requested.
CI runs `lint` and `format:check` after dependency installation.
Oxfmt uses `.editorconfig` for basic editor settings.
Both tools respect generated-output exclusions.

## Error behavior

Invalid configs, lint findings, and formatting differences cause nonzero check exits.
Check commands do not change files. Both tools use the current directory without an explicit path.
Fix commands change only supported project files.

## Test strategy

Use real tool commands and temporary files to prove positive and negative cases.
Do not add permanent tests for package scripts or config text.
Run type checking, existing tests, and the CLI smoke scenario after normalization.

## Implementation tasks

### Task 1: Local code checks work

**Result:** Lint and format commands pass on project files and reject invalid temporary files.

**Files and symbols:** `oxlint.config.ts`, `.oxfmtrc.json`, `.editorconfig`, `package.json`, `package-lock.json`, and files with tool findings.

**Contract:** Four npm commands provide read-only checks and explicit fixes.

**TDD:** not applicable — use the actual CLI for declarative configuration.

**Test seam:** npm scripts and temporary lint/format inputs.

**Steps:**

1. Install stable releases with npm.
2. Add the configs and scripts.
3. Remove unsupported EditorConfig properties.
4. Fix lint findings and format supported files.
5. Prove failures with temporary invalid inputs and remove them.

**Verification:** `npm run lint && npm run format:check && npm run typecheck`

**Depends on:** none

### Task 2: CI enforces the same checks

**Result:** CI invokes the local checks before build and tests.

**Files and symbols:** `.github/workflows/ci.yml`, `CONTRIBUTING.md`, and `CHANGELOG.md`.

**Contract:** Contributors and CI use the same commands.

**TDD:** not applicable — execute the workflow commands locally.

**Test seam:** local lint, format, build, test, and smoke commands.

**Steps:**

1. Add lint and format checks after CI installation.
2. Document check and fix commands and upstream sources.
3. Record the tooling change after smoke verification.

**Verification:** `npm run lint && npm run format:check && npm test && npm run smoke`

**Depends on:** Task 1

## Final verification

Run `npm run lint`, `npm run format:check`, `npm run typecheck`, `npm test`, and `npm run smoke`.
Confirm temporary invalid inputs produce nonzero lint and formatting exits.
Remove temporary inputs before the final checks.
