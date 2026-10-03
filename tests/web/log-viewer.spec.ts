import type { Page } from '@playwright/test';
import type { LogRecord } from '../../src/shared/types.js';
import { expect, test } from './manager.js';

declare global {
  interface Window {
    events: EventTarget & { onopen: (() => void) | null; onerror: (() => void) | null };
    copied: string;
    eventCursor?: number;
  }
}

async function controlled(page: Page, url: string) {
  await page.request.get(url);
  const response = await page.request.get(`${url}/api/status`);
  const payload: unknown = await response.json();
  if (
    !payload ||
    typeof payload !== 'object' ||
    !('data' in payload) ||
    !payload.data ||
    typeof payload.data !== 'object' ||
    !('entries' in payload.data) ||
    !Array.isArray(payload.data.entries)
  ) {
    throw new Error('Missing fixture entries');
  }
  const entries = payload.data.entries.filter(
    (entry: unknown): entry is { name: string; id: string } =>
      !!entry &&
      typeof entry === 'object' &&
      'id' in entry &&
      typeof entry.id === 'string' &&
      'name' in entry &&
      typeof entry.name === 'string',
  );
  const id = entries.find((entry) => entry.name === 'talker')!.id;
  const other = entries.find((entry) => entry.name === 'svc-01')!.id;
  let records: LogRecord[] = Array.from({ length: 80 }, (_, index) => ({
    entryId: id,
    runId: 'run',
    sequence: index + 1,
    timestamp: '2026-10-02T01:47:50Z',
    stream: 'stdout',
    text: index === 20 ? 'literal a.b a.b\nmultiline context' : `context-${index + 1}`,
  }));
  let gap = false;
  let error: string | undefined;
  await page.addInitScript(() => {
    class ControlledEvents extends EventTarget {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() {
        super();
        window.events = this;
      }
      close() {}
    }
    Object.defineProperty(window, 'EventSource', { value: ControlledEvents });
    window.copied = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          window.copied = text;
        },
      },
    });
  });
  await page.route('**/api/entries/*/logs?*', async (route) => {
    const request = new URL(route.request().url());
    const entryId = decodeURIComponent(request.pathname.split('/')[3]!);
    const all =
      entryId === id ? records : [{ ...records[0]!, entryId: other, text: 'second entry output' }];
    const after = Number(request.searchParams.get('after') ?? 0);
    await route.fulfill({
      json: {
        ok: true,
        data: {
          records: all.filter((record) => record.sequence > after),
          cursor: all.at(-1)?.sequence ?? 0,
          oldestCursor: all[0]?.sequence ?? 0,
          gap,
          error,
        },
        error: null,
      },
    });
  });
  await page.goto(url);
  await page.getByRole('button', { name: 'Logs for Fixture A/talker' }).click();
  await expect(page.getByRole('log')).toContainText('context-80');
  return {
    id,
    other,
    async emit(record: LogRecord, duplicate = false) {
      records.push(record);
      await page.evaluate(
        ({ record, duplicate }) => {
          const events = window.events;
          const cursor = (window.eventCursor ?? 0) + 1;
          window.eventCursor = cursor;
          const event = new MessageEvent('change', {
            data: JSON.stringify({ cursor, type: 'log', data: record }),
          });
          events.dispatchEvent(event);
          if (duplicate) {
            events.dispatchEvent(event);
          }
        },
        { record, duplicate },
      );
    },
    record(sequence: number, text: string): LogRecord {
      return { ...records[0]!, sequence, text };
    },
    setHistory(next: LogRecord[], hasGap = false, detail?: string) {
      records = next;
      gap = hasGap;
      error = detail;
    },
  };
}

test('Find keeps context, Filter copies complete records, and tabs keep independent view state', async ({
  page,
  manager,
}) => {
  await controlled(page, manager.url);
  const log = page.getByRole('log');
  await expect(log).toHaveAttribute('aria-live', 'off');
  await expect(log.locator('.log-match-selected')).toHaveCount(0);
  const search = page.getByRole('textbox', { name: 'Search logs' });
  await search.fill('a.b');
  await expect(page.getByText('1 of 2', { exact: true })).toBeVisible();
  await expect(log).toContainText('context-80');
  await search.press('Enter');
  await expect(page.getByText('2 of 2', { exact: true })).toBeVisible();
  await search.press('Shift+Enter');
  await expect(page.getByText('1 of 2', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Follow latest' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('button', { name: 'Copy displayed logs' }).click();
  expect(await page.evaluate(() => window.copied)).toContain('context-80');
  const anchor = await log.evaluate((node) => node.scrollTop);
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(log).not.toContainText('context-80');
  await expect(log).toContainText('multiline context');
  await expect(page.getByText(/Filter active/)).toBeVisible();
  await page.getByRole('button', { name: 'Copy displayed logs' }).click();
  const copied = await page.evaluate(() => window.copied);
  expect(copied).toContain('literal a.b a.b\nmultiline context');
  expect(copied).not.toContain('context-80');
  expect(copied).not.toContain('Filter active');
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await expect.poll(() => log.evaluate((node) => node.scrollTop)).toBe(anchor);
  await page.getByRole('button', { name: 'Wrap lines' }).click();
  await page.getByRole('button', { name: 'Maximize logs' }).click();
  await page.getByRole('button', { name: 'Open logs', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fixture A/svc-01', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Wrap lines' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.getByRole('tab', { name: 'Fixture A/talker', exact: true }).click();
  await expect(search).toHaveValue('a.b');
  await expect(page.getByRole('button', { name: 'Wrap lines' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Restore logs' }).click();
  await page.getByRole('button', { name: 'Hide log panel' }).click();
  await expect(page.getByRole('button', { name: 'Logs for Fixture A/talker' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(search).toHaveValue('a.b');
  await search.focus();
  await search.press('Escape');
  await expect(search).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Follow latest' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await search.fill('not present');
  await expect(page.getByText('0 matches', { exact: true })).toBeVisible();
  await expect(log).toContainText('context-80');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await expect(log).toContainText('No records match this filter.');
  await expect(page.getByRole('button', { name: 'Copy displayed logs' })).toBeDisabled();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('denied');
        },
      },
    });
  });
  await page.getByRole('button', { name: 'Copy displayed logs' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Could not copy logs.' })).toBeVisible();
});

test('paused arrivals exclude duplicates and survive retention without moving the selected match', async ({
  page,
  manager,
}) => {
  const fixture = await controlled(page, manager.url);
  const log = page.getByRole('log');
  await page.getByRole('textbox', { name: 'Search logs' }).fill('a.b');
  await page.getByRole('button', { name: 'Next match' }).click();
  const before = await log.evaluate((node) => node.scrollTop);
  await fixture.emit(fixture.record(81, 'new a.b'), true);
  await expect(page.getByRole('button', { name: /1 new records · Go to latest/ })).toBeVisible();
  await expect(page.getByText('2 of 3', { exact: true })).toBeVisible();
  expect(await log.evaluate((node) => node.scrollTop)).toBe(before);
  await fixture.emit(fixture.record(82, 'x'.repeat(512000)));
  await expect(page.getByRole('button', { name: /2 new records · Go to latest/ })).toBeVisible();
  await expect(page.getByText(/The saved reading position is no longer available/)).toBeVisible();
  await expect(page.getByText(/Older records were removed from this viewer/)).toBeVisible();
  await page.getByRole('button', { name: /Go to latest/ }).click();
  await expect(page.getByRole('button', { name: 'Follow latest' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('button', { name: /Go to latest/ })).toHaveCount(0);
});

test('event connection is independent of successful status requests and history notices stay outside copy', async ({
  page,
  manager,
}) => {
  const fixture = await controlled(page, manager.url);
  await expect(page.getByLabel('Event connection')).toHaveText('Connecting');
  await page.evaluate(() => window.events.onopen?.());
  await expect(page.getByLabel('Event connection')).toHaveText('Live');
  await page.getByRole('button', { name: 'Follow latest' }).click();
  fixture.setHistory([fixture.record(82, 'retained after gap')], true, 'History read failed');
  await page.evaluate(() => {
    window.events.onerror?.();
    window.events.dispatchEvent(
      new MessageEvent('change', { data: JSON.stringify({ cursor: 1, type: 'gap', data: {} }) }),
    );
  });
  await expect(page.getByText(/Some earlier records are unavailable/)).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'History read failed' })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('retained after gap');
  await page.getByRole('button', { name: 'Copy displayed logs' }).click();
  expect(await page.evaluate(() => window.copied)).not.toContain('Some earlier records');
  await expect(page.getByLabel('Event connection')).toHaveText('Reconnecting');
});

test('controls remain reachable at each planned viewport and zoom', async ({ page, manager }) => {
  const fixture = await controlled(page, manager.url);
  for (const size of [
    { width: 1568, height: 805 },
    { width: 1440, height: 900 },
    { width: 1152, height: 800 },
    { width: 760, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.getByRole('button', { name: 'Maximize logs' }).click();
    await expect(page.getByRole('button', { name: 'Copy displayed logs' })).toBeInViewport();
    await expect(page.getByRole('log')).toBeInViewport();
    expect((await page.getByRole('log').boundingBox())!.height).toBeGreaterThan(40);
    await page.screenshot({ path: `test-results/log-viewer-${size.width}x${size.height}.png` });
    await page.getByRole('textbox', { name: 'Search logs' }).focus();
    await page.keyboard.press('Control+f');
    await expect(page.getByRole('textbox', { name: 'Search logs' })).toBeFocused();
    await page.getByRole('button', { name: 'Open logs', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open logs', exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Restore logs' }).click();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.zoom = '2';
  });
  await page.getByRole('button', { name: 'Maximize logs' }).click();
  await expect(page.getByRole('button', { name: 'Copy displayed logs' })).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Restore logs' })).toBeInViewport();
  expect(
    (await page.getByRole('textbox', { name: 'Search logs' }).boundingBox())!.width,
  ).toBeGreaterThan(100);
  expect((await page.getByRole('log').boundingBox())!.height).toBeGreaterThan(40);
  await page.screenshot({ path: 'test-results/log-viewer-zoom-200.png' });
  await fixture.emit(fixture.record(81, 'wrapped long message '.repeat(40)));
  await expect(page.getByRole('log')).toContainText('wrapped long message');
  await page.getByRole('button', { name: 'Wrap lines' }).click();
  const follow = page.getByRole('button', { name: 'Follow latest' });
  if ((await follow.getAttribute('aria-pressed')) !== 'true') {
    await follow.click();
  }
  expect(
    (await page
      .getByRole('log')
      .locator('[data-line-key]')
      .filter({ hasText: 'wrapped long message' })
      .boundingBox())!.height,
  ).toBeGreaterThan(40);
  await page.screenshot({ path: 'test-results/log-viewer-zoom-200-wrapped.png' });
});
