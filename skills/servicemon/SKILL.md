---
name: servicemon
description: Configure and control local development services with Servicemon. Use to setup local development commands (like uv run..., npm run ..., etc) for projects and services, starting or stopping services, running tasks, checking status, reading/streaming logs, and opening the local dashboard for humans.
---

# Servicemon

One manager controls all registered projects from one YAML config. Use the installed CLI, not background shell processes or `brew services`, to manage Servicemon services.

## First use

1. Check `servicemon --version` and `servicemon --help`. If it is not installed, use `brew install sauravhiremath/tap/servicemon`.
2. Run `servicemon config path` to find the config. Read an existing config before changing it. If it is missing, create its parent directory and a YAML file with `version: 1` and `projects: {}`. Never replace an existing config for setup.
3. Register the user's project and its actual service command. Inspect the project's scripts or docs; do not assume it uses npm. For a project whose development command is `npm run dev`, run these commands from its directory, replacing `myapp` with the chosen project ID:

   ```sh
   servicemon project add myapp --directory "$PWD"
   servicemon service add myapp/web --command 'npm run dev'
   servicemon config validate
   servicemon serve --background
   servicemon start myapp/web
   servicemon status --json
   ```

4. Open `servicemon dashboard` when the user wants the browser UI. Login startup is optional; run `servicemon startup enable` only when requested.

## Normal use

Use `servicemon <command> --help` for current options. Prefer `--json` for status and action results. Use qualified IDs such as `myapp/web`, not display names.

```sh
servicemon status --json
servicemon start myapp/web --json
servicemon stop myapp/web --json
servicemon restart myapp/web --json
servicemon logs myapp/web --tail 100 --json
servicemon run myapp/migrate --json
```

Run only registered tasks. Actions wait by default. If you use `--no-wait`, check `servicemon operation <operation-id> --json` until it succeeds or fails; acceptance is not completion. JSON logs are newline-delimited records, not the normal response envelope.

After manual YAML edits, run `servicemon config validate` and, if the manager is running, `servicemon reload`. CLI definition edits apply immediately when the manager is available.

## Operating limits

- Config commands execute as the user. Use only trusted commands and files.
- All local users and processes can read and control the dashboard. Do not expose it through a proxy or tunnel.
- `servicemon manager stop` stops the manager and its owned processes and tasks, but leaves Compose containers running. Do not stop unrelated projects to fix one service.
- Stop the manager before Servicemon or Node upgrades. Before uninstalling, run `servicemon startup disable`, then `servicemon manager stop`.
- Uninstalling keeps config, retained logs, and Compose volumes.

## References

- [First use](https://github.com/sauravhiremath/servicemon#first-use)
- [CLI commands](https://github.com/sauravhiremath/servicemon/blob/master/docs/cli.md)
- [Config](https://github.com/sauravhiremath/servicemon/blob/master/docs/config.md)
- [Operations](https://github.com/sauravhiremath/servicemon/blob/master/docs/operations.md)
