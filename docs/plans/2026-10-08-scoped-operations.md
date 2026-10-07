# Scoped operations

> Language: ASD-STE100 style.

## Goal

Let unrelated service actions proceed while a task or readiness check waits. Remove the global operation lock without adding a queue.

An operation records one request and its result. Its scope is the set of entries reserved until that operation ends.

## Acceptance criteria

1. An independent service can start, stop, and restart while a task runs, including within the same project.
2. Requests with overlapping scopes fail immediately with `OPERATION_BUSY`. The error identifies the blocking operation and entries.
3. Admission reserves the complete scope before execution awaits external work. Rejected requests make no changes.
4. Start scopes include prerequisites. Restart scopes include restart targets and startup prerequisites. Stop scopes include selected entries.
5. Compose actions reserve all entries in each affected Compose group because Compose commands can affect native dependencies.
6. Reload and config edits remain exclusive. Status, logs, and operation reads remain available.
7. Operations keep their final task result. Completion and failure release reservations. Internal waits use promises, not polling.
8. Shutdown rejects new work, stops owned processes, and waits for every active operation. No dependent starts after shutdown admission.
9. Manager restart reports every active operation. Its impact key changes when any active operation changes.
10. Dashboard controls use reserved scope, including prerequisites, aggregate targets, and exclusive config work.
11. Existing task reuse, restart ordering, ownership checks, and partial-failure behavior remain intact.
12. Local CLI and browser checks prove independent progress and overlap rejection. Release checks run before publication.

## Existing behavior

`Operations.active` covers the full execution lifetime. `enqueue` rejects requests instead of queuing them.
Task completion and readiness checks hold this global lock. Reload uses the same path.
`Operations.wait` polls operation records. Shutdown and restart impact inspect one active operation.
Dashboard entry controls use the target and entries already affected, not the full reserved scope.
The unused-code check reports no unused files before this change.

## Decisions

- Resolve execution order and scope once before admission.
- Reserve the complete scope synchronously. Reject overlaps; do not queue or share prerequisite work.
- Keep execution ordering within one operation unchanged. This change permits independent requests, not parallel steps within one request.
- Use a small active-operation map with completion promises. Keep completed records in the existing history map.
- Represent exclusive config work with a null scope. Use entry ID arrays for service work.
- Keep `affected` as work attempted. Add `scope` for reservations so controls do not infer them from execution progress.
- Replace `enqueue` with an explicit exclusive-operation entry point and a private common admission method.
- Replace singular restart impact with an operations list. Use management contract version 2.
- Read management contract version 1 only at the CLI boundary to permit upgrades from the published 0.1.3 manager.
- Increase the application protocol because dashboard operation records now require scope.
- Do not preserve obsolete in-process APIs or old application response aliases.
- Keep changes in the clean master checkout. Its upstream-only README change was fast-forwarded before edits.

## Out of scope

Queues, automatic retries, shared prerequisite execution, task cancellation, parallel startup steps, persistent operation history, and unrelated refactoring are excluded.
Normal user services, login registration, and global package installation are not test fixtures.

## Interfaces and data flow

1. `Operations.submit` selects entries and resolves ordered start and stop steps.
2. The same resolved steps define the reserved scope, with selected entries and Compose group expansion.
3. Admission checks active scopes and reserves the new operation before execution.
4. Execution updates existing operation records and adapter state.
5. Completion releases the scope and resolves all internal waiters through one promise.
6. API snapshots and events include operation scope. Dashboard controls use that scope.
7. Restart impact lists all active operation IDs and actions in stable order.

The management client normalizes a version 1 response at its external boundary. All current internal consumers use the operations list.
This code is needed for an actual package upgrade. It is not a retained alias for an obsolete internal interface.

## Error behavior

`OPERATION_BUSY` identifies a blocking operation and the intersecting entry IDs. Exclusive config work conflicts with every active operation.
`MANAGER_STOPPING` rejects new operations after shutdown admission.
Existing task, readiness, process ownership, and config errors retain their current meanings.
A failed operation keeps completed side effects and releases its scope.

## Test strategy

Use deterministic gates for overlap, failure release, prerequisite reservations, and shutdown waits.
Use real isolated managers for CLI task completion, independent service actions, logs, and config exclusion.
Use browser tests for affected controls. Check Compose group admission without Docker, then run Docker checks when available.
Do not reproduce the operator's reported failure merely to confirm it. Replace the old global-busy test with the new contract.

## Implementation tasks

### Task 1: Independent service actions proceed

**Result:** Independent scopes run concurrently and overlaps fail without side effects.

**Files and symbols:** `src/manager/operations.ts`, `src/manager/runtime.ts`, `src/shared/types.ts`, `tests/manager/operations.test.ts`.

**Contract:** Operation scope, ordered action plan, exclusive config admission, completion promises.

**TDD:** required — cover scope intersections, reservation release, and preserved ordering.

**Test seam:** Operations API and isolated HTTP manager.

**Steps:**

1. Replace the global-busy contract test and add scope boundary cases.
2. Resolve ordered work and scope before admission.
3. Replace the global lock and polling with active operations and completion promises.
4. Move reload to explicit exclusive admission.

**Verification:** `npm run build && npx --no-install vitest run tests/manager/operations.test.ts`

**Depends on:** none.

### Task 2: Restart and shutdown account for all operations

**Result:** Restart consent lists every operation, and shutdown waits for all admitted work.

**Files and symbols:** `src/manager/operations.ts`, `src/manager/runtime.ts`, `src/shared/types.ts`, `src/shared/build-info.ts`, `src/cli/manager.ts`, `tests/manager/restart.test.ts`, `tests/cli/`, `scripts/smoke-update.mjs`.

**Contract:** Management version 2 operations list; version 1 upgrade input; application protocol 2.

**TDD:** required — multiple operations change restart impact and shutdown completion.

**Test seam:** Manager impact, guarded shutdown, CLI restart, cross-version smoke.

**Steps:**

1. Replace singular impact and shutdown logic with the active-operation collection.
2. Update CLI validation and consent output for the new management contract.
3. Retain version 1 input support only for published-manager upgrades.
4. Update contract fixtures and test concurrent shutdown and stale consent.

**Verification:** `npx --no-install vitest run tests/manager/restart.test.ts tests/cli && npm run smoke:update`

**Depends on:** Task 1.

### Task 3: Dashboard controls match operation scope

**Result:** Reserved entries show busy controls while unrelated entries remain usable.

**Files and symbols:** `src/web/api.ts`, `src/web/table/service-table.tsx`, `tests/web/`.

**Contract:** Required operation scope; null scope blocks all mutations.

**TDD:** required — pending prerequisites and aggregate controls must reflect reservations.

**Test seam:** Actual dashboard with isolated manager.

**Steps:**

1. Validate scope in operation events.
2. Use scope for entry and aggregate control state.
3. Exercise independent actions during a running task in the browser.

**Verification:** `npm run test:e2e`

**Depends on:** Task 1.

### Task 4: Verify and publish the corrected package

**Result:** Local checks pass and the approved version is available from the source release and Homebrew tap.

**Files and symbols:** Current operations and CLI guidance, package version files, release workflows.

**Contract:** Publication requires explicit version and tap approval. Published bytes must match the reviewed commit.

**TDD:** not applicable — use package, CLI, browser, and release workflow checks.

**Test seam:** Isolated installed package, public release assets, Homebrew formula.

**Steps:**

1. Run contributor and release checks and the specific concurrent-task smoke scenario.
2. Update current user guidance for scoped concurrency and restart impact.
3. Set the approved version and commit only this task's changes.
4. Push master and require successful Source checks for the exact commit.
5. Publish through the source workflow and verify public asset checksums.
6. Publish the tap update and verify its formula against the source manifest.

**Verification:** Contributor checks, release checks, exact source and tap workflow runs, public archive checksum and formula comparison.

**Depends on:** Tasks 1, 2, 3.

## Final verification

Run `npm run lint`, `npm run format:check`, `npm run knip`, `npm run typecheck`, `npm test`, and `npm run test:e2e`.
Run `npm run smoke`, `npm run smoke:update`, `npm run check:runtime`, `npm run release:check`, and `npm pack --dry-run --ignore-scripts --json`.
Run `gitleaks git . --log-opts=--all --redact --no-banner`.
Check Docker and GUI availability before optional Compose and startup checks. Report unavailable coverage separately.
Verify that the released tag, manifest, archive checksum, source commit, and tap formula agree.
