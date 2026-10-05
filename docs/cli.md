# CLI

Use `servicemon --help` or `servicemon <command> --help` for option details. Global options are `--config <path>` and `--json`.

## Manager

```sh
servicemon serve                          # Foreground
servicemon serve --background             # Detached manager
servicemon serve --port 7331
servicemon serve --ui ~/dash/index.html   # Custom HTML/HTM
servicemon dashboard                     # Open the browser and print the URL
servicemon manager status
servicemon manager stop
servicemon manager restart
servicemon manager restart --yes --json
servicemon startup enable
servicemon startup disable
```

Serve reuses the active manager for the same config. A different config conflicts with that manager. Stop does not cause login startup to restart the manager in the same login session. Installation does not enable startup.

`dashboard` requires a running manager. It prints the plain manager URL and opens it in the default browser on macOS. JSON output contains `url` and also opens the browser. If the browser cannot open, the CLI prints a warning to stderr; the URL remains available to open manually. For scripts that only need the endpoint, use `manager status --json`. You can revisit or bookmark the URL without a login. A restart on the same port does not change the URL. With `--port 0`, run `dashboard` again to open the current port.

`startup disable` leaves a live manager running. See [Login startup](operations.md#login-startup) for registration and launcher rules.

### Version checks and manager restart

Package installation does not replace a running manager. `manager status` reports `cliVersion`, `managerVersion`, `applicationProtocol`, `compatible`, and `restartRequired` without a restart prompt. A package-version difference does not by itself mean that the application protocol is incompatible. The same checks apply to upgrades and downgrades.

Before its first application request, each command checks the manager and selects one manager identity. It does not switch to another manager during polling or replay a request that it has already sent.

| Condition                              | Terminal command                                                   | Script or `--json`                                     |
| -------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| Same version and compatible protocol   | Continue                                                           | Continue                                               |
| Different version, compatible protocol | Offer one optional restart; refusal continues                      | Continue; write a version notice to stderr             |
| Incompatible protocol                  | Require one restart confirmation; refusal returns a mismatch error | Return a mismatch error before the application request |
| Observe an existing operation ID       | Never offer automatic restart                                      | Never offer automatic restart                          |

Both stdin and stderr must be terminals for a prompt. `--json` never prompts. Help, version, and local-only config work do not need a manager. `manager stop` uses the management contract without an upgrade prompt.

`manager restart` requires a running manager. The default answer is no; EOF and Ctrl-C give no consent. Scripts must use `manager restart --yes`. Restart stops owned processes and active tasks, leaves Compose containers running, and runs normal autostart only. See [Upgrade and recovery](operations.md#upgrade-and-recovery) for preserved settings, interruption rules, and failure recovery.

## Runtime actions

```sh
servicemon status
servicemon status demo/api
servicemon start demo/api
servicemon stop demo/api
servicemon restart demo/api
servicemon run demo/migrate
servicemon start --project demo
servicemon stop --compose demo/infra
servicemon restart --project demo --no-wait
servicemon operation <operation-id>
servicemon reload
servicemon reload --no-wait
servicemon logs demo/api --tail 100
servicemon logs demo/api --follow --json
```

Start, Stop, Restart, and targeted Status accept exactly one qualified entry ID, `--project <id>`, or `--compose <project/group>`. Status without a target shows all entries. Run requires one task ID; it does not accept `--project` or `--compose`. Actions wait for completion by default. `--no-wait` returns after acceptance with an operation ID. Acceptance is not success. Query `operation` until its state is `succeeded` or `failed`.

Stop affects only its target. No action removes Compose volumes. Ctrl-C ends log follow, not the service. Tail counts must be non-negative integers. `--tail 0` prints no retained records; with `--follow`, it starts at the current log cursor and prints new records only.

## Definitions

```sh
servicemon config path
servicemon config validate
servicemon project list
servicemon service list
servicemon task list
servicemon compose list
servicemon project add demo --directory ~/work/demo --name Demo
servicemon service add demo/api --command 'npm run dev' --health-http http://127.0.0.1:8000/health
servicemon task add demo/migrate --command 'npm run migrate'
servicemon compose add demo/infra --file compose.yaml --project-name demo-local
servicemon service remove demo/api
servicemon task remove demo/migrate
servicemon compose remove demo/infra
servicemon project remove demo
```

Add fails if the ID exists. Remove dependency references before removing their targets. Edit existing definitions in YAML, then reload. Online edits validate and stop affected entries before committing. Offline edits validate before committing without starting the manager.

All add commands accept `--name` and `--notes`. Projects require `--directory`. Services and tasks require `--command`; they accept `--directory`, `--autostart`, `--depends-on <ids...>`, repeated `--link`, and `--stop-seconds`. Services also accept `--restart-dependencies`, `--restart-dependents`, `--readiness-seconds`, one of `--health-http`, `--health-tcp <host:port>`, or `--health-command`, plus `--expected-status`, `--health-interval`, and `--health-timeout`. Compose add requires `--file` and accepts `--directory`, `--autostart`, `--project-name`, and `--services '<JSON-object>'` for discovered service overrides. The config reference lists override fields.

## Agent output

Normal JSON responses have this form:

```json
{ "ok": true, "data": { "operationId": "..." }, "error": null }
```

Errors have `ok: false`, `data: null`, and an error with `code` and `message`. Errors can also include `details`, `entryId`, and `operationId`. IDs remain stable across display-name changes.

Logs with `--json` use newline-delimited JSON records, not the normal response envelope. Records contain `entryId`, `runId`, `sequence`, `timestamp`, `stream`, and `text`; Compose records also include `containerId`. Streams include `stdout`, `stderr`, `boundary`, and `gap`.

| Exit | Meaning                                                                                     |
| ---- | ------------------------------------------------------------------------------------------- |
| 0    | Success, or accepted no-wait operation                                                      |
| 1    | Failed command/operation, missing command/subcommand, or other error                        |
| 2    | Invalid config/input/target, missing config, or unknown entry                               |
| 3    | Manager, Docker, or required tool unavailable                                               |
| 4    | Readiness timeout                                                                           |
| 5    | Operation/config busy, config changed during edit, manager conflict, or uncertain ownership |

Manager restart uses one JSON result or error envelope. Prompts and notices go to stderr. Restart errors include the phase, observed running state, and a recovery command where applicable.

| Code                        | Exit | Action                                                                             |
| --------------------------- | ---- | ---------------------------------------------------------------------------------- |
| `MANAGER_VERSION_MISMATCH`  | 5    | Restart with the installed CLI before an application command                       |
| `MANAGER_RESTART_CANCELLED` | 1    | No consent was given; the manager is not stopped                                   |
| `MANAGER_CONFLICT`          | 5    | Inspect status and changed ownership, config, or restart impact                    |
| `MANAGER_UNAVAILABLE`       | 3    | Inspect the selected manager and endpoint; this is not proof of a version mismatch |
| `MANAGER_RESTART_TIMEOUT`   | 3    | Wait for the old manager to exit; no forced termination occurs                     |
| `MANAGER_RESTART_FAILED`    | 3    | Read the phase and running-state details, then use the reported recovery command   |

Script restart without `--yes` returns `INVALID_INPUT` (exit 2). Invalid config or dashboard files fail before shutdown.

Check structured error codes instead of parsing human messages. A no-wait command can return 0 and later fail. A readiness timeout does not stop its process.
