# Dashboard UX changes

> Language: ASD-STE100 style.

## Goal

Make several local projects easy to monitor. Use project groups by default. Keep the table and docked logs.

## Acceptance criteria

1. The top bar contains search, project selection, and settings. Settings contains config path copy and reload.
2. Project and Compose actions appear beside their groups. Labels identify their targets. Broad stop actions require confirmation.
3. Project groups collapse. An ungrouped view supports cross-project sorting.
4. Default columns show name, type, state, health, endpoint, and controls. Commands remain searchable and available in details. A column control shows commands.
5. State shortcuts show accurate counts. Type filters remain separate from state filters.
6. State uses text and colour. Stopped and idle are neutral. Health remains separate. Labels use only available facts.
7. Start and Run use outlines. Logs stays visible. Secondary controls use a menu. Busy rows show action progress.
8. Log colours do not classify stderr as errors. Known error and warning labels receive suitable colours.
9. Logs support search, wrapping, copy, expansion, and Follow latest. Scrolling up pauses following. Jump to latest resumes it.
10. Log tabs retain project context. The active service row is highlighted. Timestamp timezone is available.
11. The log panel remembers its height. Headers stay visible during scrolling.
12. Page padding, group backgrounds, row dividers, selection, contrast, and keyboard focus improve. Single-page results hide pagination controls.
13. Existing service lifecycle, log retention, filters, details, and error behavior remain correct.

## Existing behavior

App owns snapshots, operations, selection, log tabs, and the vertical split. ServiceTable uses TanStack Table with filters, pagination, and resizing. LogPanel renders retained records. EntryStatus contains links, state, health, and Compose group IDs.

## Decisions

Keep shared styles and component interfaces consistent. Run integrated checks after the changes.

## Out of scope

No charts, remote monitoring, lifecycle policy changes, or generated endpoint guesses. Do not change backend contracts.

## Interfaces and data flow

Keep ServiceRow fields. Add optional groups and onTargetAction props to ServiceTable. onTargetAction takes kind projects or compose-groups, an ID, and an action other than run. App owns target submission and confirmation. Table owns group menus, grouping, sorting, type filters, and column display.
Keep existing LogPanel props. Add optional expanded and onExpand props. App owns split height persistence and expansion. LogPanel owns search and wrap state. Preserve LogTab fields.

## Error behavior

Keep manager, reload, operation, history-gap, and log errors visible. Report clipboard failures. Do not infer error severity from stream alone. Do not infer health information absent from the snapshot.

## Test strategy

Update existing behavioral tests where the user contract changes. Do not preserve wording-only tests. Verify real UI behavior with isolated fixtures. Do not start or stop the user's projects.

## Implementation tasks

### Task 1: Clear toolbar and scoped actions

**Result:** App shows a simple header, target confirmation, and persistent expandable logs.
**Files and symbols:** src/web/app.tsx, App, TargetMenu, Details.
**Contract:** Pass groups and onTargetAction to ServiceTable. Pass expanded and onExpand to LogPanel.
**TDD:** not applicable — user requests checks only after edits.
**Test seam:** Browser header, confirmation dialog, log split.
**Steps:**

1. Move copy and reload into settings.
2. Remove top-level target menus and connect group actions.
3. Add scoped stop confirmation without changing routine entry actions.
4. Persist split height and support log expansion.
5. Keep details and error handling complete.
   **Verification:** npm run typecheck; npm run test:e2e; browser toolbar and log expansion scenarios.
   **Depends on:** none.

### Task 2: Grouped service table

**Result:** Projects and Compose groups have clear headers and actions. Rows prioritise state and controls.
**Files and symbols:** src/web/table/service-table.tsx, src/web/table/filters.tsx, src/web/labels.ts.
**Contract:** Add optional groups and onTargetAction props. Preserve existing props and ServiceRow fields.
**TDD:** not applicable — user requests checks only after edits.
**Test seam:** Group collapse, view toggle, sorting, filters, links, column controls, operation progress.
**Steps:**

1. Add grouped default and ungrouped sorting.
2. Add state counts and separate type filtering.
3. Hide commands by default and retain search and optional display.
4. Add configured endpoint links and scoped group actions.
5. Improve status, row controls, progress, selection, and single-page footer.
   **Verification:** npm run typecheck; npm run test:e2e; browser table scenarios.
   **Depends on:** none.

### Task 3: Readable log panel

**Result:** Logs have correct colour meaning and complete reading controls.
**Files and symbols:** src/web/logs/log-panel.tsx.
**Contract:** Preserve LogTab fields. Add optional expanded and onExpand props. Use log-line-error, log-line-warning, and log-line-time CSS classes.
**TDD:** not applicable — user requests checks only after edits.
**Test seam:** Search, wrap, copy, expand, scroll pause, resume, tab selection, timestamp.
**Steps:**

1. Stop colouring all stderr red.
2. Add reading controls with useful empty and failure states.
3. Pause following on upward scroll and allow Jump to latest.
4. Keep tab context, scroll position, retention notices, and timezone available.
   **Verification:** npm run typecheck; npm run test:e2e; browser log scenarios.
   **Depends on:** none.

### Task 4: Shared styling and integration

**Result:** All changes form one usable dashboard with readable contrast and keyboard focus.
**Files and symbols:** src/web/styles.css, tests/web, README.md, CHANGELOG.md, docs/operations.md.
**Contract:** Integrate the worker interfaces. Keep backend behavior unchanged.
**TDD:** not applicable — user requests checks only after edits.
**Test seam:** Complete application and isolated browser fixtures.
**Steps:**

1. Add shared spacing, contrast, log colour, and focus styles.
2. Integrate component changes and update affected behavioral tests.
3. Run final checks and real browser scenarios.
4. Update user documentation and changelog after smoke proof.
   **Verification:** npm run typecheck; npm test; npm run build; npm run test:e2e; npm run smoke; isolated browser scenarios.
   **Depends on:** Tasks 1, 2, 3.

## Final verification

Run typecheck, unit tests, build, browser tests, and CLI smoke after all edits. Exercise the new table and log controls in a browser. Use isolated fixture services for lifecycle actions. Report only observed results.

### Results

- Typecheck and production build passed. The build reports a JavaScript chunk above 500 kB.
- Unit checks passed: 14 files, 54 tests. Browser checks passed: 9 tests.
- Installed CLI smoke passed all seven scenarios.
- An isolated browser smoke passed group collapse, view switching, sorting, command search and display, type filters, config path copy, entry Start, group Stop cancellation, mixed-severity stderr, log search and copy, wrapping, follow pause and resume, expansion, saved split height, and narrow row controls.
- Browser regression checks cover mixed-severity output and hiding expanded logs without losing the saved split.
- Screenshots were checked for the grouped table and the log panel. No user project was started or stopped.
