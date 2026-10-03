import type { EntryStatus, Snapshot } from '../../src/shared/types.js';
import { expect, test } from './manager.js';

test('collapses Compose members without hiding project services and shares pages and search', async ({ page, manager }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const ready = Promise.withResolvers<Snapshot>();
  await page.route('**/api/status', async (route) => {
    const response = await route.fetch();
    const envelope = await response.json();
    const snapshot = envelope.data as Snapshot;
    const source = snapshot.entries.find((entry) => entry.projectId === 'fixture-b')!;
    const members: EntryStatus[] = Array.from({ length: 2 }, (_, index) => {
      const name = `compose-${String(index + 1).padStart(2, '0')}`;
      return { ...source, id: `fixture-b/${name}`, key: name, name, kind: 'compose', composeGroupId: 'fixture-b/infra', composeService: name };
    });
    snapshot.entries.push(...members);
    snapshot.groups.push({ id: 'fixture-b/infra', projectId: 'fixture-b', key: 'infra', name: 'infra', directory: manager.directory, file: 'compose.yaml', projectName: 'fixture-b-infra', autostart: false, overrides: {} });
    ready.resolve(snapshot);
    await route.fulfill({ response, json: { ...envelope, data: snapshot } });
  });
  await page.route('**/api/events', async (route) => {
    const snapshot = await ready.promise;
    await route.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n` });
  });
  await page.goto(manager.url);
  const table = page.getByRole('table', { name: 'Services and tasks', exact: true });
  await page.getByRole('combobox', { name: 'Project' }).click();
  await page.getByRole('option', { name: 'Fixture B' }).click();
  const service = table.getByRole('button', { name: 'Details for Fixture B/svc-21', exact: true });
  const member = table.getByRole('button', { name: 'Details for Fixture B/compose-01', exact: true });
  await expect(service).toBeVisible();
  await expect(member).toBeVisible();
  await table.getByRole('button', { name: 'Collapse infra', exact: true }).click();
  await expect(member).toHaveCount(0);
  await expect(service).toBeVisible();
  await table.getByRole('button', { name: 'Expand infra', exact: true }).click();
  await expect(member).toBeVisible();
  await table.getByRole('button', { name: 'Collapse Fixture B', exact: true }).click();
  await expect(member).toHaveCount(0);
  await expect(service).toHaveCount(0);
  await table.getByRole('button', { name: 'Expand Fixture B', exact: true }).click();
  await expect(member).toBeVisible();
  await expect(service).toBeVisible();

  await page.getByRole('combobox', { name: 'Project' }).click();
  await page.getByRole('option', { name: 'All projects' }).click();
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page.getByText('21–25 of 25 entries')).toBeVisible();
  await expect(service).toBeVisible();
  await page.getByLabel('Search services and tasks').fill('compose-01');
  await expect(member).toBeVisible();
  await expect(service).toHaveCount(0);
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Cmd / Compose file', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Copy command or Compose file for Fixture B/compose-01', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('compose.yaml');
  await expect(page.getByRole('status').filter({ hasText: /^Copied to clipboard$/ })).toBeVisible();
  await expect(page.getByText('1–1 of 1 entries')).toBeVisible();
  await page.getByLabel('Search services and tasks').fill('svc-21');
  await expect(service).toBeVisible();
  await expect(member).toHaveCount(0);
});
