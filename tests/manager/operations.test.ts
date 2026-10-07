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
it('allows independent actions during readiness waits but rejects overlapping requests', async () => {
  const manager = await fixtureManager({
    app: {
      services: {
        api: {
          command: persistentCommand,
          readiness_seconds: 60,
          healthcheck: {
            type: 'command',
            command: 'test -f ready',
            interval_seconds: 0.05,
            timeout_seconds: 0.05,
          },
        },
        ui: { command: persistentCommand },
      },
    },
  });
  try {
    const accepted = await manager.api<{ operationId: string }>(route('app/api', 'start'), {});
    if (!accepted.ok) {
      throw new Error(accepted.error.message);
    }
    expect((await manager.operation(route('app/ui', 'start'))).state).toBe('succeeded');
    const conflicting = await manager.api(route('app/api', 'restart'), {});
    expect(conflicting).toMatchObject({
      ok: false,
      error: {
        code: 'OPERATION_BUSY',
        details: { operationId: accepted.data.operationId, entryIds: ['app/api'] },
      },
    });
    const snapshot = await manager.snapshot();
    expect(snapshot.entries.find((entry) => entry.id === 'app/ui')!.state).toBe('running');
    expect(
      snapshot.operations.find((operation) => operation.id === accepted.data.operationId)!.state,
    ).toBe('running');
  } finally {
    await manager.close();
  }
});

it('keeps task results and logs while independent CLI service actions complete', async () => {
  const manager = await fixtureManager({
    skillopt: {
      tasks: {
        'sol-full': {
          command: 'echo task-waiting; while [ ! -f release ]; do sleep 0.05; done; echo task-done',
        },
      },
      services: { local: { command: persistentCommand } },
    },
    'jobs-apply': { services: { ui: { command: persistentCommand } } },
  });
  try {
    const accepted = await manager.api<{ operationId: string }>(
      route('skillopt/sol-full', 'run'),
      {},
    );
    if (!accepted.ok) {
      throw new Error(accepted.error.message);
    }
    for (const action of ['start', 'restart', 'stop']) {
      const result = await manager.cli(action, 'jobs-apply/ui', '--json');
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, data: { state: 'succeeded' } });
    }
    expect((await manager.cli('start', 'skillopt/local', '--json')).code).toBe(0);
    const busy = await manager.cli('run', 'skillopt/sol-full', '--json');
    expect(JSON.parse(busy.stdout)).toMatchObject({ ok: false, error: { code: 'OPERATION_BUSY' } });
    expect(await manager.api('/api/config/reload', {})).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_BUSY' },
    });
    expect(await manager.api('/api/config/edit', { action: 'unused' })).toMatchObject({
      ok: false,
      error: { code: 'OPERATION_BUSY' },
    });
    expect(
      (await manager.cli('logs', 'skillopt/sol-full', '--tail', '10', '--json')).stdout,
    ).toContain('task-waiting');
    expect(
      (await manager.snapshot()).operations.find(
        (operation) => operation.id === accepted.data.operationId,
      )!.state,
    ).toBe('running');
    await writeFile(join(manager.folder, 'release'), '');
    const deadline = Date.now() + 5000;
    let snapshot = await manager.snapshot();
    while (
      snapshot.operations.find((operation) => operation.id === accepted.data.operationId)!.state ===
        'running' &&
      Date.now() < deadline
    ) {
      await delay(25);
      snapshot = await manager.snapshot();
    }
    expect(
      snapshot.operations.find((operation) => operation.id === accepted.data.operationId),
    ).toMatchObject({ state: 'succeeded' });
    expect(snapshot.entries.find((entry) => entry.id === 'skillopt/sol-full')).toMatchObject({
      state: 'succeeded',
      exit: { code: 0 },
    });
    expect((await manager.operation('/api/config/reload')).state).toBe('succeeded');
  } finally {
    await manager.close();
  }
});
