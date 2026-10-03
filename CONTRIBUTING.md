# Contributing

Keep reports and patches within the supported scope: a CLI and loopback dashboard for local development services. See [README.md](README.md) for platform support. Remote access, automatic recovery, and a native app are not supported.

## Build from source

Use macOS, Git, and Node.js 24 or later with npm. Docker is needed only for Compose entries and checks

```sh
git clone https://github.com/sauravhiremath/servicemon.git
cd servicemon
npm ci --ignore-scripts
npm run build
node dist/cli/main.js --help
```

If you already have a checkout, run the commands after `cd servicemon` from its root. Dependency versions come from the committed lockfile.

The build writes to `dist/`. It does not install or update a global `servicemon` command. Use `node dist/cli/main.js` for all commands when testing source changes. No Homebrew installation or global npm installation is needed.

## Run locally

Run the following from the repository root in one terminal. The temporary config and state keep this test separate from your normal services. Port `0` selects an available port. Do not enable login startup for this test.

```sh
export SERVICEMON_DEV_DIR="$(mktemp -d "${TMPDIR:-/tmp}/servicemon-dev.XXXXXX")"
export SERVICEMON_CONFIG="$SERVICEMON_DEV_DIR/config.yaml"
export SERVICEMON_STATE_DIR="$SERVICEMON_DEV_DIR/state"

cat > "$SERVICEMON_CONFIG" <<'YAML'
version: 1
projects:
  demo:
    directory: "~"
    services:
      api:
        command: 'echo ready; exec sleep 600'
YAML

node dist/cli/main.js config validate
node dist/cli/main.js serve --background --port 0
node dist/cli/main.js start demo/api
node dist/cli/main.js status
node dist/cli/main.js logs demo/api --tail 10
node dist/cli/main.js dashboard
```

Status should show `demo/api` as running, and logs should contain `ready`. The example process exits after 10 minutes. `dashboard` opens your default browser and prints the plain manager URL. Open that URL manually if the browser does not open. No login is needed; all local users and processes can read and control this test manager.

The manager serves the built dashboard. No separate frontend server is needed. Keep this terminal open and use it for further CLI commands so they use the same config and state.

### After source changes

Stop the test manager before rebuilding. Replacing files does not update a running manager, and there is no automatic rebuild or restart.

```sh
node dist/cli/main.js manager stop
npm run build
node dist/cli/main.js serve --background --port 0
node dist/cli/main.js start demo/api
node dist/cli/main.js dashboard
```

Port `0` can select a different port after each restart; `dashboard` opens and prints the current URL. With a fixed port, you can reuse the same URL after a restart. Run `npm ci --ignore-scripts` before building if the lockfile changed.

### Stop and remove test data

In the same terminal, stop the test manager before removing its temporary data:

```sh
node dist/cli/main.js manager stop &&
  rm -rf -- "${SERVICEMON_DEV_DIR:?Temporary test directory is not set}"
unset SERVICEMON_CONFIG SERVICEMON_STATE_DIR SERVICEMON_DEV_DIR
```

Closing the browser or terminal does not stop a background manager. If you lose the terminal, set `SERVICEMON_CONFIG` and `SERVICEMON_STATE_DIR` to the same temporary paths before running `manager stop`. Do not use your normal state folder to stop this test manager.

## Checks

After setup, run these checks from the repository root:

```sh
npm run lint
npm run format:check
npm run knip
npm run typecheck
npm test
npx --no-install playwright install chromium
npm run test:e2e
npm run smoke
```

`npm test` builds and runs unit and integration tests. `test:e2e` builds and runs browser tests. `smoke` builds and installs a temporary package, then checks the installed CLI and dashboard. These commands do not update a global installation.

### Linting and formatting

Oxlint checks correctness, React hooks, JSX accessibility, and type-aware promise use. Warnings, errors, and unused disable comments fail the lint command.
Import rules require one sorted import block, no duplicate imports, type-only imports where applicable, and a blank line after imports. Control-flow statements require braces. Variables that are not reassigned use `const`.
Oxfmt formats supported source, test, config, and documentation files. Both commands use the repository root by default.

```sh
npm run lint:fix
npm run format
```

`lint:fix` applies safe automatic fixes. Fix any remaining findings by hand. CI runs the read-only `lint`, `format:check`, and `knip` commands.
Knip checks unused files, exports, and dependencies. Remove unused code instead of adding broad exclusions.

The lint config leaves React Compiler rules off because this project does not use React Compiler.
It permits valid ARIA roles without requiring different HTML tags. It also permits empty object parameters required by Playwright fixtures.
Tests stay in scope. Generated output and `package-lock.json` are not formatted.

### Optional platform checks

A real macOS GUI login session is needed for the startup checks. With a running Docker engine and Compose v2 or later, also run:

```sh
npm run test:compose
npm run smoke:compose
```

Use isolated fixture services. Do not start or stop a contributor's normal projects. Add behavior tests for changed boundaries or failures, not source-text tests.

## Defect reports

Report defects at <https://github.com/sauravhiremath/servicemon/issues>.

Include the package version, Node version, OS version, CPU type, install method, minimal generic config, commands, expected result, and actual result. State whether startup or Docker is involved.

Do not attach raw state folders, environment files, credentials, config, or logs. Commands, paths, status output, shell diagnostics, and logs can contain private data. Replace them with a small fixture before submitting a report.
