# Config

## Location and validation

Selection order: `--config`, `SERVICEMON_CONFIG`, then `~/.config/servicemon/config.yaml`. Relative config paths use the CLI working folder. `~` and `~/` expand to the home folder.

Run `servicemon config validate`. Validation includes Docker Compose discovery, so configured Compose files need Docker tooling. Unknown fields, duplicate YAML keys, unknown references, unknown Compose overrides, and cycles are errors. IDs use letters, digits, underscores, and hyphens. `/` and `.` are reserved separators. Display names do not change IDs.

## Fields

Root fields:

| Field                        | Meaning                                | Default               |
| ---------------------------- | -------------------------------------- | --------------------- |
| `version`                    | Required schema version                | `1`                   |
| `server.port`                | Loopback port; `0` selects a free port | `7331`                |
| `logs.per_entry_bytes`       | Retained process/task bytes per entry  | `268435456` (256 MiB) |
| `logs.total_bytes`           | Total retained process/task bytes      | `4294967296` (4 GiB)  |
| `timeouts.stop_seconds`      | Graceful stop deadline                 | `10`                  |
| `timeouts.readiness_seconds` | Startup readiness deadline             | `60`                  |
| `projects`                   | Project ID to definition mapping       | Empty                 |

A project requires `directory`. It accepts `name`, `notes`, `services`, `tasks`, and `compose_groups`. A relative project directory is relative to the config folder. Relative service/task/group directories are relative to the project directory. A Compose `file` is relative to the group directory.

A service requires `command`. It accepts `name`, `directory`, `notes`, `links` (list), `depends_on` (list), `autostart`, `restart_dependencies`, `restart_dependents`, `healthcheck`, `stop_seconds`, and `readiness_seconds`.

A task requires `command`. It accepts `name`, `directory`, `notes`, `links`, `depends_on`, `autostart`, and `stop_seconds`. It has no health check or restart flags.

A Compose group requires `file`. It accepts `name`, `directory`, `project_name`, `autostart`, and `services` (per-service overrides). The manager discovers all Compose services; overrides do not limit discovery. Override fields are `name`, `notes`, `links`, `depends_on`, `autostart`, `restart_dependencies`, `restart_dependents`, and `readiness_seconds`. Compose supplies its own health checks, commands, and environment.

Defaults: names use their keys; flags are false; links and dependencies are empty. Entry timeouts use root timeouts. Compose overrides inherit group autostart unless specified. The default Docker project name is lowercase `sm-<project>-<group>`. An explicit name must use lowercase letters, digits, underscores, and hyphens, starting with a letter or digit. Two groups cannot use the same Docker project name. Use the existing Docker project name to show its current containers.

## References, checks, and startup

IDs are `project/service`, `project/task`, and `project/group.service`. Group controls use `project/group`. `depends_on` can use local `service` or `group.service` references, or cross-project qualified IDs.

A health check has one of these forms:

```yaml
healthcheck:
  type: http
  url: http://127.0.0.1:8000/health
  expected_status: 200
  interval_seconds: 2
  timeout_seconds: 3
```

```yaml
healthcheck:
  type: tcp
  host: 127.0.0.1
  port: 5432
```

```yaml
healthcheck:
  type: command
  command: curl -f http://127.0.0.1:8000/health
```

Check interval defaults to 2 seconds and check timeout to 3 seconds. HTTP expects status 200 by default. Command checks run in the entry folder with the manager environment. All durations and retention limits must be positive.

A service without a check is ready when its owned process runs. A checked service must pass its check. Tasks must complete successfully. Compose readiness requires all expected replicas running and, where defined, healthy. Health monitoring never stops or restarts an entry.

Start resolves dependencies. Successful task results can be reused only in the current manager session. Run executes the selected task again. Recursive restart flags add services, not automatic task reruns. Stopped included services stay stopped except prerequisites needed to start an active selected target.

## Reload and environment

Manual edits have no effect until `servicemon reload`. An invalid candidate leaves the active config unchanged. Reload stops removed and execution-changed entries before applying them. It does not start replacements or new autostart entries. Notes and display-only changes do not restart processes. CLI add/remove commands preserve unrelated YAML comments and fields.

At startup and reload, the manager captures exported variables from the user's non-interactive login shell. Aliases and shell functions are not available. Existing processes keep their environment. Commands must load their own `.env` files. Servicemon does not parse them.

## Service, task, and Compose example

See [`examples/services.yaml`](../examples/services.yaml). Change the folders and commands before use. The Compose file must define a `database` service. No entry has autostart enabled. Use isolated fixtures for checks, not your normal projects.
