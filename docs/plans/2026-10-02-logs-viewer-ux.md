# Logs viewer UI plan

> Language: ASD-STE100 style.

## Goal

Make the logs viewer useful for failure investigation and live monitoring.
Keep the bottom panel for quick checks. Use maximize for longer reading sessions.
Do not change service control, log storage, or server API behavior.

Terms used in this plan:

- Record: one `LogRecord` from the server. A record can contain several text lines.
- Display line: one text line with its timestamp and optional container ID.
- Follow: keep the view at the latest output when new records arrive.
- Reading position: a display-line identity and its pixel offset within the log viewport.
- Find: move between text matches without hiding other output.
- Filter: hide ordinary records that do not match the query.
- Maximize: hide the service table and use its space for the logs viewer.

## Acceptance criteria

1. Users can resize, maximize, restore, and hide the panel without losing their reading position.
2. The splitter has a visible grip and works with pointer and keyboard input.
3. Restore returns to the saved split height. Maximize does not overwrite that height.
4. The active project and entry remain identifiable with long names and many tabs.
5. Users can open another entry while the service table is hidden.
6. Service state, event connection state, and follow state have separate labels.
7. New output does not move the view when follow is off.
8. Users see an exact new-record count while they read earlier output.
9. Go to latest moves to the bottom, enables follow, and clears the new-record count.
10. Find preserves surrounding output, highlights matches, and supplies match navigation.
11. Filter remains available as an explicit mode. Its state cannot be mistaken for Find.
12. Search, wrap, match selection, follow, and reading position remain separate for each tab.
13. Log text uses a 13px monospace font and a 20px line height. Zoom does not clip controls.
14. Timestamps and container IDs have less visual weight than messages, without unreadable contrast.
15. Explicit error and warning labels retain their colors. Ordinary stderr is not treated as an error.
16. Recognized HTTP response status codes have restrained colors. Unrecognized text remains unchanged.
17. History limits appear outside ordinary output. The viewer does not claim that unavailable records can be loaded.
18. Copy displayed logs copies the currently displayed records, not only the viewport or search matches.
19. Empty, loading, no-match, history-error, connection-loss, and clipboard-error states have clear messages.
20. Controls have accessible names, visible focus, and keyboard access. Streaming output does not flood screen-reader announcements.

## Existing behavior

Repository evidence was read from these files:

- `src/web/app.tsx`: panel layout, tab ownership, event connection, history loading, and polling.
- `src/web/logs/log-panel.tsx`: tabs, filter search, wrap, copy, severity colors, and follow behavior.
- `src/web/logs/retain.ts`: history joins, record identity, and client retention limits.
- `src/web/styles.css`: dark log colors and timestamp styles.
- `src/web/components/resizable.tsx`: the existing splitter wrapper.
- `tests/web/logs.spec.ts`: live output, tab switching, pause, resize, and expand checks.
- `tests/web/manager.ts`: the installed CLI fixture used by browser tests.
- `docs/operations.md`: the current operator instructions.

Current details:

1. The default log split is 32 percent. The browser saves user split changes.
2. Maximize already exists through `onExpandLogs`. Its button is in the reading toolbar.
3. The log panel minimum height is 145px. The table minimum height is 240px.
4. Search filters records immediately. It has no Find mode or match navigation.
5. Follow and scroll position belong to each tab. Query and wrap belong to the mounted panel.
6. Scrolling upward already disables follow. Jump to latest already enables follow.
7. The viewer saves a pixel scroll position, not a stable display-line identity.
8. The event connection is shared. A connected status snapshot does not prove an active event connection.
9. History requests use a tail of 500 records. Open tabs also poll every 400ms.
10. Client retention limits are 2,000 records and 512,000 text characters.
11. The viewer puts a retention notice inside the log content and copied text.
12. The current renderer colors explicit error and warning labels. It does not classify all stderr as errors.
13. The current renderer inserts log text as React text, not HTML.

The review used source files and the supplied screenshot. No live behavior was exercised during this planning task.

## Decisions

### Layout and controls

Use this layout:

```text
[Project/service tab] [Other tabs...] [Open logs]        [Maximize] [Hide]
Project / service                    Running · Live · Following
[Find in logs................] [3 of 18] [Previous] [Next] [Clear]
[Find | Filter]                           [Wrap lines] [Copy displayed logs]
[History notice, only when needed]

01:47:50  [container]  message
01:47:54  [container]  message

                          [24 new records · Go to latest]
```

1. Put Maximize and Hide in the header. Use Restore when maximized.
2. Keep a visible label or tooltip and an accessible name for icon buttons.
3. Add an Open logs menu using the existing entry list and menu components.
4. Use project/entry labels in that menu. Do not add a second service search system.
5. Keep tabs horizontally scrollable. Scroll the active tab into view after selection.
6. Use CSS truncation instead of slicing the project and entry names separately.
7. Show the complete active project/entry label in the context row and its tooltip.
8. Remove the separate command row. Keep the command available through existing service details.
9. Keep the saved 32-percent default. Increase the log minimum height to 220px when space permits.
10. Below a 600px browser height, use a 160px minimum so both panels remain usable.
11. Use an 8px visible splitter area with at least a 12px pointer target.
12. Give header controls a 32px minimum target. Retain visible keyboard focus.
13. Give search a 280px desktop target width. Let it grow with available space.
14. Below 760px, let search occupy its own row. Do not shrink it below a useful text width.
15. Keep toolbar groups ordered as search, reading options, then copy.
16. Keep controls outside the scrolling log content.

### Connection and follow

Service state describes the entry. Connection state describes the shared event stream.
Follow describes the local reading behavior. None of these states implies another state.

| Condition                     | Connection label | Follow label        |
| ----------------------------- | ---------------- | ------------------- |
| Event stream opens            | Live             | Following or Paused |
| Event stream has not opened   | Connecting       | Following or Paused |
| Event stream reports an error | Reconnecting     | Following or Paused |

Use the existing manager failure message for a confirmed manager failure.
Do not add a Disconnected claim without a terminal connection signal.
A stopped entry can still have retained logs and a live manager connection.
Paused means that scrolling is paused. It does not mean that record collection has stopped.

1. Disable follow when the user moves away from the bottom.
2. Preserve the existing 24px bottom tolerance.
3. Do not enable follow merely because the user manually scrolls back to the bottom.
4. Enable follow only through Follow latest or Go to latest.
5. Put Go to latest inside the log viewport, anchored at the lower right.
6. Show it when newer output is below the reading position or new records have arrived while paused.
7. Hide it when the view is at the bottom and its new-record count is zero.
8. Count accepted new records, not the current retained array length.
9. Count all new records even in Filter mode. Explain this in the button tooltip.
10. Exclude duplicate delivery and initial history loading from the count.
11. Keep count and follow state separate for each tab, including inactive tabs.
12. Reset the count when follow resumes or the user reaches the bottom.

Save the first visible display-line key and its pixel offset when follow is off.
Use `runId`, `sequence`, and the line index for that key.
Restore that line after tab changes, panel changes, and new output.
If retention removes the saved line, show the oldest available line and a reading-position notice.
Do not claim that the removed line remains available.

### Find and Filter

Find is the default mode. Filter is an explicit alternative beside the search controls.
Use literal, case-insensitive text matching. Do not add regex or a query language.
Match the displayed timestamp, container ID, and message text.
Do not count invisible metadata as a Find match.

1. Find leaves all records visible.
2. Count text occurrences, not matching records.
3. Show `3 of 18` for the selected occurrence. Show `0 matches` when none exist.
4. Previous and Next move between occurrences and wrap at the ends.
5. Enter selects the next occurrence. Shift+Enter selects the previous occurrence.
6. Disable navigation controls when there are no matches.
7. Highlight all occurrences. Give the selected occurrence a separate outline or stronger fill.
8. Match navigation disables follow before it scrolls to an earlier line.
9. Query edits update highlights without automatically moving the reading position.
10. Clear removes the query and highlights without enabling follow.
11. Filter shows complete matching records, including all lines in each matching record.
12. Run boundaries and gap notices remain available even when ordinary records are filtered.
13. Show a visible Filter active label. Show the matching-record count in Filter mode.
14. Hide occurrence navigation in Filter mode. Keep text highlights in matching records.
15. Store query, mode, wrap, and selected-match identity with each tab.
16. Keep the selected match stable when new output arrives.
17. If retention removes that match, select the next available match and update the count without forced scrolling.
18. Restore the unfiltered reading anchor when the user leaves Filter mode.

Scope Cmd+F or Ctrl+F to the viewer only when focus is inside it.
Do not replace browser Find when focus is elsewhere.
Escape in the search field clears the query. It does not hide the panel.
Keep the existing Cmd+K service-search shortcut unchanged.

### Readability

1. Use 13px monospace text with a 20px line height.
2. Keep timestamps aligned in a fixed-width field where their format permits it.
3. Give wrapped continuation lines a message-column indent.
4. Keep horizontal scrolling when wrap is off.
5. Keep the full timestamp and timezone tooltip.
6. Dim timestamp and container fields. Do not dim the message or selection.
7. Keep existing explicit severity recognition and raw message text.
8. Color HTTP 4xx status tokens amber and HTTP 5xx status tokens red.
9. Recognize only an explicit HTTP status field or an unambiguous response line with a method, path, and status.
10. Support the supplied `--> GET /path 200 2ms` response format. Leave request lines and arbitrary numbers unchanged.
11. Leave HTTP 2xx and 3xx tokens neutral. Do not add success color to every request.
12. Do not infer severity from the words error or warning inside an ordinary message.
13. Render highlights and status tokens as text spans. Never use raw HTML insertion.

### History notices and copy

Show one compact notice above the log content when history is incomplete.
Use `Some earlier records are unavailable. Showing N retained records.` for a server gap.
Use `Older records were removed from this viewer. Showing N retained records.` for client trimming.
Show both causes when both are known. Do not replace a server gap with a client-only explanation.
Keep timestamped run boundaries and gap records in chronological output.
Do not claim that N records represent all server history.
Do not promise a fixed record limit: the character limit can remove records earlier.

Copy displayed logs means all displayed records, not only the visible viewport.
Find copies all displayed output. Filter copies the displayed filtered output.
Preserve timestamps, container IDs, multiline text, run boundaries, and gap records.
Exclude UI notices, match counters, and highlight markup from clipboard text.
Show a short success status or an actionable clipboard error.
Disable copy when no displayed records exist.

## Out of scope

- Server storage changes, new history pagination, or Load older controls.
- Regex search, structured query syntax, saved searches, or new severity filters.
- File export, JSON inspection, request grouping, or performance charts.
- Service control changes, a new route, or a new window.
- Automatic error classification for unknown log formats.
- Event transport replacement, retry policy changes, or polling changes.
- New dependencies or a second component design system.

## Interfaces and data flow

1. `App` remains the owner of open tabs, active entry, split size, and maximize state.
2. Extend `LogTab` with per-tab query, mode, wrap, selected match, reading anchors, and new-record count.
3. Initialize all tab fields in `openLogs`.
4. Add one typed view-state callback to `LogPanel`. It updates only the identified tab.
5. Keep follow and scroll callbacks, or replace them together with that callback. Leave no obsolete callback paths.
6. Pass `onOpenEntry` from `App` to the Open logs menu. Reuse `openLogs`.
7. Track event-stream state separately from snapshot/request state in `App`.
8. Pass event-stream state to `LogPanel`. Do not derive Live from `applySnapshot`.
9. Keep `LogRecord`, `LogHistory`, server routes, and transport payloads unchanged.
10. Use existing `recordKey` identities for record-level state.
11. Derive display lines and matches from retained records. Do not duplicate message strings in tab state.
12. Add small pure helpers in `src/web/logs/view.ts` for matching, identity, and response-token recognition.
13. Keep DOM scroll measurement and rendering in `log-panel.tsx`.
14. Increment new-record counts in accepted append paths, including history catch-up.
15. Preserve all view fields when `joinHistory` or `appendLive` replaces retained-log fields.
16. Keep client retention bounds unchanged.
17. Memoize derived lines and matches for the active tab. Do not rescan inactive tabs on scroll changes.

LSP reference checks found `LogPanel` and `LogTab` consumers only in `app.tsx` and their defining file.
Implementation must check references again before it changes those exported interfaces.

## Error behavior

- Initial history load: show Loading logs until that tab receives its first history result.
- Successful empty history: show No retained output. Keep the service state visible.
- No Find matches: show 0 matches. Keep surrounding output visible.
- No Filter matches: show No records match this filter. Keep Clear available.
- History request failure: keep retained output visible and show the existing error detail above it.
- Connection error: show Reconnecting. Keep retained output and reading position unchanged.
- Removed reading anchor: move to the oldest available output and explain the change once.
- Clipboard failure: show Could not copy logs. Check browser clipboard access.
- Invalid timestamp: preserve the original timestamp string.
- Removed entry: do not render a broken active tab. Select another valid tab or hide the empty panel.

Do not introduce automatic retries beyond current transport and polling behavior.

## Test strategy

Use browser tests for user actions, scroll position, clipboard content, keyboard behavior, and tab isolation.
Use unit tests only for uncertain matching and response-token boundaries.
Use deterministic fixtures for retention and connection-loss cases.
Keep one real process fixture for live-output behavior.
Do not assert exact decorative colors, source text, or internal state fields.
Replace existing exact-color assertions with behavior checks that guard false severity classification.
Preserve the script-text safety test.

Prove these boundaries:

1. Literal punctuation, repeated matches, multiline records, no matches, and tab-local queries.
2. Find keeps context; Filter hides nonmatching ordinary records; clearing restores the reading anchor.
3. New records do not move paused output or change the selected Find occurrence.
4. Duplicate deliveries do not increase the new-record count.
5. Retention does not reduce the arrival count or silently move to unrelated output.
6. Copy contains the displayed records and excludes UI text in both search modes.
7. Restart boundaries remain visible and record identities remain distinct across runs.
8. HTTP request IDs and random numbers are not treated as response status codes.
9. Reconnection state does not become Live merely because a status request succeeds.
10. Hide, reopen, maximize, and restore preserve tab state and the saved split.

Inspect the actual surface at 1568x805, 1440x900, 1152x800, 760x800, and 390x844.
Check 200-percent zoom, long labels, many tabs, pointer input, and keyboard-only input.
Check focus return after the Open logs menu and Hide.
Check text and control contrast against WCAG 2.2 AA targets.
Keep the log region accessible, but suppress continuous automatic speech for incoming records.
Announce connection changes and user-triggered search/copy results through a separate status region.

## Implementation tasks

### Task 1: Users can identify and size the active viewer

**Result:** The header has readable entry context, visible panel controls, and separate state labels.

**Files and symbols:** `src/web/app.tsx` (`App`, `openLogs`, `onExpandLogs`); `src/web/logs/log-panel.tsx` (`LogPanel`, tab rendering); `src/web/styles.css`; `src/web/components/resizable.tsx`; `tests/web/logs.spec.ts`.

**Contract:** `LogPanel` receives event-stream state and `onOpenEntry`. `App` keeps panel ownership.

**TDD:** required — guard split restoration and incorrect connection labels.

**Test seam:** The Service logs region, splitter, tabs, Open logs menu, and event-stream events.

**Steps:**

1. Check exported symbol references with LSP.
2. Separate event-stream state from successful snapshot requests.
3. Move maximize and hide controls into the header.
4. Add the active entry context and Open logs menu.
5. Replace character slicing with CSS truncation and active-tab visibility.
6. Set the responsive minimum heights and visible splitter target.
7. Preserve existing split persistence and service-table access.

**Verification:** `npm run build && npm run test:e2e -- tests/web/logs.spec.ts`.

**Depends on:** none.

### Task 2: Users can read earlier output without interruption

**Result:** Paused reading remains stable and Go to latest reports accepted new records.

**Files and symbols:** `src/web/app.tsx` (`refreshLogs`, `applyChange`, `openLogs`); `src/web/logs/log-panel.tsx` (`LogTab`, `LogPanel`, scroll effects); new `src/web/logs/view.ts`; `tests/web/logs.spec.ts`.

**Contract:** Each tab owns follow state, reading anchor, initial-load state, and arrival count.

**TDD:** required — arrivals, duplicates, retention, and programmatic scrolling can break reading position.

**Test seam:** The first visible display line, the Follow latest control, and the Go to latest button.

**Steps:**

1. Add tab-local view fields and initialize them in `openLogs`.
2. Save stable display-line anchors with pixel offsets.
3. Restore anchors after records, layout, and active-tab changes.
4. Count accepted arrivals in live and history catch-up paths.
5. Exclude duplicate records and the initial history load from arrival counts.
6. Replace the permanent Jump to latest toolbar button with the conditional viewport button.
7. Handle removal of an anchor with an explicit notice.

**Verification:** `npm run build && npm run test:e2e -- tests/web/logs.spec.ts` with live arrivals, duplicate delivery, and client trimming.

**Depends on:** Task 1.

### Task 3: Users can find events without losing context

**Result:** Find highlights and navigates occurrences. Filter remains a separate, clear action.

**Files and symbols:** `src/web/logs/log-panel.tsx` (`LogPanel`, `LogLine`); `src/web/logs/view.ts`; `src/web/app.tsx` (tab initialization and view updates); `src/web/styles.css`; `tests/web/logs.spec.ts`; new `tests/web/log-view.test.ts`.

**Contract:** Derived matches use display-line identity and occurrence offsets. Query and mode belong to each tab.

**TDD:** required — occurrence navigation, literal matching, and retained context are user-visible contracts.

**Test seam:** Search input, mode controls, match counter, navigation buttons, and displayed context.

**Steps:**

1. Add literal matching helpers and occurrence identities.
2. Replace immediate filtering with default Find mode.
3. Add Filter mode and complete-record filtering.
4. Add match highlights, count, Previous, Next, and Clear.
5. Add scoped keyboard shortcuts and stable selected-match handling.
6. Preserve separate unfiltered and filtered reading anchors.
7. Keep query, mode, and wrap state across tab switching and panel hiding.

**Verification:** `npm run test -- tests/web/log-view.test.ts` and `npm run build && npm run test:e2e -- tests/web/logs.spec.ts`.

**Depends on:** Task 2.

### Task 4: Users can scan raw output accurately

**Result:** Messages are easier to read without false error labels or lost raw text.

**Files and symbols:** `src/web/logs/log-panel.tsx` (`LogLine`, `explicitSeverity`, `formatTime`); `src/web/logs/view.ts`; `src/web/styles.css`; `tests/web/log-view.test.ts`; `tests/web/logs.spec.ts`.

**Contract:** Display tokens do not modify `LogRecord.text` or clipboard text.

**TDD:** required — HTTP token recognition must reject unrelated numbers and preserve text safety.

**Test seam:** Rendered output, wrapped continuation lines, selected text, and response-token helper results.

**Steps:**

1. Set the font size, line height, timestamp field, and container field styles.
2. Indent wrapped continuation lines under the message field.
3. Preserve timestamp tooltips and horizontal scrolling.
4. Keep explicit severity behavior and ordinary stderr behavior.
5. Add narrow HTTP response-token recognition.
6. Integrate response tokens with search highlights without raw HTML rendering.
7. Replace incidental exact-color tests with classification and raw-text behavior tests.

**Verification:** `npm run test -- tests/web/log-view.test.ts` and `npm run build && npm run test:e2e -- tests/web/logs.spec.ts`; inspect wrapped and unwrapped output at 200-percent zoom.

**Depends on:** Task 3.

### Task 5: Users understand history limits and copied output

**Result:** History notices do not look like process output. Copy has an explicit, reliable scope.

**Files and symbols:** `src/web/logs/log-panel.tsx` (`copyLogs`, empty and error rendering); `src/web/styles.css`; `tests/web/logs.spec.ts`.

**Contract:** Copy uses displayed record selection. UI notices never enter clipboard text.

**TDD:** required — Find and Filter produce different copy scopes and history states must remain truthful.

**Test seam:** History banner, empty states, clipboard contents, and copy feedback.

**Steps:**

1. Move the retention notice outside the scrolling output.
2. Distinguish known client trimming from other history gaps without invented server limits.
3. Rename copy to Copy displayed logs and define its tooltip.
4. Exclude UI notices from copied text while preserving chronological boundary records.
5. Add clear loading, empty, no-match, and clipboard-failure messages.
6. Keep retained output visible during history and connection failures.

**Verification:** `npm run build && npm run test:e2e -- tests/web/logs.spec.ts` with clipboard success/failure, missing history, and both search modes.

**Depends on:** Tasks 3 and 4.

### Task 6: Users can complete the same work with keyboard input and narrow screens

**Result:** All changed paths work on the actual browser surface and have current operator instructions.

**Files and symbols:** `tests/web/logs.spec.ts`; `tests/web/manager.ts` only if additional real-output cases are needed; `src/web/logs/log-panel.tsx`; `src/web/styles.css`; `docs/operations.md`; `CHANGELOG.md`.

**Contract:** Existing installed CLI browser fixtures remain the runtime verification path.

**TDD:** required for focus loss, hidden controls, and inaccessible service switching; not applicable for documentation edits.

**Test seam:** Keyboard-only workflows, viewport changes, zoom, status announcements, and installed CLI output.

**Steps:**

1. Exercise the complete path from opening logs through Find, Filter, pause, copy, maximize, and restore.
2. Exercise service switching while maximized.
3. Check focus order and return after menus and panel hiding.
4. Check all stated viewport sizes and 200-percent zoom.
5. Prevent continuous log announcements while retaining accessible output and status messages.
6. Add regression tests only for confirmed behavior risks.
7. Update operator instructions and the changelog after runtime proof.

**Verification:** The commands and manual scenarios in Final verification.

**Depends on:** Tasks 1 through 5.

## Final verification

Run these existing project commands after implementation:

```sh
npm run typecheck
npm run test
npm run build
npm run test:e2e
npm run smoke
```

The browser fixture installs a packed CLI. Build before running browser tests so they exercise current assets.
`npm run smoke` starts the real manager and checks its runtime behavior.
Do not require Compose or Docker for this frontend-only change.

Complete this browser scenario:

1. Start the talker fixture and open its logs.
2. Open a second entry and return to the first tab.
3. Find repeated text and move forward and backward between matches.
4. Confirm that surrounding records remain visible.
5. Enter Filter mode, copy displayed logs, and clear the filter.
6. Scroll upward while output arrives. Confirm the visible reading anchor stays fixed.
7. Confirm the new-record count grows without duplicate increments.
8. Use Go to latest. Confirm follow resumes and the count clears.
9. Resize, maximize, open another entry, restore, hide, and reopen.
10. Confirm each tab retains its query, wrap setting, follow state, and reading position.
11. Exercise history loss and event reconnection. Confirm accurate messages and retained output.
12. Repeat critical controls with keyboard input and the stated viewport sizes.

Acceptance coverage:

| Criteria | Tasks   |
| -------- | ------- |
| 1–5      | 1, 2, 6 |
| 6        | 1, 6    |
| 7–9      | 2, 6    |
| 10–12    | 3, 6    |
| 13–16    | 4, 6    |
| 17–19    | 2, 5, 6 |
| 20       | 1, 3, 6 |

## Implementation result

All six tasks are implemented. Operator instructions are in `docs/operations.md`.

Final verification passed:

- `npm run typecheck`
- `npm run test`: 58 tests in 15 files
- `npm run build`
- `npm run test:e2e`: 14 browser tests
- `npm run smoke`: all seven installed CLI and manager scenarios
- The viewport check also passed with wrapped output at 200-percent zoom.

Browser checks cover live output, duplicate delivery, retention, Find, Filter, copy success and failure, tab state, keyboard controls, maximize, restore, hide, event reconnection, and manager Retry. Screenshots were inspected at narrow widths and with wrapped and unwrapped output at 200-percent zoom.

Repository adjustments:

- Below 760px, the panel uses a 340px minimum when browser height is at least 600px. The 220px minimum left too little reading space below the wrapped controls. The short-window minimum remains 160px.
- Playwright selects `*.spec.ts` files so it does not load the new Vitest `*.test.ts` file.
- An event-stream error checks manager status before it reports a manager failure. A successful status request does not change Reconnecting to Live.

The build reports a bundle-size warning for the main JavaScript chunk. No server API, log storage, or service-control contract changed.
