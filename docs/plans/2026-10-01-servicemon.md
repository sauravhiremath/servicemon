# Servicemon specification and implementation plan

> Language: ASD-STE100 style.
> Status: Ready for implementation. No application code was written for this plan.
> Product decisions: Recovered from the approved conversation and dashboard review.
> Technical choices: Defined below where the conversation did not select an implementation.

## Goal

Build a CLI and localhost dashboard that control local development services across all registered projects.

Use one background manager and one central YAML config. Let humans and agents use the same service controls.

A **project** groups services and tasks. It supplies a default working folder.
A **service** is a long-running foreground process or a Compose service.
A **task** is a command that runs to completion.
A **Compose group** contains the services loaded from one Docker Compose file.
The **manager** owns the active config, service operations, process output, and localhost server.
An **operation** records a requested action and its result.
**Readiness** is the startup condition used before a dependent can start.
**Health** is the latest check result. Health and process state are separate fields.

## Acceptance criteria

| ID  | Required result                                                                                                                            | Tasks               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| A01 | One manager controls all registered projects. Foreground and background serve modes work.                                                  | 1, 2, 9             |
| A02 | A central YAML config defines projects, commands, tasks, Compose groups, notes, links, and working folders.                                | 2, 3                |
| A03 | CLI commands list, add, and remove projects, services, tasks, and Compose groups. Unrelated YAML settings and comments remain.             | 3, 10               |
| A04 | Start, Stop, and Restart control owned process groups. Commands run in their configured folders.                                           | 4, 5                |
| A05 | Tasks have Run and Stop controls. Successful task results are reused only during the current manager session.                              | 4, 5                |
| A06 | Start resolves explicit dependencies, waits for readiness, and blocks dependents when a prerequisite fails.                                | 5, 6                |
| A07 | Dependency references can cross projects. Validation rejects missing references and cycles in both graphs.                                 | 3, 5                |
| A08 | Restart follows configured rules recursively. It leaves stopped included services stopped, except required startup dependencies.           | 5, 6                |
| A09 | Ordinary Stop affects only the selected service. Failures and failed health checks cause no automatic recovery.                            | 4, 5, 6             |
| A10 | HTTP, TCP, and command health checks work. Start and Restart wait by default and support `--no-wait`.                                      | 5, 6, 8             |
| A11 | One Compose file creates individual service rows and whole-group controls. Existing configured containers are visible.                     | 7, 8, 11            |
| A12 | Process and task logs persist across runs and manager restarts. Retention is generous, bounded, and configurable.                          | 4, 7, 8, 12         |
| A13 | CLI output supports human text, `--json`, stable IDs, error codes, exit codes, and live logs.                                              | 8                   |
| A14 | Manual config edits require explicit reload. Invalid config keeps the last valid config active.                                            | 10                  |
| A15 | Reload stops removed or execution-changed entries before applying their changes. Other services remain running.                            | 10                  |
| A16 | Login-shell exported variables load at startup and reload. Existing processes keep their environment. Commands load their own env files.   | 2, 4, 6, 10         |
| A17 | Autostart runs only at manager startup. Reload never starts newly added entries automatically.                                             | 5, 9, 10            |
| A18 | Manager shutdown stops its processes and active tasks but leaves Compose containers running. Browser closure stops nothing.                | 7, 9                |
| A19 | Optional login startup has explicit enable and disable commands. Installation does not enable it automatically.                            | 9                   |
| A20 | The dashboard uses the approved toolbar and table layout, column resizing, column filters, and 20 entries per page.                        | 11                  |
| A21 | Logs open in a dark, resizable bottom panel with one tab per service or task.                                                              | 12                  |
| A22 | Controls, menus, and filters reuse official shadcn examples. No custom control design replaces those examples.                             | 11, 12              |
| A23 | The dashboard copies the config path. It has Reload config but no definition-editing forms.                                                | 10, 11              |
| A24 | Serve accepts a user-selected `.html` or `.htm` file instead of the built-in dashboard. No customization framework is provided.            | 2, 11               |
| A25 | Servicemon does not attach to or stop ordinary processes started outside it.                                                               | 4, 9                |
| A26 | The installed CLI serves built dashboard assets without a separate frontend development server.                                            | 1, 13               |
| A27 | Use maintained open-source libraries for standard CLI and application functions where suitable. Do not duplicate their existing functions. | 1, 3, 8, 11, 12, 13 |

## Existing behavior

The initial repository had no application code or build commands.
The design covers API and worker services, a manual setup task, and Compose infrastructure.
Commands can use different folders, HTTP checks, and links.
File triggers are not supported. The dashboard uses the official shadcn examples.

Observed local tools: Node.js `v25.6.1` and npm `11.9.0`.
No application build, application smoke run, or Docker check was performed during planning.

## Decisions

### Approved product decisions

1. Support macOS only in the first release.
2. Use CLI plus localhost web dashboard. Do not build a native app.
3. Use one manager for all projects and one declarative YAML config.
4. Support foreground commands, tasks, and explicit Compose management.
5. Use standard process signals. Do not provide custom stop commands.
6. Define dependencies explicitly. Do not infer application dependencies from commands.
7. Start required dependencies and wait for their startup conditions.
8. Reuse task success during a manager session. Explicit Run always runs the task again.
9. Ordinary Stop does not stop dependents.
10. Failures, unhealthy checks, and apparently stuck processes receive no automatic restart or stop.
11. Apply restart settings recursively. Reject restart-rule cycles at config validation.
12. Preserve the stopped state of services included by restart rules, except required startup dependencies.
13. Show process state, health, exit details, and per-entry logs separately.
14. Keep bounded process and task logs on disk. Docker controls Compose log retention.
15. Use explicit reload. CLI definition changes apply immediately when the manager is available.
16. Stop affected running entries before applying removal or execution changes. Do not start their replacements automatically.
17. Load exported login-shell variables at startup and reload, not before every command.
18. Run commands relative to their working folders. Commands handle `.env` files themselves.
19. Apply autostart only at manager startup, including login startup.
20. Stop processes and tasks at manager shutdown. Keep Compose containers running.
21. Provide optional login startup with explicit enable and disable commands.
22. Provide human CLI output plus `--json` and streaming log output.
23. Show each Compose service and provide whole-group controls.
24. Allow cross-project references with project-qualified IDs.
25. Wait by default for Start and Restart. A readiness timeout leaves the process running.
26. Support HTTP, TCP, and command health checks.
27. Control only ordinary processes that servicemon starts. Observe existing containers in configured Compose projects.
28. Use the approved table and bottom log panel. Use official shadcn control examples.
29. Let users point serve at an HTML file. Do not add customization support beyond file serving.

### Implementation approach

Use TypeScript for the CLI, manager, shared types, and React dashboard.
Target Node.js 24 or later. Use npm, Vite, shadcn, and TanStack Table.
Use Node built-in functions and suitable open-source libraries. Keep application rules independent of HTTP and CLI formatting.
Use the `yaml` document API for config edits. Validate parsed data with a strict schema.
Use Vitest for behavior tests and Playwright for browser tests.
Select package versions during Task 1. Record exact versions in the lockfile and use one supported shadcn primitive family throughout.

This is a technical planning choice, not a previously approved package selection.
It keeps one language across the CLI and dashboard and uses standard macOS process-group behavior.

#### Library reuse requirement

Use existing open-source libraries for standard functions across the application. Do not build replacements without a documented contract gap.
Use an established CLI library for subcommands, argument parsing, option validation, generated help, and usage errors.
Apply the same rule to config parsing, schema validation, HTTP routing, streaming, UI controls, and test tools where suitable.
Use Node built-in functions when they already meet the requirement. Do not add a dependency only to wrap a built-in function.
Keep servicemon-specific dependency rules, restart rules, task state, and ownership policy in application code.
Evaluate libraries against the required behavior, maintenance status, license, macOS support, and runtime compatibility.
Check current documentation before selecting a library. Record selected versions in the lockfile.
If no suitable library meets a contract, record the gap before implementing that function directly.

Other approaches considered:

| Approach                                          | User result                                               | Trade-off and risk                                                                                                     | Deliberate exclusion                        |
| ------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| TypeScript manager plus React dashboard, selected | All approved controls share one implementation language.  | Requires a Node runtime. Process-group ownership needs careful tests.                                                  | No single native executable or desktop app. |
| Rust manager plus React dashboard                 | The same service controls can ship with a native manager. | Adds a second language and separate serialization contracts. Packaging work increases.                                 | No reduction in dashboard or Compose work.  |
| Shell-command wrapper with a dashboard            | Basic command launching can be small.                     | Cannot meet the approved Compose state, recursive restart, task cache, and agent contracts without becoming a manager. | Excludes required behavior, so reject it.   |

### Planning defaults

These defaults complete the specification. They are not additional product features.

| Setting                               | Default                                     |
| ------------------------------------- | ------------------------------------------- |
| Config                                | `~/.config/servicemon/config.yaml`          |
| State and logs                        | `~/Library/Application Support/servicemon/` |
| Bind address                          | `127.0.0.1` only                            |
| HTTP port                             | `7331`; configurable                        |
| Command shell                         | `/bin/sh -c`                                |
| Stop timeout                          | 10 seconds                                  |
| Startup readiness timeout             | 60 seconds                                  |
| Check interval                        | 2 seconds                                   |
| Individual check timeout              | 3 seconds                                   |
| Process/task retained log bytes       | 256 MiB per entry                           |
| Total retained process/task log bytes | 4 GiB                                       |
| Default page size                     | 20 entries                                  |
| Restart settings                      | Both false                                  |
| Autostart                             | False                                       |

Allow global timeout and retention settings. Allow per-entry stop and readiness timeouts.
Do not give command checks their own environment-file loader.

### Open decisions

None block this plan. Package versions and file names are implementation choices within the contracts below.

## Out of scope

- Native windows, system tray, and menu-bar UI.
- Linux and Windows support.
- Watching application files or the config file.
- Automatic recovery, restart policies, and failure-driven dependency actions.
- Dashboard forms that edit definitions.
- Executable config, multiple config layers, and per-project config discovery.
- Custom stop commands and command-specific shutdown adapters.
- `env` and `env_files` config fields.
- Attachment to externally started ordinary processes.
- Reattachment to ordinary process output after an abnormal manager exit.
- Remote access, hosted services, accounts, and multi-user control.
- A public extension API, custom UI compatibility checks, and customization support.
- Metrics collection, resource charts, and notifications.
- Compose volume removal and destructive `down --volumes` controls.

## Interfaces and data flow

### Proposed file structure

All targets below are new because the repository has no application structure.
Use one package and keep modules small. Do not create separate packages for these folders.

```text
package.json
package-lock.json
tsconfig.json
vite.config.ts
vitest.config.ts
playwright.config.ts
src/cli/
src/config/
src/manager/
src/process/
src/compose/
src/logs/
src/server/
src/shared/
src/web/
tests/config/
tests/process/
tests/manager/
tests/compose/
tests/cli/
tests/web/
tests/fixtures/
scripts/smoke.mjs
scripts/smoke-compose.mjs
README.md
CHANGELOG.md
docs/config.md
docs/cli.md
docs/operations.md
```

### Config contract

Use `version: 1`. Reject unknown keys and duplicate mapping keys.
Names use letters, digits, underscores, and hyphens. Reserve `/` and `.` for qualified IDs.
Project IDs and entry names remain stable when display names change.

```yaml
version: 1
server:
  port: 7331
logs:
  per_entry_bytes: 268435456
  total_bytes: 4294967296
timeouts:
  stop_seconds: 10
  readiness_seconds: 60
projects:
  demo:
    name: Demo
    directory: ~/work/demo
    notes: Local development example
    compose_groups:
      infra:
        file: infra-docker-compose.yaml
        project_name: servicemon-demo
        autostart: false
    tasks:
      setup:
        command: uv run python ops/local-setup.py
        depends_on: [infra.postgres, infra.logto]
    services:
      api:
        command: sh ops/local-run.sh api
        depends_on: [setup]
        autostart: false
        restart_dependencies: false
        restart_dependents: false
        healthcheck:
          type: http
          url: http://localhost:8010/v1/health
        links:
          - http://localhost:8010/docs
      ui:
        directory: ~/work/demo-ui
        command: npm run dev -- --host 127.0.0.1 --strictPort
        depends_on: [api]
        links:
          - http://localhost:5199
```

This is a generic example. Create the folders and check the commands before use.

Config fields:

- Project: `name`, `directory`, `notes`, `services`, `tasks`, and `compose_groups`.
- Process service: `name`, `command`, `directory`, `notes`, `links`, `depends_on`, `autostart`, both restart settings, `healthcheck`, and timeout overrides.
- Task: command fields, dependencies, autostart, and stop timeout. A task has no ongoing health check or service restart settings.
- Compose group: `name`, `file`, `directory`, `project_name`, `autostart`, and optional `services` overrides.
- Compose service override: notes, links, dependencies, autostart, both restart settings, and readiness timeout.
- Health check: `type`, check-specific fields, `interval_seconds`, and `timeout_seconds`.
- HTTP fields: `url` and optional `expected_status`, default `200`.
- TCP fields: `host` and `port`.
- Command field: `command`, run in the entry's working folder with the manager environment snapshot.

Group `services` overrides refer to names discovered from that Compose file. Reject unknown override names.
A service override can disable group autostart for that service.
Tasks marked autostart run once at manager startup after their dependencies satisfy the startup conditions.

Resolve `~` in path fields to the user's home folder.
Resolve a relative project directory from the config file's folder.
Resolve an entry or Compose group directory from its project directory.
Resolve a Compose file from the group's effective directory.
Do not expand environment variables in arbitrary YAML strings.

Command service ID: `demo/api`.
Task ID: `demo/setup`.
Compose service ID: `demo/infra.postgres`.
A local reference can be `api`, `setup`, or `infra.postgres`.
A cross-project reference must include the project, such as `shared/infra.postgres`.
Service and task names share one namespace within a project.
Compose group IDs have a separate explicit target form in the CLI.

Use an explicit Compose `project_name` when supplied.
Otherwise derive a deterministic project name from the servicemon project and group IDs.
Reject two groups that resolve to the same Compose project name.
Never discover unrelated Docker containers by port, image, or display name.

### Manager and process ownership

Create one private per-user instance record and exclusive manager lock.
The instance record stores the config path, endpoint, manager identity, and lock ownership token.
Do not permit two managers merely because they select different config paths.
Create state files with owner-only access. Do not expose the environment snapshot through status or JSON output.

Capture exported variables through the user's non-interactive login shell once at startup and explicit reload.
Use a separate machine-readable channel for the captured environment. Shell startup output must not corrupt that data.
Apply a bounded capture timeout. Report shell failures; do not silently claim terminal-equivalent behavior.
A login shell does not supply interactive aliases or functions. State this limit in documentation.

Run command strings through `/bin/sh -c` with the environment snapshot and effective working folder.
Create a separate process group for each command run. Capture stdout and stderr continuously.
Keep stdin closed. Interactive command sessions are not provided.
Stop sends SIGTERM to the owned group, waits for group exit, then uses SIGKILL after the stop timeout.
Do not confuse shell exit with complete process-group exit.
Never signal a stored PID after ownership is uncertain or the PID was reused.
Commands must keep their service in the foreground and must not escape the owned process group.

Persist run identity and exit details. Old run callbacks cannot change the current run's state.
After abnormal manager exit, inspect previous run identities before autostart.
If a previous ordinary process is still alive, report an ownership conflict and block duplicate startup for that entry.
Do not attach to it or silently stop it. Show the operator the recorded run and process identity for manual resolution.
Compose recovery reads Docker state and resumes observation of the configured project.

### State contract

Service state: `stopped`, `starting`, `running`, `stopping`, or `exited`.
Task state: `idle`, `running`, `stopping`, `succeeded`, `failed`, or `stopped`.
Health: `not-applicable`, `no-check`, `checking`, `healthy`, `unhealthy`, or `unknown`.
Keep operation failure separate from service state.
A process can be running and unhealthy after a startup timeout.
A process without a health check is running, not confirmed ready.

Task exit code zero records success for the current manager session and active task definition.
A later explicit Run replaces that result. A failed rerun cannot reuse an earlier success.
Changing a task command or working folder clears its cached success.
Changing a task's prerequisite definitions clears its cached success conservatively.
A manager restart always clears task success used for dependencies.
A metadata-only reload does not clear task success.

### Dependency and restart contract

Build a startup graph from explicit `depends_on` references.
Build a restart graph from each service's settings:

- `restart_dependencies` creates edges to its direct service prerequisites.
- `restart_dependents` creates edges to services that directly depend on it.
- Tasks satisfy startup requirements but do not participate as restart targets.

Validate both graphs across all projects before applying config.
Reject cycles and report the complete cycle path and graph name.
The API/DB example with mutual restart selection is invalid, even if startup dependencies have no cycle.

Start recursively starts missing prerequisites in dependency order.
Wait for process checks, successful tasks, or Compose startup conditions before starting a dependent.
Recheck current readiness for an already-running prerequisite. Do not use an old healthy result after it becomes unhealthy.
Without a health check, process-running status satisfies the limited startup condition. Do not claim application readiness.
A failure blocks not-yet-started dependents. Leave prerequisites already started by that operation running.

Restart computes the full recursive selection before stopping anything.
Take the included services' running-state snapshot at operation start.
Stop selected running services in reverse dependency order.
Start them in dependency order, applying the normal startup rules.
The explicitly selected root can start if it was stopped. Other stopped restart targets stay stopped.
A stopped prerequisite can start only when the normal startup rules require it.
A successful task is not rerun merely because a service restarts.
If readiness fails during restart, downstream selected services remain stopped and show the blocking reason.

Ordinary Stop changes only the selected service. It does not apply restart rules.
A project or Compose group Stop explicitly selects that target's entries. It does not include external dependents.
Project Start starts all project services and runs its tasks, with duplicate prerequisites removed.
Project Restart selects that project's currently running services, then applies restart rules.
Project Start can reach cross-project prerequisites; its result lists every affected entry.

Use one operation queue initially. Coalesce dependency starts inside an operation.
Reject duplicate conflicting actions with `OPERATION_BUSY`; do not launch duplicate processes.
Read operations and log streaming remain available during an operation.
Reload and CLI config changes use the same queue.

### Readiness and operation results

HTTP success requires the configured status code.
TCP success requires a connection within the check timeout.
Command success requires exit code zero before its timeout.
Terminate a timed-out command check's owned process group. This does not stop the service.
Never overlap checks for one entry or leave command-check children behind.
Treat command checks as user code. Do not present them as passive checks.

Start, Run, Restart, and Stop wait for their operation result by default.
`--no-wait` returns an operation ID after acceptance. It does not skip dependencies or change startup order.
The background operation still follows readiness deadlines.
A readiness timeout marks the operation failed and leaves its running services available for inspection.
Continuing probes can update health later, but do not automatically start the blocked dependents.

### Compose contract

Use Docker Compose v2 through the `docker compose` command.
Run its normalized config command to discover services and dependency conditions.
Do not implement a second parser for Compose interpolation, profiles, or file semantics.
Use the captured environment and effective group directory for Compose commands.
Refresh discovery at startup and explicit config reload, not on file changes.

Show one row for each discovered Compose service, even when no container exists yet.
For replicated services, show aggregate state and retain container identity in details and log records.
All expected running containers must meet the service's check condition before it satisfies readiness.
Use Compose health when present. Otherwise report running status, not verified application readiness.
Honor Compose dependency conditions for Compose startup. Servicemon adds only its explicit entry dependencies.

Use Compose start/create commands for Start and Compose Stop for Stop.
Implement Restart as the planned stop/start operation, not an uncontrolled alternate restart path.
For per-service Stop, do not stop neighbors or remove networks and volumes.
For whole-group controls, list affected services and apply the same readiness and operation rules.
Do not use `down` for manager shutdown or ordinary Stop.

Follow Docker logs with service and container labels. Docker remains the source of Compose log retention.
Reconnect observation after a container replacement without claiming a fixed container ID.
Surface Docker absence, daemon failure, invalid Compose config, and stopped log streams as explicit errors.

### Logs contract

Write process and task output as structured records with entry ID, run ID, sequence, timestamp, stream, and text.
Mark run boundaries. Keep stdout and stderr distinct.
Keep bounded chunks for output without newlines. Do not retain an unbounded partial line.
Preserve split UTF-8 characters across input chunks.
Drain process output even when no browser or CLI subscriber exists.

Rotate log segments and remove the oldest retained data first.
Apply both per-entry and total byte limits, including logs from removed entries.
Do not let slow subscribers block process output. Report a gap and let the client request retained history.
Expose retained history and live streaming with a cursor.
If a cursor predates retained data, return the oldest available cursor and a gap marker.
Avoid duplicates at the transition from history to live output.
Render log text as text, never HTML.
Do not store complete environment snapshots in logs.
If disk logging fails, keep draining output, show the failure, and use a bounded live buffer. Never claim persistence succeeded.

### CLI contract

```text
servicemon serve [--background] [--config PATH] [--ui FILE]
servicemon manager status [--json]
servicemon manager stop [--json]
servicemon startup enable [--json]
servicemon startup disable [--json]
servicemon config path [--json]
servicemon config validate [--config PATH] [--json]
servicemon reload [--json]
servicemon project list|add|remove ... [--json]
servicemon service list|add|remove ... [--json]
servicemon task list|add|remove ... [--json]
servicemon compose list|add|remove ... [--json]
servicemon status [TARGET] [--json]
servicemon start TARGET [--no-wait] [--json]
servicemon stop TARGET [--no-wait] [--json]
servicemon restart TARGET [--no-wait] [--json]
servicemon run TASK_ID [--no-wait] [--json]
servicemon logs ENTRY_ID [--follow] [--tail N] [--json]
servicemon operation OPERATION_ID [--json]
```

Use qualified entry IDs for service and task targets.
Use `--project PROJECT_ID` or `--compose PROJECT_ID/GROUP_ID` for explicit aggregate targets.
Require one target selector. Do not infer aggregate targets from an ambiguous name.
Add commands accept named flags for the applicable schema fields. Help lists required fields and examples.
Generated Compose services are changed through their group or overrides, not duplicated as command entries.
Removing a referenced entry fails unless the same config change removes its references.

Definition commands work offline. With an active manager, send the proposed edit through the manager.
When offline, validate and atomically write the file without starting services.
When online, write the accepted edit and apply it immediately through the reload contract.
Runtime commands require an active manager; they do not silently start one.
Repeated serve returns the existing endpoint for the same config and reports a conflict for a different config.

JSON results use an envelope with `ok`, `data`, and `error`.
Errors have a stable code, message, and applicable entry or operation IDs.
Log streaming uses one JSON record per line. Send human progress only to stderr in JSON mode.
Never mix terminal styling with JSON stdout.
Exit codes: `0` success, `1` operation failure, `2` invalid input/config, `3` unavailable manager/tool, `4` readiness timeout, `5` conflict.

### Local server contract

Serve built assets and the internal control API from the same localhost origin.
Use a static asset server, not Vite's development or preview server, for installed operation.

```text
GET  /api/status
GET  /api/projects
GET  /api/entries
GET  /api/config/path
POST /api/config/reload
POST /api/entries/:id/start
POST /api/entries/:id/stop
POST /api/entries/:id/restart
POST /api/entries/:id/run
POST /api/projects/:id/actions
POST /api/compose-groups/:id/actions
GET  /api/operations/:id
GET  /api/entries/:id/logs
GET  /api/events
```

Action endpoints return an operation ID. CLI wait mode observes that operation.
Encode qualified IDs as complete path segments. Do not split them accidentally at `/`.
Events include ordered state changes, operation results, and log records.
Clients first receive a snapshot and cursor, then changes after that cursor.
On a gap or reconnect, refresh the snapshot and resume logs from retained cursors.

Bind to loopback only. Reject invalid Host headers and cross-origin control requests.
Allow local CLI and browser access without authentication. Require a matching Origin header for HTTP mutations.
Do not enable wildcard CORS. A third-party website must not be able to start local commands.
This protects browser-origin access; it does not isolate local users or programs.

`--ui FILE` replaces the root page with the specified `.html` or `.htm` file.
Require an existing readable file with that extension. Do not inspect its feature compatibility.
Serve relative assets only within its folder. Reject traversal and symlink escape.
Keep internal API routes available, without a public compatibility promise.
Apply the same Host and Origin rules. Do not require custom UI plugins or injected control code.
An invalid custom file fails serve; it does not silently select the built-in dashboard.

### Reload contract

1. Read the proposed YAML and any changed Compose definitions.
2. Validate schema, paths, references, and both graphs.
3. Capture a fresh login-shell environment into a candidate snapshot.
4. Build the full change set before stopping an entry.
5. Stop removed entries and entries with changed execution definitions.
6. Commit the active config, compiled graphs, Compose discovery, and environment snapshot.
7. Preserve unchanged running processes, their environment, and compatible task results.
8. Return affected IDs and stop results. Do not start new definitions.

Execution changes include command, working folder, Compose identity/file/discovered execution definition, and entry kind.
Notes, names, links, autostart, restart settings, dependencies, and check settings can change without an automatic service restart.
Reset check observation when its definition changes. Clear affected task success when task prerequisites change.
A global environment refresh alone does not restart existing processes.
Removing a Compose entry stops its configured containers under stop-and-apply. Manager shutdown remains a separate keep-containers action.

Invalid input, failed Compose discovery, or failed environment capture leaves the previous config active and stops nothing.
If stopping an affected entry fails, retain the old active config and report the partial stop results.
Do not restart entries already stopped during a failed reload.
A manually edited file can remain invalid while the old config runs. Show that difference explicitly.

CLI edits preserve unrelated YAML nodes through the document API.
Do not promise byte-identical formatting or stable placement of all trailing comments.
Detect external file changes before replacement. Refuse a stale write rather than overwriting another editor's changes.
Write through a private temporary file and atomic replacement in the config folder.
Serialize online writers through the manager and offline writers through a config lock.

### Background and login contract

Foreground serve stays attached to the terminal. SIGINT and SIGTERM perform the approved manager shutdown.
Background serve starts the same manager with detached terminal I/O and reports its endpoint only after startup succeeds.
Write manager diagnostics separately from service logs.
Closing a terminal or browser must not stop background mode.

Use a per-user LaunchAgent for optional login startup.
Store absolute executable, application, and config paths. Do not depend on launchd's default PATH.
Use one LaunchAgent identity and the same manager lock as manual serve.
Do not set restart-on-failure behavior that changes the approved failure policy.
Enable registers login startup. Disable removes login startup without stopping the current manager.
Manager Stop prevents a launchd restart and stops owned processes and tasks, but leaves the enabled login setting intact for the next login.
Test manual startup, login-startup registration, disable, and Stop as distinct transitions.

### Dashboard contract

Use the approved layout, not the discarded comparison layouts.

Toolbar:

- Servicemon name.
- Global search, with Command-K focus.
- Copy config path.
- Project selector.
- Reload config in a standard action menu.

Table columns:

- Service / task.
- Project.
- State.
- Health.
- Command / Compose group.
- Controls.

Use official shadcn Tasks and Data Table examples as the starting point.
Use their faceted filter composition for categorical fields and their standard text input for text fields.
Place filter triggers in data-column headers as approved. Do not give the Controls column a filter.
Use official Dropdown Menu, Button, Select or Combobox, Tabs, Tooltip, and Resizable compositions as applicable.
Use one primitive family consistently. Do not combine incompatible Radix and Base UI examples.
Implement column sizing through TanStack Table. Separate resize handles from filter and sort triggers.

Combine global search, project selection, and column filters before pagination.
Reset or clamp the page when filtering removes its rows.
Keep table scrolling inside the table region. Keep pagination and row controls accessible with logs open.
Start and Run controls reflect entry kind and state. Active operations disable conflicting controls.
Provide explicit project and Compose group controls through standard menus.
Show notes, links, blocking reasons, and exit details through an accessible detail surface.
Do not claim an unhealthy process is stopped or stuck.

Logs opens or selects the entry's existing bottom-panel tab.
Provide one tab per service or task, close controls, and a dark log surface.
Resize the panel from its top edge. Keep minimum usable space for the table and log controls.
Closing the final tab hides the panel. Hiding logs stops no services.
Switching tabs retains each tab's cursor and follow setting.
Follow scrolls to new output. Manual scrolling pauses follow until the user enables it again.
Display run boundaries, timestamps, stdout/stderr, retained-history gaps, and Compose container labels.

Include loading, no-project, no-match, disconnected-manager, invalid-reload, failed-operation, and unavailable-log states.
Support keyboard use and accessible names for icon controls and resize handles.
Do not implement definition-editing forms.

## Error behavior

| Condition                                    | Required behavior                                                                                              |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Invalid YAML, schema, reference, or graph    | Show source location where available, stable error code, and exact cycle path where applicable. Apply nothing. |
| Missing working folder or executable         | Fail the requested run with entry ID and reason. Preserve available logs.                                      |
| Command exits unexpectedly                   | Record exit code or signal. Leave it exited. Do not restart it.                                                |
| Dependency fails                             | Block dependent startup. Leave already-started prerequisites running.                                          |
| Readiness deadline expires                   | Return timeout and operation ID. Leave running processes untouched.                                            |
| Health fails after startup                   | Update health only. Do not stop, restart, or affect neighbors.                                                 |
| Stop deadline expires                        | Force-stop only the owned group, then report the observed result.                                              |
| Docker absent or unavailable                 | Fail Compose actions with tool details. Do not fabricate container state.                                      |
| Manager unavailable                          | Runtime CLI returns unavailable. Definition commands can still edit config offline.                            |
| Concurrent conflicting action                | Return conflict with the active operation ID. Start no duplicate run.                                          |
| Invalid config on disk during reload         | Keep the previous config active and expose reload failure.                                                     |
| Partial stop failure during reload           | Keep the previous active config. Report all observed stopped and failed entries.                               |
| Stale CLI config write                       | Refuse replacement. Preserve external edits.                                                                   |
| Log retention removes a cursor               | Report a gap and supply the oldest available history.                                                          |
| Logging disk error                           | Report persistence failure and continue bounded live capture.                                                  |
| Abnormal manager exit leaves a command alive | Report ownership conflict. Block duplicate startup and do not attach or signal an uncertain PID.               |
| Custom UI path invalid                       | Fail serve with the file error. Do not add compatibility analysis.                                             |

## Test strategy

Test consumer-visible behavior, transitions, graph boundaries, and ownership safety.
Do not test copied component source, import wiring, exact wording, or incidental default values.

Use temporary config and state folders for all automated tests.
Use short real child processes for process ownership tests. They must clean up their full process groups.
Use loopback servers for HTTP and TCP readiness tests.
Use controllable command fixtures for timeouts, task success, failure, and child cleanup.
Use fake time only where it cannot hide process or stream behavior.

Required regression cases:

- Both graph cycle types, cross-project edges, missing targets, and duplicate IDs.
- Recursive restart, stopped included targets, shared prerequisites, and readiness failure during restart.
- Successful task reuse, explicit rerun failure, definition change, and manager-session reset.
- Process-group termination, shell exit before children, stale run events, and PID ownership checks.
- Health failure without automatic recovery and timeout without service termination.
- Output without newlines, split UTF-8, rotation boundaries, slow subscribers, and history/live gaps.
- Invalid reload without side effects, metadata-only reload, stop-and-apply, partial stop failure, and stale config writes.
- JSON stdout cleanliness, operation exit codes, and no-wait result observation.
- Aggregate Compose state, individual Stop, preserved volumes, and manager shutdown with containers still running.
- Combined filters, page clamping, resizing, keyboard controls, log tabs, and visible last-row actions.
- Loopback Host/Origin rejection, plain local access, log HTML safety, and custom asset path boundaries.

Run Docker tests only through an explicit Compose test command.
Use an isolated project name, temporary fixture directory, and no host-mounted user data.
Clean up only the fixture containers and volumes created by that test.
Do not exercise the user's normal projects during automated verification.

Tests do not replace smoke runs. Run the installed CLI, actual manager, built dashboard, and real Compose fixture.

## Implementation tasks

Use the package commands below for verification.
Do not implement multiple partially working components before a runnable slice exists.

### Task 1: Serve an installed built dashboard

**Result:** An installed `servicemon` command serves a built React page from localhost.

**Files and symbols:** New package/build configs, `src/cli/main.ts`, `src/server/server.ts`, `src/web/`, shared types, and `scripts/smoke.mjs`.

**Contract:** CLI package entry, production static assets, loopback server, and test commands.

**TDD:** not applicable — initial build setup requires a real installed-package smoke run, not wiring tests.

**Test seam:** Packed npm installation and HTTP response from the actual CLI.

**Steps:**

1. Select suitable maintained libraries, including an established CLI library, and create the TypeScript, Node, React, Vite, and npm setup.
2. Add scripts: `build`, `typecheck`, `test`, `test:e2e`, `test:compose`, `smoke`, and `smoke:compose`.
3. Define `test` as `vitest run`, and support paths after `npm test --`.
4. Make `smoke` run the real CLI against temporary config and state folders.
5. Build dashboard assets and include them with the CLI in `npm pack`.
6. Serve built assets on loopback and implement clean server shutdown.

**Verification:** `npm run build && npm pack`; install the packed file in a temporary folder, run `servicemon serve`, and request its root page.

**Depends on:** none.

### Task 2: Load central config and enforce one manager

**Result:** Serve selects one validated central config and reports the active endpoint without creating a second manager.

**Files and symbols:** `src/config/paths.ts`, `src/config/schema.ts`, `src/manager/instance.ts`, `src/manager/environment.ts`, `src/cli/serve.ts`, `tests/config/`, `tests/manager/`.

**Contract:** Config path resolution, private state, single-manager lock, environment snapshot, and custom root file selection.

**TDD:** required — competing startup, stale ownership, and shell capture failures can create unsafe states.

**Test seam:** Two real serve invocations using isolated state, plus controlled login-shell fixtures.

**Steps:**

1. Implement config/state defaults and test-only explicit state-directory selection.
2. Parse global settings and project definitions without executing service commands.
3. Capture exported login-shell variables through a separate data channel.
4. Implement manager lock, instance record, same-config reuse, and different-config conflict.
5. Validate custom HTML paths and limit their static asset root.
6. Fail startup before autostart when config or environment capture fails.

**Verification:** `npm test -- tests/config tests/manager/instance.test.ts tests/manager/environment.test.ts`; run serve twice and observe one manager endpoint.

**Depends on:** 1.

### Task 3: Validate and edit complete project definitions

**Result:** CLI users can validate, add, list, and remove definitions without losing unrelated settings.

**Files and symbols:** `src/config/schema.ts`, `src/config/document.ts`, `src/config/compile.ts`, `src/cli/definitions.ts`, `src/shared/ids.ts`, `tests/config/`.

**Contract:** Versioned YAML shape, qualified IDs, resolved folders, atomic edits, and compiled definition input for the manager.

**TDD:** required — invalid references, duplicate names, and stale writes must not corrupt config.

**Test seam:** Real CLI edits of temporary commented YAML files.

**Steps:**

1. Complete strict schemas for services, tasks, groups, checks, and global settings.
2. Implement path and qualified-reference resolution.
3. Reject duplicate keys, duplicate entry IDs, and invalid names.
4. Implement offline list/add/remove and config validate/path commands.
5. Use document-node edits, external-change detection, and atomic file replacement.
6. Connect Compose discovery validation through the contract completed in Task 7.

**Verification:** `npm test -- tests/config`; add a service to a commented config, validate it, list it, and remove it through the actual CLI.

**Depends on:** 2.

### Task 4: Run and stop owned processes with persistent logs

**Result:** Start, Run, and Stop operate real commands in the correct folders and retain output after exit.

**Files and symbols:** `src/process/runner.ts`, `src/process/ownership.ts`, `src/logs/store.ts`, `src/manager/state.ts`, `tests/process/`, process fixtures.

**Contract:** Owned process group, run identity, state transitions, exit details, retained log records, and shutdown hook.

**TDD:** required — wrong-PID signals, escaped children, and stale callbacks affect other work.

**Test seam:** Real commands with children, controlled signals, temp working folders, and retained output.

**Steps:**

1. Spawn command strings with captured environment, working folder, and isolated process group.
2. Record service/task state and run identity without guessing application readiness.
3. Drain stdout/stderr into bounded chunks and rotated persistent segments.
4. Implement SIGTERM, group-exit wait, and SIGKILL escalation.
5. Preserve exited state and logs without automatic recovery.
6. Guard against old callbacks and uncertain or reused process identities.
7. Detect previous live run conflicts during manager startup.

**Verification:** `npm test -- tests/process`; start a child-producing fixture, stop it, confirm all owned children exit, and read its logs after manager restart.

**Depends on:** 2, 3.

### Task 5: Apply dependency, task, and restart rules

**Result:** Requested starts and restarts follow the approved graphs and report every affected entry.

**Files and symbols:** `src/manager/graphs.ts`, `src/manager/operations.ts`, `src/manager/tasks.ts`, `src/config/compile.ts`, `tests/manager/graphs.test.ts`, `tests/manager/operations.test.ts`.

**Contract:** Validated startup/restart graphs, operation queue, session task results, target selection, and adapter action interface.

**TDD:** required — recursive selections, task reuse, and stopped-state preservation have consumer-visible boundaries.

**Test seam:** Operation results and observed launch/stop order for real fixture services and tasks.

**Steps:**

1. Compile both graphs and report exact cycle paths across projects.
2. Plan starts, project actions, and recursive restart selections before execution.
3. Apply reverse stop order and forward start order.
4. Implement session task success and explicit rerun behavior.
5. Preserve stopped included targets and start only required missing prerequisites.
6. Serialize operations and reject conflicting submissions.
7. Apply autostart only during the manager startup phase.

**Verification:** `npm test -- tests/manager/graphs.test.ts tests/manager/operations.test.ts`; run database/API/UI fixtures and observe recursive restart with an intentionally stopped UI.

**Depends on:** 3, 4.

### Task 6: Wait for readiness without failure recovery

**Result:** HTTP, TCP, and command checks gate startup while unhealthy services remain available for inspection.

**Files and symbols:** `src/manager/health.ts`, `src/manager/operations.ts`, `tests/manager/health.test.ts`, health fixtures.

**Contract:** Check result, current health, startup deadline, canceled check cleanup, and no-wait operation continuation.

**TDD:** required — timeouts must not kill services or accidentally start blocked dependents.

**Test seam:** Real loopback endpoints, delayed responses, and timeout-producing command checks.

**Steps:**

1. Implement HTTP expected-status checks, TCP connections, and command checks.
2. Bound each check and prevent overlapping checks.
3. Use current prerequisite readiness rather than an old success.
4. Fail startup operations at the readiness deadline without stopping running entries.
5. Keep ongoing health observation independent of restart and stop actions.
6. Show late health recovery without automatically launching blocked dependents.

**Verification:** `npm test -- tests/manager/health.test.ts`; start an unhealthy fixture, observe a timeout, and confirm its process remains running and its dependent remains stopped.

**Depends on:** 4, 5.

### Task 7: Control real Compose services and groups

**Result:** Registering a Compose file exposes individual services with truthful state, checks, logs, and group controls.

**Files and symbols:** `src/compose/discovery.ts`, `src/compose/adapter.ts`, `src/compose/logs.ts`, `tests/compose/`, isolated Compose fixtures, `scripts/smoke-compose.mjs`.

**Contract:** Discovered service definitions, configured Compose project identity, adapter actions, aggregate container state, and Docker log source.

**TDD:** required — service-specific Stop, container replacement, and retained volumes must remain correct.

**Test seam:** Actual Docker Compose v2 fixture with two services, health checks, and an isolated volume.

**Steps:**

1. Discover services and Compose dependencies from normalized Compose config output.
2. Merge overrides and validate generated IDs and references.
3. Implement individual and whole-group actions through the operation planner.
4. Observe container state and native health without interpreting command exit as container exit.
5. Follow logs with container identity and reconnect after replacement.
6. Preserve containers at manager shutdown and preserve volumes during service controls.
7. Complete config validation for missing overrides and duplicate Compose identities.

**Verification:** `npm run test:compose && npm run smoke:compose`; stop one fixture service, inspect the other, stop the manager, and verify its remaining container and volume persist.

**Depends on:** 3, 5, 6.

### Task 8: Expose complete CLI controls and agent output

**Result:** Humans and agents control services, observe operations, and stream retained/live logs through the installed CLI.

**Files and symbols:** `src/cli/actions.ts`, `src/cli/output.ts`, `src/server/api.ts`, `src/server/events.ts`, `src/shared/protocol.ts`, `tests/cli/`, server access tests.

**Contract:** CLI syntax, JSON envelope, exit codes, plain local access, action endpoints, operation observation, and event/log cursors.

**TDD:** required — acceptance versus completion, exit codes, cursor gaps, and cross-origin requests need fixed behavior.

**Test seam:** Installed CLI subprocesses and real HTTP/event-stream clients.

**Steps:**

1. Add status, actions, operations, and history/live log endpoints.
2. Allow plain local access and send a matching Origin header from CLI mutations.
3. Reject cross-origin control requests and invalid Host headers.
4. Implement wait-by-default and no-wait operation IDs.
5. Implement human text, JSON results, NDJSON logs, and stable exit codes.
6. Connect history to live output without loss or duplication.
7. Keep stdout valid JSON while reporting progress on stderr.

**Verification:** `npm test -- tests/cli tests/server`; run Start with `--json`, observe `--no-wait`, follow logs, and attempt a rejected foreign-origin control request.

**Depends on:** 5, 6, 7.

### Task 9: Run in background and at login

**Result:** Background mode survives terminal closure, and explicit login-startup commands manage a LaunchAgent safely.

**Files and symbols:** `src/cli/background.ts`, `src/manager/shutdown.ts`, `src/manager/launch-agent.ts`, `tests/manager/background.test.ts`, `tests/manager/startup.test.ts`.

**Contract:** Detached serve, ready endpoint, diagnostics, approved manager shutdown, and independent login setting.

**TDD:** required — duplicate startup and shutdown transitions can leave commands running or restart an explicitly stopped manager.

**Test seam:** Actual background CLI plus a temporary LaunchAgent identity in the user's test session.

**Steps:**

1. Detach background serve and wait for actual manager startup.
2. Route manager diagnostics to its private log files.
3. Implement manager status and Stop, including all owned active tasks.
4. Generate and register an opt-in LaunchAgent with absolute paths.
5. Keep enable, disable, and current manager Stop as separate actions.
6. Avoid restart-on-failure and enforce the shared instance lock.
7. Preserve Compose containers through every normal manager shutdown path.

**Verification:** `npm test -- tests/manager/background.test.ts tests/manager/startup.test.ts`; close the starting terminal, query status, stop the manager, and inspect fixture process/container state.

**Depends on:** 2, 4, 7, 8.

### Task 10: Apply config changes safely

**Result:** Explicit reload and online CLI edits update definitions immediately under the approved stop-and-apply rule.

**Files and symbols:** `src/config/reload.ts`, `src/config/document.ts`, `src/manager/operations.ts`, `src/cli/definitions.ts`, `tests/config/reload.test.ts`.

**Contract:** Candidate config/environment, full change set, affected-entry stops, active-config commit, and stale-write rejection.

**TDD:** required — invalid candidates and partial stops must not replace a usable active config.

**Test seam:** Edit real temporary YAML while fixture services run and inspect active config plus process state.

**Steps:**

1. Validate YAML, Compose discovery, both graphs, and candidate environment before side effects.
2. Classify metadata, dependency/check, and execution changes.
3. Stop removed or execution-changed entries, then commit the candidate.
4. Preserve unchanged processes and reset only invalid task results and check observations.
5. Route online definition edits through the manager queue.
6. Report partial stop failures without restarting stopped entries.
7. Ensure reload never runs new autostart entries.

**Verification:** `npm test -- tests/config/reload.test.ts`; change one command while another service runs, reload, and confirm only the changed entry stops.

**Depends on:** 3, 5, 7, 8.

### Task 11: Build the approved service table with standard controls

**Result:** The built dashboard shows real state and controls in the approved layout, without custom filter or menu designs.

**Files and symbols:** `src/web/app.tsx`, `src/web/components/`, `src/web/table/`, standard shadcn components, `tests/web/table.spec.ts`.

**Contract:** Status snapshot/events, operation submission, project/group controls, config-path copy, and reload result.

**TDD:** required — combined filters, pagination, disabled actions, and keyboard use can hide required controls.

**Test seam:** Actual built dashboard in Playwright, backed by the real manager and fixture services.

**Steps:**

1. Start from official shadcn Tasks, Data Table, faceted filter, and Dropdown Menu examples.
2. Implement the toolbar and approved columns with TanStack Table sizing.
3. Add global search, project selection, column filters, and 20-entry pagination.
4. Add state-specific service/task controls and explicit project/group menus.
5. Show notes, links, exit details, and blocked-operation reasons.
6. Add Copy config path and Reload config without definition forms.
7. Verify custom HTML root serving and asset boundaries separately from dashboard behavior.

**Verification:** `npm run test:e2e -- tests/web/table.spec.ts`; open the built dashboard, combine filters, resize columns, and control a real fixture service.

**Depends on:** 8, 10.

### Task 12: Stream logs in the dark resizable tab panel

**Result:** Clicking Logs opens retained and live output in one tab per entry below the table.

**Files and symbols:** `src/web/logs/`, `src/web/components/log-panel.tsx`, `src/logs/store.ts`, `tests/web/logs.spec.ts`, `tests/process/logs.test.ts`.

**Contract:** Log history/live cursors, tab state, follow state, dark rendering, panel sizing, and log error/gap display.

**TDD:** required — switching tabs, retention gaps, unsafe output, and resizing must not lose or hide output.

**Test seam:** Built dashboard with streaming fixture output, plus persistent log-store boundary tests.

**Steps:**

1. Compose standard Tabs and Resizable components into the approved bottom panel.
2. Open or select one existing tab per entry.
3. Join retained history to live records and show run boundaries and gaps.
4. Preserve each tab's cursor and follow setting.
5. Pause follow on manual scroll and restore it only on user action.
6. Keep table pagination and final-row controls usable at supported desktop sizes.
7. Render hostile log strings as text and bound client-side retained output.

**Verification:** `npm test -- tests/process/logs.test.ts && npm run test:e2e -- tests/web/logs.spec.ts`; observe multiple live tabs, resize the panel, and read logs after a process exits.

**Depends on:** 4, 8, 11.

### Task 13: Deliver and document the complete installed workflow

**Result:** A clean packed installation supports the approved CLI, background manager, dashboard, and Compose workflow.

**Files and symbols:** Package asset inclusion, `scripts/smoke.mjs`, `scripts/smoke-compose.mjs`, `README.md`, `CHANGELOG.md`, `docs/config.md`, `docs/cli.md`, `docs/operations.md`.

**Contract:** Installable package, reproducible commands, documented config/ownership limits, and complete acceptance evidence.

**TDD:** not applicable — this task exercises the integrated runtime and updates user documentation after proof.

**Test seam:** Packed installation, real background manager, built browser UI, and isolated real Compose project.

**Steps:**

1. Complete smoke scenarios for dependencies, tasks, restart rules, reload, logs, and shutdown.
2. Run the acceptance matrix against the installed package, not only source-mode commands.
3. Register and remove an isolated test LaunchAgent without changing the user's real login setting.
4. Verify a launchd-started manager receives the expected login-shell tool paths.
5. Document commands, fields, exit codes, log retention, failure behavior, and custom UI limits.
6. Include generic service, task, and Compose examples without secrets or autostart.
7. Update the changelog after successful smoke proof.
8. Remove throwaway verification files and fixture resources created outside the permanent test fixtures.

**Verification:** Run the Final verification procedure below and record observed results against A01–A27.

**Depends on:** 9, 10, 11, 12.

## Final verification

No implementation verification has run yet. This section defines the required completion checks.

After Task 1 creates the package commands, run:

```text
npm run typecheck
npm test
npm run build
npm run test:e2e
npm run test:compose
npm run smoke
npm run smoke:compose
npm pack
```

Then exercise the packed installation:

1. Install the packed package in a temporary folder and use its actual CLI entry.
2. Create a temporary config with at least two projects and real short-lived fixture commands.
3. Start background serve and confirm one manager survives terminal closure.
4. Start a dependent service and observe prerequisite order and task completion.
5. Produce a readiness timeout and confirm the process remains running.
6. Restart a service through recursive rules while an included dependent is intentionally stopped.
7. Read JSON status, wait for a no-wait operation, and follow NDJSON logs.
8. Reload invalid YAML and confirm the previous config remains active.
9. Change a running command and confirm stop-and-apply does not start its replacement.
10. Reload the environment and confirm existing processes retain their original variables.
11. Open the built dashboard and exercise filters, page changes, column sizing, controls, and log tabs.
12. Test the last table row with logs open at desktop widths of 1152 and 1440 pixels.
13. Serve a custom HTML file and verify it replaces the root page without exposing files outside its folder.
14. Exercise an isolated Compose group, individual service actions, health, and container log replacement.
15. Stop the manager and confirm owned processes exit while fixture containers and volumes remain.
16. Enable and disable an isolated login-startup registration and confirm manager Stop does not trigger a restart.
17. Remove only verification resources created by these procedures.
18. Record each acceptance criterion's observed result. Report any untested surface explicitly.

Do not use the user's active development projects as test fixtures.
Do not report completion from unit tests or compilation alone.

## Reference sources

- [Official shadcn Tasks example](https://ui.shadcn.com/examples/tasks).
- [Official shadcn Data Table guide](https://ui.shadcn.com/docs/components/data-table).
- [Official shadcn Dropdown Menu guide](https://ui.shadcn.com/docs/components/dropdown-menu).
- [Node.js 24 child process documentation](https://nodejs.org/docs/latest-v24.x/api/child_process.html), checked through Context7 during planning.
- [Vite build command](https://github.com/vitejs/vite/blob/v8.0.10/docs/guide/cli.md), checked through Context7 during planning.
- [YAML document API](https://github.com/eemeli/yaml/blob/main/docs/04_documents.md), checked through Context7 during planning.
- [YAML comment handling limits](https://github.com/eemeli/yaml/blob/main/docs/05_content_nodes.md), checked through Context7 during planning.
- Local `~/tilt/Tiltfile` and the approved temporary dashboard mockup.
