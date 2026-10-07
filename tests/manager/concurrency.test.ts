import { expect, it } from 'vitest';
import { HealthMonitor } from '../../src/manager/health.js';
import { Operations } from '../../src/manager/operations.js';
import type { CompiledConfig, Entry, EntryState, EntryStatus } from '../../src/shared/types.js';

interface TaskGate {
  promise: Promise<EntryStatus>;
  resolve: (status: EntryStatus) => void;
}

function entry(id: string, overrides: Partial<Entry> = {}): Entry {
  return {
    id,
    projectId: id.split('/')[0]!,
    key: id.split('/')[1]!,
    name: id,
    kind: 'service',
    directory: '/tmp',
    command: 'true',
    links: [],
    dependsOn: [],
    autostart: false,
    restartDependencies: false,
    restartDependents: false,
    stopSeconds: 1,
    readinessSeconds: 1,
    ...overrides,
  };
}

function manager(entries: Entry[]) {
  const states = new Map<string, EntryState>();
  const gates = new Map<string, TaskGate>();
  const started: string[] = [];
  const stopped: string[] = [];
  const adapter = {
    status: (id: string) => ({ state: states.get(id) ?? 'stopped' }) as EntryStatus,
    start: async (item: Entry) => {
      started.push(item.id);
      states.set(item.id, 'running');
    },
    stop: async (item: Entry) => {
      stopped.push(item.id);
      states.set(item.id, 'stopped');
    },
    ready: async () => true,
    waitTask: async (id: string) => {
      const result = await gates.get(id)!.promise;
      states.set(id, result.state);
      return result;
    },
    shutdown: async () => {
      for (const [id, gate] of gates) {
        states.set(id, 'stopped');
        gate.resolve({ state: 'stopped' } as EntryStatus);
      }
    },
  };
  const config: CompiledConfig = {
    path: '/tmp/config.yaml',
    source: '',
    raw: {},
    port: 0,
    logs: { perEntryBytes: 1, totalBytes: 1 },
    stopSeconds: 1,
    readinessSeconds: 1,
    projects: [...new Set(entries.map((item) => item.projectId))].map((id) => ({
      id,
      name: id,
      directory: '/tmp',
    })),
    entries,
    groups: [],
  };
  const ops = new Operations(
    config,
    {},
    { process: adapter, compose: adapter },
    new HealthMonitor({}, () => undefined),
    () => undefined,
  );
  return { ops, gates, states, started, stopped };
}

it('reserves pending dependents and shared prerequisites without blocking independent entries', async () => {
  const fixture = manager([
    entry('app/setup', { kind: 'task' }),
    entry('app/api', { dependsOn: ['app/setup'] }),
    entry('other/worker', { dependsOn: ['app/setup'] }),
    entry('app/ui'),
  ]);
  const gate = Promise.withResolvers<EntryStatus>();
  fixture.gates.set('app/setup', gate);
  const { ops } = fixture;
  try {
    const first = ops.submit('start', { entry: 'app/api' });
    expect(first.scope).toEqual(['app/api', 'app/setup']);
    expect(() => ops.submit('stop', { entry: 'app/api' })).toThrow(
      expect.objectContaining({
        code: 'OPERATION_BUSY',
        details: { operationId: first.id, entryIds: ['app/api'] },
      }),
    );
    expect(() => ops.submit('start', { entry: 'other/worker' })).toThrow(
      expect.objectContaining({
        code: 'OPERATION_BUSY',
        details: { operationId: first.id, entryIds: ['app/setup'] },
      }),
    );
    const unrelated = ops.submit('start', { entry: 'app/ui' });
    expect((await ops.wait(unrelated.id)).state).toBe('succeeded');
    expect(first.state).toBe('running');
    expect(() => ops.submit('stop', { entry: 'app/api' })).toThrow(
      expect.objectContaining({ code: 'OPERATION_BUSY' }),
    );
    expect(fixture.started).toEqual(['app/setup', 'app/ui']);
    expect(fixture.stopped).toEqual([]);
    gate.resolve({ state: 'succeeded' } as EntryStatus);
    expect((await ops.wait(first.id)).state).toBe('succeeded');
    expect(fixture.started).toEqual(['app/setup', 'app/ui', 'app/api']);
    expect((await ops.wait(ops.submit('stop', { entry: 'app/api' }).id)).state).toBe('succeeded');
  } finally {
    await ops.shutdown();
  }
});

it('releases failed scopes and keeps config work exclusive in both directions', async () => {
  const { ops, gates } = manager([entry('app/task', { kind: 'task' }), entry('app/ui')]);
  const task = Promise.withResolvers<EntryStatus>();
  const reload = Promise.withResolvers<void>();
  gates.set('app/task', task);
  try {
    const run = ops.submit('run', { entry: 'app/task' });
    expect(() => ops.exclusive('reload', async () => undefined)).toThrow(
      expect.objectContaining({ code: 'OPERATION_BUSY' }),
    );
    task.resolve({ state: 'failed' } as EntryStatus);
    expect(await ops.wait(run.id)).toMatchObject({
      state: 'failed',
      error: { code: 'TASK_FAILED' },
    });
    const config = ops.exclusive('reload', () => reload.promise);
    expect(config.scope).toBeNull();
    expect(() => ops.submit('start', { entry: 'app/ui' })).toThrow(
      expect.objectContaining({
        code: 'OPERATION_BUSY',
        details: { operationId: config.id, entryIds: ['app/ui'] },
      }),
    );
    reload.reject(new Error('invalid config'));
    expect((await ops.wait(config.id)).state).toBe('failed');
    expect((await ops.wait(ops.submit('start', { entry: 'app/ui' }).id)).state).toBe('succeeded');
  } finally {
    reload.resolve();
    await ops.shutdown();
  }
});

it('reserves native Compose group effects and restart prerequisites before stopping entries', async () => {
  const { ops, gates, states, stopped } = manager([
    entry('app/setup', { kind: 'task' }),
    entry('app/api', { dependsOn: ['app/setup'], restartDependents: true }),
    entry('app/ui', { dependsOn: ['app/api'] }),
    entry('app/stack.db', { kind: 'compose', composeGroupId: 'app/stack' }),
    entry('app/stack.cache', { kind: 'compose', composeGroupId: 'app/stack' }),
    entry('app/native', { dependsOn: ['app/stack.db', 'app/setup'] }),
  ]);
  const gate = Promise.withResolvers<EntryStatus>();
  gates.set('app/setup', gate);
  states.set('app/api', 'running');
  states.set('app/ui', 'running');
  try {
    const restart = ops.submit('restart', { entry: 'app/api' });
    expect(restart.scope).toEqual(['app/api', 'app/setup', 'app/ui']);
    expect(() => ops.submit('stop', { entry: 'app/setup' })).toThrow(
      expect.objectContaining({ code: 'OPERATION_BUSY' }),
    );
    gate.resolve({ state: 'succeeded' } as EntryStatus);
    expect((await ops.wait(restart.id)).state).toBe('succeeded');
    expect(stopped).toEqual(['app/ui', 'app/api']);
    const next = Promise.withResolvers<EntryStatus>();
    gates.set('app/setup', next);
    await ops.wait(ops.submit('stop', { entry: 'app/setup' }).id);
    const native = ops.submit('start', { entry: 'app/native' });
    expect(native.scope).toEqual(['app/native', 'app/setup', 'app/stack.cache', 'app/stack.db']);
    expect(() => ops.submit('start', { entry: 'app/stack.cache' })).toThrow(
      expect.objectContaining({ code: 'OPERATION_BUSY' }),
    );
    next.resolve({ state: 'succeeded' } as EntryStatus);
    expect((await ops.wait(native.id)).state).toBe('succeeded');
  } finally {
    await ops.shutdown();
  }
});

it('includes every active operation in restart impact and settles concurrent tasks on shutdown', async () => {
  const { ops, gates, started } = manager([
    entry('app/first', { kind: 'task' }),
    entry('app/second', { kind: 'task' }),
    entry('app/dependent', { dependsOn: ['app/second'] }),
  ]);
  gates.set('app/first', Promise.withResolvers<EntryStatus>());
  gates.set('app/second', Promise.withResolvers<EntryStatus>());
  const first = ops.submit('run', { entry: 'app/first' });
  const one = ops.impact();
  const second = ops.submit('start', { entry: 'app/dependent' });
  const both = ops.impact();
  expect(both.operations).toEqual(
    expect.arrayContaining([
      { id: first.id, action: 'run' },
      { id: second.id, action: 'start' },
    ]),
  );
  expect(both.operations).toHaveLength(2);
  expect(both.impactKey).not.toBe(one.impactKey);
  await ops.shutdown();
  expect((await ops.wait(first.id)).state).toBe('failed');
  expect((await ops.wait(second.id)).state).toBe('failed');
  expect(started).toEqual(['app/first', 'app/second']);
  expect(ops.impact().operations).toEqual([]);
  expect(() => ops.submit('run', { entry: 'app/first' })).toThrow(
    expect.objectContaining({ code: 'MANAGER_STOPPING' }),
  );
});
