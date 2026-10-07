import type { Operation, Snapshot } from '../../src/shared/types.js';
import { expect, test } from './manager.js';

for (const exclusive of [false, true]) {
  test(
    exclusive
      ? 'exclusive config work blocks mutations but not reads'
      : 'entry reservations block their Compose group and project, even when filtered out',
    async ({ page, manager }) => {
      const ready = Promise.withResolvers<Snapshot>();
      await page.route('**/api/status', async (route) => {
        const response = await route.fetch();
        const envelope = await response.json();
        const snapshot = envelope.data as Snapshot;
        const source = snapshot.entries.find((entry) => entry.projectId === 'fixture-b')!;
        snapshot.entries.push(
          ...['first', 'second'].map((name) => ({
            ...source,
            id: `fixture-b/infra.${name}`,
            key: `infra.${name}`,
            name,
            kind: 'compose' as const,
            composeGroupId: 'fixture-b/infra',
            composeService: name,
          })),
        );
        snapshot.groups.push({
          id: 'fixture-b/infra',
          projectId: 'fixture-b',
          key: 'infra',
          name: 'infra',
          directory: manager.directory,
          file: 'compose.yaml',
          projectName: 'fixture-b-infra',
          autostart: false,
          overrides: {},
        });
        const operation: Operation = {
          id: 'reserved-operation',
          action: exclusive ? 'reload' : 'start',
          target: exclusive ? {} : { entry: 'fixture-b/infra.first' },
          state: 'running',
          scope: exclusive ? null : ['fixture-b/infra.first', 'fixture-b/infra.second'],
          affected: ['fixture-b/infra.first'],
          startedAt: new Date().toISOString(),
        };
        snapshot.operations = [operation];
        ready.resolve(snapshot);
        await route.fulfill({ response, json: { ...envelope, data: snapshot } });
      });
      await page.route('**/api/events', async (route) => {
        const snapshot = await ready.promise;
        await route.fulfill({
          contentType: 'text/event-stream',
          body: `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`,
        });
      });
      await page.goto(manager.url);
      await page.getByLabel('Search services and tasks').fill('second');
      await expect(
        page.getByRole('button', { name: 'Start Fixture B/second', exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole('button', { name: 'Logs for Fixture B/second', exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole('button', { name: 'Details for Fixture B/second', exact: true }),
      ).toBeEnabled();
      for (const [menu, label] of [
        ['Actions for Fixture B', 'Fixture B services'],
        ['Actions for Compose group infra', 'Compose group infra'],
      ]) {
        await page.getByRole('button', { name: menu, exact: true }).click();
        for (const action of ['Start', 'Stop', 'Restart']) {
          await expect(
            page.getByRole('menuitem', { name: `${action} ${label}`, exact: true }),
          ).toBeDisabled();
        }
        await page.keyboard.press('Escape');
      }
      await page.getByLabel('Search services and tasks').fill('talker');
      const independent = page.getByRole('button', { name: 'Start Fixture A/talker', exact: true });
      if (exclusive) {
        await expect(independent).toBeDisabled();
      } else {
        await expect(independent).toBeEnabled();
      }
      await page.getByRole('button', { name: 'Actions for Fixture A', exact: true }).click();
      const aggregate = page.getByRole('menuitem', {
        name: 'Start Fixture A services',
        exact: true,
      });
      if (exclusive) {
        await expect(aggregate).toBeDisabled();
      } else {
        await expect(aggregate).toBeEnabled();
      }
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(
        page.getByRole('menuitem', { name: 'Reload config', exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole('menuitem', { name: 'Copy config path', exact: true }),
      ).toBeEnabled();
    },
  );
}
