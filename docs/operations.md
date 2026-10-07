# Operations

## Ownership

The manager binds to `127.0.0.1`. It has one exclusive lock in the private state folder, not one lock per config. Default state: `~/Library/Application Support/servicemon`. `SERVICEMON_STATE_DIR` selects another state folder for tests or isolated operation. Do not change it to bypass the normal single-manager rule.

The state folder is owner-only. Instance records, process ownership records, and logs are private files. Manager records include a PID, start identity, config path, endpoint, and lock ownership token. Do not publish them. The login environment is not included in status output. File permissions do not restrict access through the local HTTP API.

Owned commands run through a non-interactive shell in detached process groups. Stop sends a graceful signal to the owned group, waits for its deadline, then force-stops that same verified group. PID reuse or uncertain ownership must not cause an unrelated process to be signalled. Ordinary external processes are not attached, discovered by port, or stopped. Commands must remain foreground; do not use daemon mode or shell backgrounding.

Manager shutdown rejects new actions, stops owned services and active tasks, and waits for all active operations to finish. It closes Docker observation but leaves Compose containers and volumes running. Closing the browser has no effect on service lifetime.

If the manager stops, the dashboard keeps the last state and shows an unavailable message. After the manager starts again on the same port, use Retry or reload the page. If the port changed, run `servicemon dashboard` to open the current URL. A manager restart resets task results; retained process/task logs remain available.

## Dashboard

The default view groups entries by project. Click a project or Compose group row to expand or collapse it. The arrow also works with keyboard input. The Actions menu does not change the expanded state. Select Ungrouped to sort across projects. State and type filters are separate. Search includes commands even when their column is hidden. Select Columns to show or hide Type, State, Health, Endpoint, and Cmd / Compose file. Project is also available in Ungrouped. The entry name and Controls remain visible. Column choices stay set when you change the grouped view. Endpoint links come from configured links; the dashboard does not guess addresses.
Type and Cmd / Compose file are hidden by default. Use Columns to show them. The Type filter remains available when its column is hidden.
Services without a health check display `-`, whether running or stopped. Services with a health check also display `-` in grey when stopped, exited, or failed; `Healthy` in green when the check passes; `Unhealthy` in red when it fails; and `Checking` in amber while the check is in progress. A live service whose result is not known displays `Unknown`. Compose entries use their Docker health checks. Tasks display `N/A`. Missing endpoints display `-`. Health filters use these same display states, with one `-` option for stopped services and services without checks.

Click a value in Cmd / Compose file to copy its full text, including text hidden by the ellipsis. The same action works with Enter or Space. A toast at the bottom says "Copied to clipboard" when the copy succeeds. If the copy fails, the toast says "Could not copy to clipboard". Drag a boundary line in the column header to resize it. You can also focus the boundary and use the Left or Right arrow key.

Project and Compose group actions appear beside their groups. Group Stop actions require confirmation. Entry Stop does not add a confirmation step. Settings contains Copy config path and Reload config. The existing stop-and-apply prompt remains available when reload requires it.
Entry controls appear in this order: Start, Run, or Stop; Restart when a service or Compose entry is running; Logs. Tasks and entries that are not running do not show Restart. An active operation disables controls for its reserved entries, including prerequisites that have not started. Unrelated entry controls remain available. Project and Compose group Actions menus retain Start, Stop, and Restart; their actions are disabled when any member is reserved. Reload config is disabled while an operation is active. Logs remain available.

Select Logs to open retained output. The log controls and retention rules are described below.

## Failures

| Condition                    | Result                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| Invalid initial config       | Manager startup fails                                              |
| Invalid reload               | Previous valid config stays active; dashboard shows the error      |
| Missing folder or executable | Requested run fails with entry details                             |
| Command exits                | Exit code or signal is recorded; no automatic restart              |
| Dependency fails             | Dependent startup is blocked; started prerequisites remain running |
| Readiness deadline expires   | Operation fails; running process remains running                   |
| Health fails after startup   | Health changes only; neighbors are not stopped                     |
| Stop deadline expires        | Only the verified owned group is force-stopped                     |
| Docker unavailable           | Compose action fails with tool details; no invented state          |
| Manager unavailable          | Runtime CLI action fails; it does not start a manager silently     |
| Log source unavailable       | Error is shown; previous text is not replaced with invented output |
| Custom UI missing or invalid | Serve fails with the file error                                    |

Each operation reserves its scope before execution. The scope includes selected entries, startup prerequisites, and entries included by restart rules. Compose actions also reserve the other entries in each affected Compose group because Docker can change native dependencies. Independent scopes can run concurrently, even within one project. Task completion and readiness waits do not block unrelated actions.

Overlapping requests fail immediately with `OPERATION_BUSY`; they are not queued. The error details identify the blocking operation and overlapping entry IDs. A reservation lasts until the operation succeeds or fails. Status, logs, and operation reads remain available.

Reload and config edits require exclusive access: they conflict with every active operation and block new actions until they finish. Config edits detect file changes before commit. If a required stop fails, the candidate config is not applied; already completed stops are reported.

## Logs

Process/task logs persist across runs and manager restarts. Retention defaults to 256 MiB per entry and 4 GiB total, configurable in YAML. A gap marks removed history. Boundaries identify new runs. Compose history comes from Docker; Docker's logging driver controls its retention. The manager does not keep a second persisted copy of Compose logs. Replacement containers supply new container labels. Log text is displayed as text, not HTML.

The dashboard keeps one log tab per entry. Each tab shows the entry name and project, with a blue top edge on the active tab. Each tab keeps its query, Find or Filter mode, wrap setting, selected match, follow state, and reading position while the panel is open or hidden.

Process and task tabs load retained history, then receive live events. They read history again after a gap or reconnect. Compose tabs query Docker history while the log panel is open. The two sources do not share log cursors.

- Use the Find and Filter buttons beside search to select the search mode. Find highlights text without hiding output. The up and down arrow buttons, Enter, and Shift+Enter move between matches. Filter shows complete matching records. Run boundaries and gap records stay visible.
- Use Cmd+F or Ctrl+F while focus is inside the viewer to focus its search field. Escape clears the query. Cmd+K still opens service search.
- Scroll upward to pause follow. Record collection continues. The new-record count excludes duplicate delivery. The count includes records hidden by Filter. Use Follow latest or Go to latest to resume follow and clear the count.
- Use the splitter grip with pointer input or arrow keys to change panel height. The divider moves freely without a snap point or automatic collapse. Small heights can hide output and controls; drag the divider upward to show them again. The maximize icon hides the service table; the restore icon returns to the saved split. Use the plus button (Open logs) to select another entry while maximized. The minus button (Hide log panel) does not stop an entry or close its tabs. Icon buttons have tooltips and accessible names.
- Wrap lines and Follow latest are toggle buttons. A selected button has a blue background. Copy logs copies all displayed records, including records outside the viewport. Find copies all retained output. Filter copies matching records and history boundaries. UI notices and match highlights are not copied. A status message shows copy success or clipboard failure.

Service state, event connection, follow state, and retained-record count appear in the footer. Live means the event stream is open. Reconnecting does not remove retained output. History notices above the output identify unavailable server history and records removed by the viewer. The viewer cannot load records that are no longer available. If its saved reading position is removed, it shows the oldest available output and a notice.

Log messages use 13px monospace text and a 20px line height. Wrap lines indents continuation lines under the message. Explicit error and warning labels keep their colors. Ordinary stderr is not marked as an error. Recognized HTTP 4xx response tokens are amber; 5xx tokens are red. Other numbers remain unchanged. The timestamp tooltip includes the full date and timezone.

## Login startup

`startup enable` creates a per-user LaunchAgent and starts the manager. There is no crash-restart policy. Repeated enable preserves an unchanged live manager. If the registered manager is stopped, enable starts it again. Changed arguments require explicit `servicemon manager stop` first. A failed replacement restores the previous registration; a failed first registration leaves no false success record.

`startup disable` removes future login startup without stopping a live manager. A later `manager restart` starts a detached replacement and keeps login startup disabled. `manager stop` is separate and does not remove the registration. Inactive old jobs are unloaded so same-session disable/enable works.

The Homebrew launcher uses stable `opt` paths for both Servicemon and Node. It sets the internal `SERVICEMON_STARTUP_EXECUTABLE` value; startup stores that launcher, not a versioned Node path. There is no `brew services` controller. Checkout and npm startup still store absolute Node and CLI paths and need renewal after those paths move.

`manager restart` renews an existing registration through the current launcher after the old manager exits, without an extra detached manager. The current bound port becomes the port for later login starts, including when the old manager started with port `0`. Package installation alone does not renew the registration.

The manager captures exported variables from the non-interactive login shell at startup and explicit reload. A login shell does not provide interactive aliases or functions. Commands must load their own environment files. Existing runs keep their old environment when reload captures a new one.

## Custom UI and security limits

`serve --ui /path/index.html` also accepts `.htm`. It replaces the dashboard at the plain manager URL. Dotfiles, unknown asset types, traversal, and symlink escape are rejected. JSON assets are supported. Keep only intended assets in the custom folder. API routes remain manager routes. There is no custom UI compatibility framework.

The dashboard and API have no authentication. All local OS users and processes can read status, logs, and allowed assets, edit config, and control the manager. Host and Origin checks restrict access from other websites; they do not identify local users. HTTP mutations require an Origin header that matches the manager endpoint. The CLI sends this header automatically.

Do not expose the port through a proxy, tunnel, or network bind. Config commands and custom HTML are trusted local code. Use only reviewed files. Status output, shell diagnostics, config, and logs can contain secrets; redact them before sharing.

## Verification safety

Use temporary config/state folders and uniquely named Compose projects. Remove only fixture resources created by the checks. The smoke scripts clean up their managers, test LaunchAgent, containers, and fixture volumes. Application controls do not offer volume removal. Do not use normal projects as verification fixtures.

## Upgrade and recovery

A package update replaces installed files, not the running manager process. `servicemon --version` reports the installed CLI version. `servicemon manager status` also reports the running manager version and protocol compatibility.

For a Homebrew package update:

```sh
brew upgrade sauravhiremath/tap/servicemon
servicemon manager status
servicemon manager restart
servicemon dashboard
```

Restart needs an existing manager. If none is running, use `servicemon serve --background`, or `servicemon startup enable` if you want login startup. Same-version source rebuilds are not detected; use explicit `manager restart` after building.

The restart command checks config, dashboard files, launch settings, process ownership, and startup registration before it asks one question. It shows the running and installed versions, config, dashboard, affected processes and tasks, and all active operations. An operation that starts or finishes invalidates earlier restart consent. The default answer is no. EOF and Ctrl-C give no consent. For an unattended restart with the same interruption rules, use:

```sh
servicemon manager restart --yes --json
```

Restart stops owned processes and active tasks. Compose containers remain running. The replacement runs normal autostart only; it does not restore every previously running service or replay tasks. Task results and operation IDs are not retained across restart. Retained logs do not make task replay safe.

The config path, state folder, current port, and built-in or custom dashboard setting are preserved. A conflicting explicit `--config` is rejected before shutdown. Each replacement captures the login environment again; it does not restore the old process environment. A registered manager starts through launchd. A detached manager starts through the installed CLI. No extra dashboard choice is needed.

For automatic restart prompts and script behavior, see the [CLI compatibility table](cli.md#version-checks-and-manager-restart).

### Restart failures

Invalid config or dashboard files fail before shutdown. Changed ownership, config, registration, or restart impact cancels the attempt. Inspect `manager status` and fix the reported cause before a new attempt.

Shutdown has a separate 60-second wait deadline. A timeout does not force-kill the old manager or launch another manager while the old identity or lock remains active. Let shutdown finish, then inspect status. If no manager remains, start it with `serve --background` or the existing startup registration.

Restart success requires the intended replacement identity, version, config, state, and port, plus successful autostart. A launch or autostart failure reports its phase, cause, observed running state, and next command. Failed autostart can leave the replacement running. Read its status and manager stderr log before further action. There is no automatic rollback after shutdown.

To recover a bad release, use the earlier release's checksummed source archive and matching formula. Before you install an older CLI that cannot read the current management contract, stop the manager with the current CLI. Restore the earlier formula in the local tap, run `brew reinstall --build-from-source sauravhiremath/tap/servicemon`, and run `brew test sauravhiremath/tap/servicemon` before starting normal services. Verify both versions and retained config/logs. Do not replace a published archive under its old version.

## Removal and retained data

While the CLI is still installed:

```sh
servicemon startup disable
servicemon manager stop
brew uninstall sauravhiremath/tap/servicemon
```

Package removal does not remove `~/.config/servicemon/config.yaml`, `~/Library/Application Support/servicemon`, retained logs, or Compose resources. The same rule applies to custom config/state paths. Save the config and any needed logs before manual data removal.

To remove data, first complete the shutdown commands above. Inspect the exact config and state paths, then delete only those chosen files or folders with Finder. This is separate from package removal. Remove Compose containers or volumes separately with Docker only when their data is no longer needed.
