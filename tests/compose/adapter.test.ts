import { describe, expect, it } from 'vitest';
import { ComposeAdapter, type ComposeContainer } from '../../src/compose/adapter.js';
import { composeEntries, discoverGroups } from '../../src/compose/discovery.js';
import type { Entry } from '../../src/shared/types.js';
import { docker, makeGroup, removeGroup, waitFor } from './support.js';

async function entriesFor(group: Parameters<typeof discoverGroups>[0][number]): Promise<Entry[]> {
  const discovery = (await discoverGroups([group], process.env)).get(group.id);
  if (!discovery) throw new Error('missing discovery');
  return composeEntries(group, discovery, { stopSeconds: 5, readinessSeconds: 30 });
}

function containersOf(status: { containers?: unknown }): ComposeContainer[] {
  return Array.isArray(status.containers) ? status.containers.filter((item): item is ComposeContainer => Boolean(item) && typeof item === 'object' && 'id' in item && typeof item.id === 'string') : [];
}

describe('ComposeAdapter', () => {
  it('observes an existing container and does not claim another project', async () => {
    const group = await makeGroup();
    try {
      const entries = await entriesFor(group);
      const created = await docker(['compose', '--project-name', group.projectName, '--project-directory', group.directory, '--file', group.file, 'up', '-d', '--pull', 'never', 'db'], group.directory);
      expect(created.code, created.stderr).toBe(0);
      const adapter = new ComposeAdapter(entries, [group], process.env, () => {});
      try {
        await waitFor(() => adapter.status('demo/infra.db').state === 'running');
        const status = adapter.status('demo/infra.db');
        expect(containersOf(status)).toHaveLength(1);
        expect(status.health === 'healthy' || status.health === 'checking').toBe(true);
        const id = containersOf(status)[0]?.id;
        expect(id).toBeTruthy();
        const inspected = await docker(['inspect', '-f', '{{index .Config.Labels "com.docker.compose.project"}}', id!], group.directory);
        expect(inspected.stdout.trim()).toBe(group.projectName);
      } finally {
        await adapter.shutdown();
      }
    } finally {
      await removeGroup(group);
    }
  });

  it('does not start a service while its Compose health dependency is unhealthy', async () => {
    const group = await makeGroup(`services:\n  db:\n    image: ubuntu:24.04\n    command: ["sleep", "600"]\n    healthcheck:\n      test: ["CMD", "false"]\n      interval: 1s\n      timeout: 1s\n      retries: 2\n  app:\n    image: ubuntu:24.04\n    command: ["sleep", "600"]\n    depends_on:\n      db:\n        condition: service_healthy\n`);
    try {
      const entries = await entriesFor(group);
      const app = entries.find((entry) => entry.composeService === 'app');
      expect(app).toBeTruthy();
      const adapter = new ComposeAdapter(entries, [group], process.env, () => {});
      try {
        await expect(adapter.start(app!, process.env)).rejects.toThrow(/unhealthy|dependency/i);
        await adapter.refresh();
        expect(adapter.status(app!.id).state).toBe('stopped');
      } finally {
        await adapter.shutdown();
      }
    } finally {
      await removeGroup(group);
    }
  });

  it('stops one service without stopping its neighbor or removing the volume, and shutdown keeps containers', async () => {
    const group = await makeGroup();
    try {
      const entries = await entriesFor(group);
      const app = entries.find((entry) => entry.composeService === 'app')!;
      const db = entries.find((entry) => entry.composeService === 'db')!;
      const adapter = new ComposeAdapter(entries, [group], process.env, () => {});
      try {
        await adapter.start(app, process.env);
        await waitFor(() => adapter.ready(db));
        await adapter.stop(app);
        expect(adapter.status(app.id).state).not.toBe('running');
        expect(adapter.status(db.id).state).toBe('running');
        const volume = await docker(['volume', 'inspect', `${group.projectName}_data`], group.directory);
        expect(volume.code, volume.stderr).toBe(0);
        const dbId = containersOf(adapter.status(db.id))[0]?.id;
        expect(dbId).toBeTruthy();
        await adapter.shutdown();
        const running = await docker(['inspect', '-f', '{{.State.Running}}', dbId!], group.directory);
        expect(running.stdout.trim()).toBe('true');
        const volumeAfter = await docker(['volume', 'inspect', `${group.projectName}_data`], group.directory);
        expect(volumeAfter.code).toBe(0);
      } finally {
        await adapter.shutdown();
      }
    } finally {
      await removeGroup(group);
    }
  });

  it('requires every replica to be healthy and follows the replacement container id', async () => {
    const group = await makeGroup();
    try {
      const entries = await entriesFor(group);
      const web = entries.find((entry) => entry.composeService === 'web')!;
      const adapter = new ComposeAdapter(entries, [group], process.env, () => {});
      try {
        await adapter.start(web, process.env);
        await waitFor(async () => adapter.ready(web));
        const first = containersOf(adapter.status(web.id));
        expect(first).toHaveLength(2);
        expect(adapter.status(web.id).health).toBe('healthy');
        await waitFor(async () => (await adapter.history(web.id)).records.some((record) => record.text.includes('web-log-marker') && first.some((container) => container.id === record.containerId)));
        const beforeReplacement = await adapter.history(web.id);
        const extra = await docker(['compose', '--project-name', group.projectName, '--project-directory', group.directory, '--file', group.file, 'create', '--scale', 'web=3', '--no-recreate', '--pull', 'never', '-y', 'web'], group.directory);
        expect(extra.code, extra.stderr).toBe(0);
        const unchanged = await adapter.history(web.id, { after: beforeReplacement.cursor });
        expect(unchanged.records).toEqual([]);
        expect(unchanged.cursor).toBe(beforeReplacement.cursor);
        expect(unchanged.gap).toBe(false);
        const replaced = await docker(['compose', '--project-name', group.projectName, '--project-directory', group.directory, '--file', group.file, 'up', '-d', '--force-recreate', '--no-deps', '--pull', 'never', 'web'], group.directory);
        expect(replaced.code, replaced.stderr).toBe(0);
        await waitFor(() => {
          const ids = containersOf(adapter.status(web.id)).map((container) => container.id);
          return ids.length === 2 && ids.every((id) => !first.some((container) => container.id === id));
        });
        const next = containersOf(adapter.status(web.id));
        expect(next.map((container) => container.id)).not.toEqual(expect.arrayContaining(first.map((container) => container.id)));
        await waitFor(async () => (await adapter.history(web.id)).records.some((record) => record.text.includes('web-log-marker') && next.some((container) => container.id === record.containerId)));
        const continued = await adapter.history(web.id, { after: beforeReplacement.cursor });
        expect(continued.records.some((record) => record.text.includes('web-log-marker') && next.some((container) => container.id === record.containerId))).toBe(true);
        expect(continued.records.every((record) => record.sequence > beforeReplacement.cursor)).toBe(true);
        await adapter.shutdown();
        const restarted = new ComposeAdapter(entries, [group], process.env, () => {});
        try {
          const history = await restarted.history(web.id, { tail: 20 });
          expect(history.records.some((record) => record.text.includes('web-log-marker') && next.some((container) => container.id === record.containerId))).toBe(true);
        } finally {
          await restarted.shutdown();
        }
      } finally {
        await adapter.shutdown();
      }
    } finally {
      await removeGroup(group);
    }
  });

  it('reports a created container as stopped and then starts it', async () => {
    const group = await makeGroup();
    try {
      const entries = await entriesFor(group);
      const db = entries.find((entry) => entry.composeService === 'db');
      expect(db).toBeTruthy();
      const created = await docker(['compose', '--project-name', group.projectName, '--project-directory', group.directory, '--file', group.file, 'create', '--pull', 'never', '-y', 'db'], group.directory);
      expect(created.code, created.stderr).toBe(0);
      const adapter = new ComposeAdapter(entries, [group], process.env, () => {});
      try {
        await waitFor(() => containersOf(adapter.status(db!.id)).length === 1);
        expect(adapter.status(db!.id).state).toBe('stopped');
        await adapter.start(db!, process.env);
        await waitFor(() => adapter.status(db!.id).state === 'running');
      } finally {
        await adapter.shutdown();
      }
    } finally {
      await removeGroup(group);
    }
  });

  it('reports a paused container as running', async () => {
    const group = await makeGroup();
    try {
      const entries = await entriesFor(group);
      const db = entries.find((entry) => entry.composeService === 'db')!;
      const adapter = new ComposeAdapter(entries, [group], process.env, () => {});
      try {
        await adapter.start(db, process.env);
        await waitFor(() => adapter.status(db.id).state === 'running');
        const id = containersOf(adapter.status(db.id))[0]?.id;
        expect(id).toBeTruthy();
        const paused = await docker(['pause', id!], group.directory);
        expect(paused.code, paused.stderr).toBe(0);
        await waitFor(() => containersOf(adapter.status(db.id)).some((container) => container.state === 'paused'));
        expect(adapter.status(db.id).state).toBe('running');
        await docker(['unpause', id!], group.directory);
      } finally {
        await adapter.shutdown();
      }
    } finally {
      await removeGroup(group);
    }
  });

  it('does not apply one broken Compose file to another project', async () => {
    const good = await makeGroup();
    const bad = await makeGroup('services: [\n');
    bad.id = 'demo/broken';
    bad.key = 'broken';
    try {
      const entries = await entriesFor(good);
      const created = await docker(['compose', '--project-name', good.projectName, '--project-directory', good.directory, '--file', good.file, 'up', '-d', '--pull', 'never', 'db'], good.directory);
      expect(created.code, created.stderr).toBe(0);
      const adapter = new ComposeAdapter(entries, [good, bad], process.env, () => {});
      try {
        await waitFor(() => adapter.status('demo/infra.db').state === 'running');
        const status = adapter.status('demo/infra.db');
        expect(status.health === 'healthy' || status.health === 'checking').toBe(true);
        expect(status.error).toBeUndefined();
      } finally {
        await adapter.shutdown();
      }
    } finally {
      await removeGroup(good);
      await removeGroup(bad);
    }
  });
});
