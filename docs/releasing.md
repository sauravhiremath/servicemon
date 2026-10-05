# Releasing

Run these maintainer commands from the source checkout.

- Source: <https://github.com/sauravhiremath/servicemon>
- Tap: <https://github.com/sauravhiremath/homebrew-tap>
- License: [MIT](../LICENSE)

Homebrew and source builds are the install methods. `package.json` uses `private: true` because this project is not distributed through the npm registry. The formula builds from source; no bottles are supplied.

## Version

`package.json` is the version source. The CLI reads the installed metadata. Use `npm version <version> --no-git-tag-version` to change the package and lockfile versions. Match the Git tag, archive name, and formula version to that value. Never replace the bytes of a published version.

## GitHub Actions

The **Source checks** workflow runs on pushes and pull requests. It checks the minimum Node runtime and current Homebrew Node.

The **Release** workflow checks one committed revision. It runs source checks, browser tests, installed-package checks, and Homebrew source installation, functional tests, reinstall, and removal. It creates a `release-candidate` artifact with the archive, checksum, manifest, public-URL formula, and release notes. Artifacts expire after seven days.

Run it without publication first:

```sh
gh workflow run release.yml --repo sauravhiremath/servicemon \
  -f ref=<full-commit-sha> -F publish=false
```

Only `publish=true` enables the separate job with repository write permission. It publishes the checked bytes from that run and verifies the uploaded checksum. It does not change repository visibility or update the tap.

Release notes come from non-merge commit subjects since the highest reachable version tag, excluding the current version tag. The first release includes the complete non-merge history. Each entry links to its commit. Write clear commit subjects; version changes remain explicit in `package.json`.

The tap has a separate **Tap update** workflow. It downloads a public source release, verifies its checksum, generates the formula, runs an online audit, and tests source installation. With `publish=true`, it commits the checked formula to the tap. Both workflows use their own repository's `GITHUB_TOKEN`; no cross-repository token is needed.

Hosted checks do not replace GUI logout/login, second-account access, Compose, or cross-version upgrade and recovery checks.

## Check the source

Use Node.js 24 or later. Dependency installation uses the committed lockfile with installation scripts disabled. Build-only frontend packages stay in `devDependencies`.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npx --no-install playwright install chromium
npm run test:e2e
npm run smoke
npm run check:runtime
npm run smoke:startup
npm run test:compose
npm run smoke:compose
npm run release:check
npm pack --dry-run --ignore-scripts --json
gitleaks git . --log-opts=--all --redact --no-banner
```

`release:check` checks the MIT license, package contents, version, built assets, and locked dependency versions. `check:runtime` builds one fresh temporary source copy, removes development dependencies, checks the runtime tree against the lockfile, and exercises the installed CLI and dashboard. It does not prune the developer's installation.

The installed smoke checks verify that a refreshed login environment applies to new runs without changing the environment of running services.

Startup checks require a macOS GUI login session. Hosted CI sets `SERVICEMON_SKIP_LAUNCHD=1` and reports that scenario as skipped. Compose checks require a running Docker engine and Compose v2 or later. Do not run untrusted pull-request code on a machine with credentials.

For cross-account access checks, start an isolated manager as one OS user. From a different OS account, check that `/`, `/api/status`, and allowed custom JSON assets are readable. A task action with a matching Origin header must work without credentials. Foreign Host/Origin headers and mutations without Origin must return 403. Custom `.env` paths must return 404. The second account must not be able to read the owner-only instance record from disk. HTTP access deliberately trusts all local users.

Record actual versions, platform, browser, archive checksum, and results for each release. Keep skipped checks separate from passed checks.

## Create the source archive

The source generator reads a committed revision, not uncommitted files or local build output. Pass a full commit SHA or version tag:

```sh
npm run release:source -- --ref <commit-sha> --output release-artifacts/<version>
node scripts/release-notes.mjs --manifest release-artifacts/<version>/manifest.json
```

The generator uses `git archive` with an explicit file list: source, tests, build inputs, lockfile, MIT license, examples, agent skills, and public instructions. It excludes plans, dependencies, local work folders, credentials, logs, test results, and caches. It builds and exercises that exact archive, then checks the production-only installation.

The output directory contains `servicemon-<version>-source.tar.gz`, its SHA-256 file, `manifest.json`, and the generated `release-notes.md`. Existing archive and release-note files are not overwritten. Use a new output directory for a new build.

## Test the formula

Generate a formula from the archive manifest:

```sh
npm run release:formula -- --manifest release-artifacts/<version>/manifest.json --tap /path/to/homebrew-tap
brew trust --formula sauravhiremath/tap/servicemon
brew style sauravhiremath/tap/servicemon
brew audit --strict --formula sauravhiremath/tap/servicemon
brew install --build-from-source sauravhiremath/tap/servicemon
brew test sauravhiremath/tap/servicemon
```

Use `brew --repository sauravhiremath/tap` to locate an installed tap. The generator checks the archive SHA-256 and defaults to its exact local file URL. It refuses to overwrite an existing formula. Preserve the old formula with its matching archive, then remove the old formula file before generating its replacement.

The formula downloads locked packages with scripts disabled, builds the application, prunes development dependencies, and installs runtime files under `libexec`. Its launcher selects Homebrew Node and stable `opt` paths. It includes `skills/servicemon/SKILL.md` under `libexec` and prints an optional skill installation command. It does not install skills into agent directories, use global npm installation, start a manager, create user config, or register login startup. Its functional test uses temporary config/state and stops its fixture manager.

## Check installation and recovery

Use a clean OS account or disposable macOS machine, not normal working services:

1. Confirm that config, state, manager, and login registration do not exist. Install from source and confirm they remain absent.
2. Follow README first use through the formula launcher. Put an unrelated Node first in `PATH`. Validate config, open the plain dashboard URL, start/stop a service, run a task, read logs, and reload config.
3. Enable isolated startup twice and confirm the manager PID is unchanged. A changed live registration must fail without stopping the manager.
4. Stop explicitly. Upgrade the package and Node targets. Remove old fixture paths. Start the isolated LaunchAgent and verify the new task result.
5. Check retained config/logs. Compose containers and volumes must remain after manager stop.
6. Disable startup, stop the manager, uninstall, and check that user data remains.
7. Restore an earlier formula and its checksummed archive. Reinstall from source, check the version, run `brew test`, and verify retained data and service control.

The startup path-swap fixture does not replace these full Homebrew checks.

## Publish the release

Publication requires explicit approval. Run the **Release** workflow with the reviewed full commit SHA and `publish=true`:

```sh
gh workflow run release.yml --repo sauravhiremath/servicemon \
  -f ref=<full-commit-sha> -F publish=true
```

The job creates `v<version>` at the checked commit and uploads the archive, checksum, manifest, and formula. The release body contains the generated commit-based notes. An existing version tag must identify the checked commit. An existing release is not overwritten.

The asset URL is:

`https://github.com/sauravhiremath/servicemon/releases/download/v<version>/servicemon-<version>-source.tar.gz`

After that release is public, check the tap update without writing it:

```sh
gh workflow run tests.yml --repo sauravhiremath/homebrew-tap \
  -f version=<version> -F publish=false
```

To approve the tap update, run the same command with `-F publish=true`. The workflow repeats its checks before committing the formula. The source repository and tap must be public for installation without GitHub credentials. Visibility changes remain a separate, explicit action.

Keep the last good archive, checksum, formula, release notes, and test results. Repair a bad release with a new version or restore a checked earlier version; never upload different bytes under an existing version.
