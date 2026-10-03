# Homebrew and open-source release readiness

## Scope

Servicemon is a CLI and localhost dashboard for development services. Its source repository is <https://github.com/sauravhiremath/servicemon>. Its Homebrew tap is <https://github.com/sauravhiremath/homebrew-tap>.

The project uses [MIT](../../LICENSE). Homebrew and source builds are the install methods. There is no npm registry package or bottle distribution.

This record describes the release design. Use [releasing.md](../releasing.md) for maintainer commands. Do not treat an untested installation or platform as a pass.

## Release requirements

- Use generic examples without personal project paths, credentials, or private logs.
- Include the MIT license in source and installed artifacts.
- Read the release version from installed package metadata. Keep the lockfile, tag, archive, and formula versions consistent.
- Build from a committed source revision with its committed dependency lockfile.
- Disable dependency installation scripts. Remove development dependencies from the installed runtime tree.
- Package the CLI, server, dashboard, examples, and user instructions together.
- Use an immutable versioned source URL and verify its SHA-256.
- Do not create user config, start a manager, or register login startup during installation.
- Do not change global npm packages or the user's shell configuration.
- Preserve config, retained logs, and Compose resources on package removal.
- Keep all service-control behavior unchanged by packaging.

## Source and package contents

The source archive contains application source, tests, build inputs, the dependency lockfile, the MIT license, generic examples, and public instructions. It excludes development plans, dependencies, local work folders, credentials, logs, test results, and caches.

The installed package contains built application files and runtime dependencies. Frontend build packages stay in `devDependencies`; their compiled output is in the dashboard bundle. Two independently built and pruned runtime trees must match the lockfile.

`package.json` supplies the CLI version. `release:check` checks versions, package contents, the MIT license, built assets, and installed dependency versions. Runtime-only mode checks the pruned dependency tree. The changelog has no required version heading.

## Homebrew formula

The formula declares its description, homepage, exact source URL, SHA-256, MIT license, macOS restriction, and Node dependency.

Installation downloads the locked dependencies with scripts disabled, builds the application, removes development dependencies, and places runtime files under `libexec`. It uses neither global npm installation nor Homebrew services.

The launcher uses Homebrew's stable Node path and Servicemon's stable `opt` path. It exports `SERVICEMON_STARTUP_EXECUTABLE` so login registration does not retain an obsolete Cellar path. Its functional test invokes the installed public command with temporary config and state, then stops the fixture manager.

The formula generator accepts the exact local archive URL or the canonical versioned GitHub asset URL. It verifies the archive checksum and refuses to overwrite an existing formula. Preserve each formula with its matching archive for recovery.

## Login startup

- Enabling an unchanged loaded registration again must preserve it.
- A failed replacement must restore a valid previous registration.
- A changed registration that would terminate a live manager requires an explicit manager stop.
- Disable must not implicitly stop a live manager.
- Inactive obsolete jobs must be unloaded so disable/enable works in the same login session.
- Homebrew registration uses the stable launcher; source installations retain Node-plus-CLI registration.
- Login startup does not enable automatic crash restart.
- Replacing application and Node paths must preserve startup routing, config, and logs.

The real LaunchAgent fixture removes old versioned paths and puts an unrelated Node first in `PATH`. This checks stable routing, not the complete Homebrew upgrade or removal process.

## Browser access

The dashboard uses plain loopback host-and-port access. All local users and processes can read its data and control the manager. Host and Origin checks remain in force; mutations need an Origin header that matches the endpoint.

`servicemon dashboard` prints the URL and opens the default browser. The same URL works after a restart on the same port. No browser login is required.

Custom HTML, scripts, and JSON assets use the same access rules. Dotfiles, unknown asset types, traversal, and symlink escape are rejected. Config commands and custom HTML are trusted local code that runs with the owner's rights.

## Build and runtime checks

Supported runtimes start at Node.js 24. An older runtime receives a clear CLI error. Builds clean the entire output directory first. Installed checks use a packed public command or formula launcher, not a development frontend server.

Check these paths with isolated fixtures:

1. Config validation, background manager reuse, built dashboard assets, service/task actions, logs, reload, and shutdown.
2. Dependency order, timeout behavior, retained output, and refreshed login environment for new runs.
3. Plain URL access, browser opening, browser service/task/log actions, and restart behavior.
4. Custom HTML/JSON assets and denied private sibling-file requests.
5. Repeated startup registration, failed replacement rollback, same-session renewal, and stable-path replacement.
6. Compose log follow through replacement and preserved containers/volumes after manager shutdown.
7. Two clean pruned runtime trees with matching locked dependency versions and integrity values.

Hosted CI skips real launchd checks when there is no GUI login session and reports the skip. Compose checks need Docker. Record exact Node/npm versions, macOS version, CPU, browser, and results rather than inferring support from workflow runner names.

## Installation, upgrade, and recovery

Use a clean OS account or disposable machine for the complete Homebrew lifecycle. Verify installation has no manager/config/startup side effects. Follow README first use, then test explicit startup, repeated registration, package and Node upgrades, uninstall, and earlier-version recovery.

Stop the manager before changing package or runtime files. Disable startup before uninstalling. Preserve config, retained logs, and Compose resources. Restore an earlier version with its original archive and matching formula; check the checksum, CLI version, functional formula test, and normal service control.

## Source archives and releases

`release:source` accepts a committed full SHA or version tag. It creates an exact source archive, builds and exercises it, checks the pruned runtime, and emits a SHA-256 file and manifest. Existing archive bytes are not overwritten.

The Source archive workflow is manually dispatched and works in a public repository. It uses read-only contents permission and uploads a source artifact; it does not publish a GitHub release.

Publish the checked archive under:

`https://github.com/sauravhiremath/servicemon/releases/download/v<version>/servicemon-<version>-source.tar.gz`

Compare the downloaded checksum, generate the formula for that exact URL, run strict online audit and source installation checks, then update the tap. Keep recovery artifacts and test evidence. Fix a published defect with a new version rather than replacing existing release bytes.

## Out of scope

Platform ports, remote access, native apps, file watching, external-process attachment, automatic restart/recovery, Homebrew services integration, and application redesign are outside release packaging. Direct submission to `homebrew/core` is a separate distribution path with its own requirements.
