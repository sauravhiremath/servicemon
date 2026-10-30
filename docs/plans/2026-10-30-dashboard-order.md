# Dashboard order and continuous scrolling

> Language: ASD-STE100 style.

## Goal

Show active entries and recently triggered entries first. Remove dashboard pagination.
An entry is a configured service, task, or Compose service.
An active entry has state `running` or `starting`.

## Acceptance criteria

1. Active entries precede inactive entries in the default order.
2. The latest Start, Run, Restart, or Stop action determines order within each activity class.
3. Project groups and Compose groups stay together. Active groups precede inactive groups.
4. Names and IDs provide stable order when activity and action times match.
5. Ungrouped view permits manual column sorting. Removing manual sorting restores the default order.
6. All matching entries appear in one scrollable list. No page controls remain.
7. Search, filters, collapsed groups, controls, and column choices retain their existing behavior.

## Existing behavior

`ServiceTable` sorts grouped entries by project, Compose group, and entry name.
It renders slices of 20 entries. `Snapshot.operations` contains action times from the current manager session.

## Decisions

Use active-first order rather than time-only order. A stopped entry must not displace an active entry.
Use manager actions rather than browser clicks or log messages. CLI actions also affect the order.
Count direct targets and affected entries. Do not count entries reserved only through `scope`.
Rank each group by whether any member is active, then by its latest member action time.
Keep Compose members together within each project. Sort those blocks and individual entries by the same rules.
Use continuous scrolling over all available rows. Do not add incremental loading when the snapshot already contains all entries.

## Out of scope

Do not persist action history across manager restarts. Do not change API fields or add dependencies.
Do not change service lifecycle rules or release a package.

## Interfaces and data flow

Add a pure ordering helper under `src/web/table/`. It consumes rows, operations, and the grouped-view setting.
`ServiceTable` supplies its ordered rows to the existing table. Manual column sorting overrides this default in Ungrouped view.
Remove page state, page-reset callbacks, the page-size constant, and the page-reset prop.

## Error behavior

Ignore invalid action times and actions unrelated to entry control.
Failed control actions still count as triggers for their direct targets.
Keep existing action error messages unchanged.

## Test strategy

Use Vitest for ordering rules and input immutability. Use Playwright for scrolling, live updates, reload, and manual sorting.
Use temporary fixture managers only.

## Implementation tasks

### Task 1: Active and recent entries appear first

**Result:** Default order follows activity and action time without splitting groups.

**Files and symbols:** `src/web/table/order.ts`, `src/web/table/service-table.tsx`, `tests/web/table-order.test.ts`.

**Contract:** Consume existing entry rows and `Operation` objects. Do not change shared API types.

**TDD:** required — ordering has explicit behavior.

**Test seam:** Pure helper and dashboard row order.

**Steps:**

1. Add tests for active states, recent actions, group blocks, ties, failed actions, and reserved-only entries.
2. Run the tests and confirm failure before implementation.
3. Add the helper and connect it to the table.
4. Check live actions and manual column sorting with Playwright.

**Verification:** `npx --no-install vitest run tests/web/table-order.test.ts`; targeted Playwright tests.

**Depends on:** none.

### Task 2: All matching entries remain reachable by scrolling

**Result:** The dashboard shows every matching entry without page controls.

**Files and symbols:** `src/web/table/service-table.tsx`, `src/web/table/filters.tsx`, `src/web/labels.ts`, `src/web/app.tsx`, `tests/web/table.spec.ts`, `tests/web/compose-table.spec.ts`, `tests/web/logs.spec.ts`, `docs/operations.md`.

**Contract:** Retain the existing table scroll region and filters. Remove pagination-only interfaces.

**TDD:** required — browser tests must verify access beyond the previous page limit.

**Test seam:** Browser row count, scroll region, search, and filter controls.

**Steps:**

1. Replace page assertions with complete-list and scroll assertions.
2. Confirm the changed browser test fails before implementation.
3. Remove pagination and its unused callbacks.
4. Update the Dashboard section in the operations guide.

**Verification:** `npx --no-install playwright test tests/web/table.spec.ts tests/web/compose-table.spec.ts tests/web/logs.spec.ts`.

**Depends on:** Task 1.

## Final verification

Run `npm run lint`, `npm run format:check`, `npm run knip`, `npm run typecheck`, `npm test`, and `npm run test:e2e`.
Review changes before committing. Push the dashboard change only; leave existing untracked assets unchanged.
