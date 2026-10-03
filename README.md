# Servicemon

A CLI and localhost dashboard for local development services. One manager controls all registered projects from one YAML config.

Requires Node.js 24 or later. Docker and Docker Compose are needed only for Compose entries.

Currently supports macOS. Linux and Windows support is in progress.

## Install

```sh
brew install sauravhiremath/tap/servicemon
```

Installation does not create config, start the manager, or enable login startup.

To build from an existing source checkout, run these commands from its root:

```sh
npm ci --ignore-scripts
npm run build
node dist/cli/main.js --help
```

For source builds, replace `servicemon` in the commands below with `node dist/cli/main.js`. Building does not update an installed `servicemon` command. New contributors should follow [Build from source](CONTRIBUTING.md#build-from-source) and [Run locally](CONTRIBUTING.md#run-locally) for setup and a test that does not use their normal services.

## First use

Create `~/.config/servicemon/config.yaml`:

```yaml
version: 1
projects:
  demo:
    directory: "~"
    services:
      api:
        command: 'echo ready; exec sleep 600'
```

Then run:

```sh
servicemon config validate
servicemon serve --background
servicemon start demo/api
servicemon status
servicemon dashboard
servicemon logs demo/api --tail 10
```

This starts `demo/api`, which prints `ready` and runs for 10 minutes. Replace its command and directory with your project's values. Only use config files you trust: their commands run as your user.

`servicemon dashboard` opens your default browser and prints the manager URL. You can also open that URL directly or bookmark it. There is no login or link expiry. All local users and processes can access the dashboard, read logs, and control configured services. Do not expose the port through a proxy or tunnel.

Use `servicemon serve` for foreground operation. Closing the browser stops nothing. Use `servicemon manager stop` to stop the manager and its owned processes and tasks. Compose containers remain running.

## Controls

- Start resolves dependencies and waits for readiness. Stop affects only its selected target.
- Restart follows the configured recursive rules. An included stopped service stays stopped unless startup requires it.
- Run always runs a task again. Dependency starts reuse successful task results only in the current manager session.
- Health failures and process exits cause no automatic restart or stop.
- Manual config changes need `servicemon reload`. CLI definition edits apply immediately when the manager is available.
- A readiness timeout leaves the process running and its blocked dependents stopped.
- Use the dashboard to control services, filter entries, and view logs.

See the [config reference](docs/config.md), [CLI reference](docs/cli.md), and [dashboard guide](docs/operations.md#dashboard) for details.

## Support and maintenance

For upgrades, login startup, removal, and recovery, follow the [operations guide](docs/operations.md). Stop the manager before you upgrade or uninstall. Removing the program does not remove your config, retained logs, or Compose volumes.

Config commands and custom HTML are trusted local code. Status output, config, shell diagnostics, and logs can contain private data. Read [CONTRIBUTING.md](CONTRIBUTING.md) before reporting a defect.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) to build from source, run an isolated local manager, check changes, and report defects.

## Limits

No file watching, remote access, native app, external-process attachment, or automatic recovery. Commands must load their own environment files. Use `servicemon serve --ui <file>` to replace the dashboard with your own HTML.

## License

[MIT](LICENSE). Copyright (c) 2026 Saurav M Hiremath.
