import { expect, test } from './manager.js';

test('opens retained live logs in one dark tab per entry and pauses follow', async ({
  page,
  manager,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(manager.url);
  await page.getByRole('button', { name: 'Start Fixture A/talker' }).click();
  await expect(page.getByRole('row', { name: /talker/ }).getByText('Running')).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole('button', { name: 'Logs for Fixture A/talker' }).click();
  const log = page.getByRole('log', { name: 'Logs for Fixture A/talker' });
  await expect(log).toContainText('hello-fixture');
  await expect(log).toContainText('<script>alert(1)</script>');
  expect(dialogs).toEqual([]);
  await expect(log.locator('p').filter({ hasText: 'LOG: routine checkpoint' })).not.toHaveClass(
    /log-line-error/,
  );
  await expect(log.locator('p').filter({ hasText: 'WARNING: fixture warning' })).toHaveClass(
    /log-line-warning/,
  );
  await expect(log.locator('p').filter({ hasText: 'ERROR: fixture error' })).toHaveClass(
    /log-line-error/,
  );

  await page.getByRole('button', { name: 'Logs for Fixture A/svc-01' }).click();
  await expect(page.getByRole('tab', { name: 'Fixture A/svc-01' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: 'Fixture A/talker' }).click();
  await expect(log).toContainText('hello-fixture');
  await expect(log).toContainText('line-4');
  await expect.poll(() => log.evaluate((node) => node.scrollTop)).toBeGreaterThan(24);
  await log.hover();
  await page.mouse.wheel(0, -600);
  await expect(page.getByRole('button', { name: 'Follow latest', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  const before = await log.evaluate((node) => node.scrollTop);
  const seen = await log.innerText();
  await expect.poll(async () => log.innerText()).not.toBe(seen);
  expect(await log.evaluate((node) => node.scrollTop)).toBe(before);

  await page.getByRole('button', { name: /Go to latest/ }).click();
  await expect(page.getByRole('button', { name: 'Follow latest', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const handle = page.getByRole('separator', { name: 'Resize log panel' });
  await handle.focus();
  await page.keyboard.press('ArrowUp');
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y - 30, { steps: 5 });
  await page.mouse.up();
  const savedY = (await handle.boundingBox())!.y;
  await page.getByRole('button', { name: 'Hide log panel' }).click();
  await page.getByRole('button', { name: 'Logs for Fixture A/talker' }).click();
  await expect.poll(async () => Math.abs((await handle.boundingBox())!.y - savedY)).toBeLessThan(3);
  await page.getByRole('button', { name: 'Maximize logs' }).click();
  await page.getByRole('button', { name: 'Restore logs' }).click();
  await expect.poll(async () => Math.abs((await handle.boundingBox())!.y - savedY)).toBeLessThan(3);
  await page.getByRole('button', { name: 'Maximize logs' }).click();
  await page.getByRole('button', { name: 'Hide log panel' }).click();
  await expect(page.getByRole('button', { name: 'Logs for Fixture A/talker' })).toBeVisible();
  await page.getByRole('button', { name: 'Logs for Fixture A/talker' }).click();
  await expect.poll(async () => Math.abs((await handle.boundingBox())!.y - savedY)).toBeLessThan(3);
  await page.getByRole('button', { name: 'Close logs for Fixture A/svc-01' }).click();
  await page.getByRole('button', { name: 'Close logs for Fixture A/talker' }).click();
  await expect(page.getByRole('region', { name: 'Service logs' })).toHaveCount(0);
  await expect(page.getByRole('row', { name: /talker/ }).getByText('Running')).toBeVisible();
});

test('keeps the last row controls reachable with the log panel open', async ({ page, manager }) => {
  for (const width of [1152, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(manager.url);
    await page.getByRole('button', { name: 'Logs for Fixture A/talker' }).click();
    await expect(page.getByRole('separator', { name: 'Resize log panel' })).toBeVisible();
    await page.getByRole('button', { name: 'Next page' }).click();
    const last = page.getByRole('button', { name: 'Logs for Fixture B/svc-21' });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeVisible();
    await page.getByRole('button', { name: 'Hide log panel' }).click();
    await expect(page.getByRole('region', { name: 'Service logs' })).toHaveCount(0);
  }
});

test('highlights whole tabs and resizes freely through the former snap range', async ({
  page,
  manager,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(manager.url);
  await page.getByRole('button', { name: 'Logs for Fixture A/talker' }).click();
  const tab = page.getByRole('tab', { name: 'Fixture A/talker' });
  const wrapper = tab.locator('..');
  const background = () => wrapper.evaluate((node) => getComputedStyle(node).backgroundColor);
  const initial = await background();
  await tab.hover();
  const highlighted = await background();
  expect(highlighted).not.toBe(initial);
  expect(await tab.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
    'rgba(0, 0, 0, 0)',
  );
  await page.getByRole('button', { name: 'Close logs for Fixture A/talker' }).hover();
  expect(await background()).toBe(highlighted);

  const handle = page.getByRole('separator', { name: 'Resize log panel' });
  const group = handle.locator('..');
  const bounds = (await group.boundingBox())!;
  const grip = (await handle.boundingBox())!;
  const x = grip.x + grip.width / 2;
  await page.mouse.move(x, grip.y + grip.height / 2);
  await page.mouse.down();
  for (const height of [260, 240, 220, 180, 120, 60, 30, 100, 220, 260, bounds.height - 180]) {
    const targetY = bounds.y + height;
    await page.mouse.move(x, targetY, { steps: 5 });
    await expect
      .poll(async () => Math.abs((await handle.boundingBox())!.y + grip.height / 2 - targetY))
      .toBeLessThan(3);
  }
  await page.mouse.up();
  const savedY = (await handle.boundingBox())!.y;
  await page.getByRole('button', { name: 'Hide log panel' }).click();
  await page.getByRole('button', { name: 'Logs for Fixture A/talker' }).click();
  await expect.poll(async () => Math.abs((await handle.boundingBox())!.y - savedY)).toBeLessThan(3);
  await page.getByRole('button', { name: 'Maximize logs' }).click();
  await page.getByRole('button', { name: 'Restore logs' }).click();
  await expect.poll(async () => Math.abs((await handle.boundingBox())!.y - savedY)).toBeLessThan(3);
});
