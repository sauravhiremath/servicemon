import { expect, test } from './manager.js';

test('an owner browser runs a task and reads its real output', async ({ page, manager }) => {
  await page.goto(manager.url);
  await page.getByRole('button', { name: 'Run Fixture A/once', exact: true }).click();
  await page.getByRole('button', { name: 'Logs for Fixture A/once', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('task-ok');
});
