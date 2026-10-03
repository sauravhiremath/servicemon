import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { HealthMonitor } from '../../src/manager/health.js';
import { Operations } from '../../src/manager/operations.js';
import type { Entry, EntryStatus } from '../../src/shared/types.js';
import { fixtureManager, persistentCommand, shellCommand } from '../helpers/runtime.js';

// These integration cases run a separate Node manager and real command checks. Fake timers cannot control that process.
const route = (id: string, action: string) => `/api/entries/${encodeURIComponent(id)}/${action}`;
it('starts a stopped prerequisite of a cached task without running that task again', async () => {
  const started: string[] = [];
  const states = new Map<string, string>([
    ['app/db', 'stopped'],
    ['app/setup', 'idle'],
    ['app/api', 'stopped'],
  ]);
  const entry = (id: string, kind: 'service' | 'task', dependsOn: string[]): Entry => ({
    id,
    projectId: 'app',
    key: id.split('/')[1]!,
    name: id,
    kind,
    directory: '/tmp',
    command: 'true',
    links: [],
    dependsOn,
    autostart: false,
    restartDependencies: false,
    restartDependents: false,
    stopSeconds: 1,
    readinessSeconds: 1,
  });
  const entries = [
    entry('app/db', 'service', []),
    entry('app/setup', 'task', ['app/db']),
    entry('app/api', 'service', ['app/setup']),
  ];
  const adapter = {
    status: (id: string) => ({ state: states.get(id) }) as EntryStatus,
    start: async (item: Entry) => {
      started.push(item.id);
      states.set(item.id, 'running');
    },
    stop: async (item: Entry) => {
      states.set(item.id, 'stopped');
    },
    ready: async () => true,
    shutdown: async () => {},
    waitTask: async (id: string) => {
      states.set(id, 'succeeded');
      return { state: 'succeeded' } as EntryStatus;
    },
  };
  const health = new HealthMonitor({}, () => undefined);
  const config = {
    path: 'c',
    source: '',
    raw: {},
    port: 0,
    logs: { perEntryBytes: 1, totalBytes: 1 },
    stopSeconds: 1,
    readinessSeconds: 1,
    projects: [{ id: 'app', name: 'app', directory: '/tmp' }],
    entries,
    groups: [],
  };
  const ops = new Operations(
    config,
    {},
    { process: adapter, compose: adapter },
    health,
    () => undefined,
  );
  try {
    expect((await ops.wait(ops.submit('start', { entry: 'app/api' }).id)).state).toBe('succeeded');
    expect(started).toEqual(['app/db', 'app/setup', 'app/api']);
    started.length = 0;
    expect((await ops.wait(ops.submit('stop', { entry: 'app/api' }).id)).state).toBe('succeeded');
    expect((await ops.wait(ops.submit('stop', { entry: 'app/db' }).id)).state).toBe('succeeded');
    expect((await ops.wait(ops.submit('start', { entry: 'app/api' }).id)).state).toBe('succeeded');
    expect(started).toEqual(['app/db', 'app/api']);
    expect(states.get('app/setup')).toBe('succeeded');
  } finally {
    await health.shutdown();
  }
});
it('reuses successful prerequisite tasks and preserves a stopped recursive restart target', async () => {
  const manager = await fixtureManager({
    shared: { services: { db: { command: persistentCommand } } },
    app: {
      tasks: {
        setup: {
          command: shellCommand(
            'require("fs").appendFileSync("runs","x");process.exit(require("fs").existsSync("fail")?1:0)',
          ),
          depends_on: ['shared/db'],
        },
      },
      services: {
        api: { command: persistentCommand, depends_on: ['setup'], restart_dependents: true },
        ui: { command: persistentCommand, depends_on: ['api'] },
      },
    },
  });
  try {
    expect((await manager.operation(route('app/api', 'start'))).state).toBe('succeeded');
    expect(await readFile(join(manager.folder, 'runs'), 'utf8')).toBe('x');
    expect((await manager.operation(route('app/api', 'restart'))).state).toBe('succeeded');
    const states = (await manager.snapshot()).entries;
    expect(states.find((e) => e.id === 'app/ui')!.state).toBe('stopped');
    expect(states.find((e) => e.id === 'app/api')!.state).toBe('running');
    expect(await readFile(join(manager.folder, 'runs'), 'utf8')).toBe('x');
    await writeFile(join(manager.folder, 'fail'), '');
    expect((await manager.operation(route('app/setup', 'run'))).state).toBe('failed');
    expect((await manager.operation(route('app/api', 'start'))).state).toBe('failed');
    expect(await readFile(join(manager.folder, 'runs'), 'utf8')).toBe('xxx');
  } finally {
    await manager.close();
  }
});
it('leaves a timed-out prerequisite running without starting its dependent after later recovery', async () => {
  const manager = await fixtureManager({
    app: {
      services: {
        api: {
          command: persistentCommand,
          readiness_seconds: 0.2,
          healthcheck: {
            type: 'command',
            command: 'test -f ready',
            interval_seconds: 0.05,
            timeout_seconds: 0.05,
          },
        },
        ui: { command: persistentCommand, depends_on: ['api'] },
      },
    },
  });
  try {
    const operation = await manager.operation(route('app/ui', 'start'));
    expect(operation.state).toBe('failed');
    expect(operation.error?.code).toBe('READINESS_TIMEOUT');
    expect(operation.error?.entryId).toBe('app/api');
    expect((await manager.snapshot()).entries.find((e) => e.id === 'app/api')!.state).toBe(
      'running',
    );
    await writeFile(join(manager.folder, 'ready'), '');
    const deadline = Date.now() + 3000;
    let snapshot = await manager.snapshot();
    while (
      snapshot.entries.find((e) => e.id === 'app/api')!.health !== 'healthy' &&
      Date.now() < deadline
    ) {
      await delay(50);
      snapshot = await manager.snapshot();
    }
    expect(snapshot.entries.find((e) => e.id === 'app/api')!.health).toBe('healthy');
    expect(snapshot.entries.find((e) => e.id === 'app/ui')!.state).toBe('stopped');
  } finally {
    await manager.close();
  }
});
it('reports conflicting submissions while reads remain available', async () => {
  const manager = await fixtureManager({
    app: {
      services: {
        api: {
          command: persistentCommand,
          readiness_seconds: 0.5,
          healthcheck: {
            type: 'command',
            command: 'exit 1',
            interval_seconds: 0.05,
            timeout_seconds: 0.05,
          },
        },
        ui: { command: persistentCommand },
      },
    },
  });
  try {
    const accepted = await manager.api(route('app/api', 'start'), {});
    expect(accepted.ok).toBe(true);
    const conflicting = await manager.api(route('app/ui', 'start'), {});
    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) {
      expect(conflicting.error.code).toBe('OPERATION_BUSY');
    }
    expect((await manager.snapshot()).entries.find((e) => e.id === 'app/ui')!.state).toBe(
      'stopped',
    );
  } finally {
    await manager.close();
  }
});
