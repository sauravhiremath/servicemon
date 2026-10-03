import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, test } from './manager.js';

test.describe.configure({ mode: 'serial' });

test.beforeEach(async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
});

test('combines search, project selection, column filters, and 20-row pages', async ({
  page,
  manager,
}) => {
  await page.goto(manager.url);
  await expect(page.getByRole('heading', { name: 'All services and tasks' })).toBeVisible();
  await expect(page.getByText('20 per page')).toBeVisible();
  await expect(page.getByText(/1–20 of \d+ entries/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next page' })).toBeEnabled();

  await page.getByRole('combobox', { name: 'Project' }).click();
  await page.getByRole('option', { name: 'Fixture B' }).click();
  await expect(page.getByRole('heading', { name: 'Fixture B' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Logs for Fixture A/talker' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Logs for Fixture B/svc-21' })).toBeVisible();

  await page.getByRole('combobox', { name: 'Project' }).click();
  await page.getByRole('option', { name: 'All projects' }).click();
  await page.getByLabel('Search services and tasks').fill('svc-21');
  await expect(page.getByRole('button', { name: 'Logs for Fixture B/svc-21' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Logs for Fixture A/talker' })).toHaveCount(0);
  await expect(page.getByText('1–1 of 1 entries')).toBeVisible();

  await page.getByLabel('Search services and tasks').fill('');
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(page.getByText(/Page 2 of/)).toBeVisible();
  await page.getByRole('button', { name: 'Filter State' }).click();
  await page.getByRole('checkbox', { name: 'Running' }).click();
  await expect(page.getByText('No matching services or tasks.')).toBeVisible();
});

test('toggles a group from its row without toggling from the Actions menu', async ({
  page,
  manager,
}) => {
  await page.goto(manager.url);
  const group = page
    .locator('tr[data-group="projects"]')
    .filter({ has: page.getByRole('button', { name: 'Actions for Fixture A', exact: true }) });
  const logs = page.getByRole('button', { name: 'Logs for Fixture A/talker' });
  await expect(logs).toBeVisible();
  await group.getByRole('cell').click();
  await expect(logs).toHaveCount(0);
  await expect(
    group.getByRole('button', { name: 'Expand Fixture A', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await group.getByText('Fixture A', { exact: true }).click();
  await expect(logs).toBeVisible();
  await group.getByRole('button', { name: 'Collapse Fixture A', exact: true }).click();
  await expect(logs).toHaveCount(0);
  await group.getByRole('button', { name: 'Actions for Fixture A', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Stop Fixture A services', exact: true }),
  ).toBeVisible();
  await expect(logs).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Stop Fixture A services', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(logs).toHaveCount(0);
  await group.getByRole('button', { name: 'Expand Fixture A', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(logs).toBeVisible();
});

test('resizes a column without activating its filter', async ({ page, manager }) => {
  await page.goto(manager.url);
  await expect(page.getByRole('heading', { name: 'All services and tasks' })).toBeVisible();
  const handle = page.getByRole('separator', { name: 'Resize Service / task' });
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  const next = await handle.boundingBox();
  expect(next!.x).toBeGreaterThan(box!.x);
  await expect(page.getByLabel('Service / task text')).toHaveCount(0);
});

test('copies a full truncated command and reports clipboard failure without a success message', async ({
  page,
  manager,
}) => {
  await page.goto(manager.url);
  const response = await page.request.get(new URL('/api/status', manager.url).href);
  const snapshot = (await response.json()).data;
  const command = snapshot.entries.find(
    (entry: { id: string }) => entry.id === 'fixture-a/talker',
  ).command;
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Cmd / Compose file', exact: true }).click();
  await page.keyboard.press('Escape');
  const value = page.getByRole('button', {
    name: 'Copy command or Compose file for Fixture A/talker',
    exact: true,
  });
  expect(await value.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  await value.click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  await expect(page.getByRole('status').filter({ hasText: /^Copied to clipboard$/ })).toBeVisible();
  await value.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(command);
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      value: async () => {
        throw new Error('denied');
      },
    });
  });
  await value.click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Could not copy to clipboard' }),
  ).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: /^Copied to clipboard$/ })).toHaveCount(
    0,
  );
});

test('keeps filters and column choices when hiding columns and changing the grouped view', async ({
  page,
  manager,
}) => {
  await page.goto(manager.url);
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Type', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Filter Type', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Service', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Type', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Health', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('columnheader', { name: /Type/ })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: /Health/ })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Details for Fixture A/once', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Ungrouped', exact: true }).click();
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Project', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Grouped', exact: true }).click();
  await page.getByRole('button', { name: 'Ungrouped', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: /Project/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Columns', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Type', exact: true })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.getByRole('menuitemcheckbox', { name: 'Type', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Health', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('columnheader', { name: /Type/ })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: /Health/ })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Details for Fixture A/once', exact: true }),
  ).toHaveCount(0);
});

test('copies the config path and reloads an invalid file without dropping rows', async ({
  page,
  manager,
}) => {
  await page.goto(manager.url);
  await expect(page.getByRole('button', { name: 'Logs for Fixture A/talker' })).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy config path' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(manager.configPath);
  await writeFile(manager.configPath, 'version: 99\nnot-a-config: [\n');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Reload config' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Config reload failed' })).toContainText(
    'The previous config is still active.',
  );
  await expect(page.getByRole('button', { name: 'Logs for Fixture A/talker' })).toBeVisible();
});

test('starts and restarts a fixture service from row controls and keeps keyboard access', async ({
  page,
  manager,
}) => {
  await page.goto(manager.url);
  const health = page
    .getByRole('row')
    .filter({
      has: page.getByRole('button', { name: 'Details for Fixture A/talker', exact: true }),
    })
    .locator('[data-health]');
  await expect(health).toHaveText('-');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByLabel('Search services and tasks')).toBeFocused();
  const restart = page.getByRole('button', { name: 'Restart Fixture A/talker', exact: true });
  await expect(restart).toHaveCount(0);
  await page.getByRole('button', { name: 'Start Fixture A/talker' }).click();
  await expect(page.getByRole('row', { name: /talker/ }).getByText('Running')).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole('button', { name: 'Stop Fixture A/talker' })).toBeEnabled();
  await expect(restart).toBeEnabled();
  await expect(health).toHaveText('-');
  const status = async () =>
    (
      await (await page.request.get(new URL('/api/status', manager.url).href)).json()
    ).data.entries.find((entry: { id: string }) => entry.id === 'fixture-a/talker');
  const before = await status();
  await restart.click();
  await expect
    .poll(
      async () => {
        const entry = await status();
        return entry.state === 'running' && entry.runId !== before.runId;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  await expect(restart).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Restart Fixture A/once', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Details for Fixture A/talker' }).click();
  await expect(page.getByRole('dialog')).toContainText('Talker notes');
  await expect(page.getByRole('link', { name: 'http://127.0.0.1:9/docs' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
});

test('requires confirmation before a project stop and leaves services running after cancel', async ({
  page,
  manager,
}) => {
  await page.goto(manager.url);
  await page.getByRole('button', { name: 'Start Fixture A/talker' }).click();
  await expect(page.getByRole('button', { name: 'Stop Fixture A/talker' })).toBeEnabled();
  await page.getByRole('button', { name: 'Actions for Fixture A', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Stop Fixture A services', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Fixture A');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop Fixture A/talker' })).toBeEnabled();
  await page.getByRole('button', { name: 'Actions for Fixture A', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Stop Fixture A services', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Stop Fixture A services', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Start Fixture A/talker' })).toBeEnabled();
});

test('Retry restores plain dashboard access after a manager restart', async ({
  page,
  manager,
  installedCli,
}) => {
  const exec = promisify(execFile);
  const env = {
    ...process.env,
    SERVICEMON_CONFIG: manager.configPath,
    SERVICEMON_STATE_DIR: manager.stateDir,
  };
  const cli = (...args: string[]) => exec(process.execPath, [installedCli, ...args], { env });
  await page.goto(manager.url);
  await page.getByRole('button', { name: 'Start Fixture A/talker' }).click();
  await expect(page.getByRole('button', { name: 'Stop Fixture A/talker' })).toBeEnabled();
  await cli('manager', 'stop');
  await expect
    .poll(async () => {
      try {
        await cli('manager', 'status');
        return false;
      } catch (error) {
        return typeof error === 'object' && error !== null && 'code' in error && error.code === 3;
      }
    })
    .toBe(true);
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  try {
    await cli('serve', '--background', '--port', new URL(manager.url).port);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page).toHaveURL(manager.url + '/');
    expect((await page.request.get(manager.url + '/api/status')).status()).toBe(200);
    await expect(page.getByRole('button', { name: 'Start Fixture A/talker' })).toBeEnabled();
    await page.getByRole('button', { name: 'Start Fixture A/talker' }).click();
    await expect(page.getByRole('button', { name: 'Stop Fixture A/talker' })).toBeEnabled();
  } finally {
    await cli('manager', 'stop');
  }
});
