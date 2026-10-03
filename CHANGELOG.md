# Changelog

## Unreleased

### Fixed

- Start restores stopped prerequisites of a cached successful task without running the task again.
- A missing command health-check directory reports unhealthy status instead of crashing the manager.
- Background startup verifies the recorded manager instead of returning a dead endpoint.
- Config edits do not take an empty lock from another writer. Missing config files use the documented error and exit status, and a failed process-identity lookup can be tried again.
- Startup enable starts a stopped registered manager and preserves an unchanged live manager.
- Zero-tail log reads keep the current cursor without printing history. Log bursts and reconnects recover missed records without treating gap markers as real log positions.
- Compose state and health reflect created containers and unavailable group configs. One invalid group does not hide other groups.
- A new Compose container with no output no longer causes existing log lines to appear again during replacement.
- Invalid control-request JSON returns an input error. Log history notices and dialog close controls remain available.
- Log-panel Maximize, Restore, Hide, and reopen preserve the user-selected divider position.

### Simplified

- Docker is the only source of Compose log history. Removed the extra background log follower and duplicate persisted logs.
- Process and task log tabs use live events rather than polling history every 400 milliseconds. Compose tabs keep their Docker history queries.
- Run exposes only task targets. CI shares a build between unit and browser checks. Runtime packaging checks use one clean installation instead of rebuilding the same locked dependencies twice.
