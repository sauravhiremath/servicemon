import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Operation, Snapshot } from '../../src/shared/types.js';
import { expect, test } from './manager.js';

test.use({
  managerConfig: `version: 1
projects:
  app:
    name: App
    directory: $DIRECTORY
    services:
      api:
        command: sleep 120
        depends_on: [shared/setup, shared/pending]
      independent:
        command: echo independent-ready; exec sleep 120
  shared:
    name: Shared
    directory: $DIRECTORY
    tasks:
      setup:
        command: echo gate-waiting; while [ ! -f release ]; do sleep 0.1; done; echo gate-done
      pending:
        command: echo pending-done
  other:
    name: Other
    directory: $DIRECTORY
    services:
      service:
        command: sleep 120
`,
});

test('reserves pending work and aggregate controls while independent service actions and logs remain usable', async ({
  page,
  manager,
}) => {
  const status = async (): Promise<Snapshot> =>
    (await (await page.request.get(`${manager.url}/api/status`)).json()).data;
  await page.getByRole('button', { name: 'Start App/api', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop Shared/setup', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Run Shared/pending', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Start App/api', exact: true })).toBeDisabled();
  const snapshot = await status();
  const operation = snapshot.operations.find((item) => item.state === 'running')!;
  expect(operation.scope).toEqual(
    expect.arrayContaining(['app/api', 'shared/setup', 'shared/pending']),
  );
  expect(operation.affected).not.toContain('shared/pending');

  for (const project of ['App', 'Shared']) {
    await page.getByRole('button', { name: `Actions for ${project}`, exact: true }).click();
    for (const action of ['Start', 'Stop', 'Restart']) {
      await expect(
        page.getByRole('menuitem', { name: `${action} ${project} services`, exact: true }),
      ).toBeDisabled();
    }
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'Actions for Other', exact: true }).click();
  await expect(
    page.getByRole('menuitem', { name: 'Start Other services', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Reload config', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Copy config path', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Logs for Shared/setup', exact: true }).click();
  await expect(page.getByRole('log', { name: 'Logs for Shared/setup', exact: true })).toContainText(
    'gate-waiting',
  );
  await page.getByRole('button', { name: 'Start App/independent', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Stop App/independent', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Restart App/independent', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Stop App/independent', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Stop App/independent', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Start App/independent', exact: true }),
  ).toBeEnabled();
  expect((await status()).operations.find((item) => item.id === operation.id)!.state).toBe(
    'running',
  );

  await writeFile(path.join(manager.directory, 'release'), '');
  await expect(page.getByRole('button', { name: 'Stop App/api', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Run Shared/pending', exact: true })).toBeEnabled();
  const result: Operation = (await status()).operations.find((item) => item.id === operation.id)!;
  expect(result.state).toBe('succeeded');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Reload config', exact: true })).toBeEnabled();
});
