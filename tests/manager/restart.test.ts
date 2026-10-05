import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { HealthMonitor } from '../../src/manager/health.js';
import { Operations } from '../../src/manager/operations.js';
import type { CompiledConfig, Entry, EntryStatus } from '../../src/shared/types.js';

const identity = { pid: process.pid, startedAt: 'manager-start' };
function entry(id: string, kind: Entry['kind']): Entry {
  return {
    id,
    projectId: 'app',
    key: id,
    name: id,
    kind,
    directory: '/tmp',
    command: 'true',
    links: [],
    dependsOn: [],
    autostart: false,
    restartDependencies: false,
    restartDependents: false,
    stopSeconds: 1,
    readinessSeconds: 1,
  };
}
function config(source = 'version: 1\n'): CompiledConfig {
  return {
    path: '/tmp/config.yaml',
    source,
    raw: {},
    port: 0,
    logs: { perEntryBytes: 1, totalBytes: 1 },
    stopSeconds: 1,
    readinessSeconds: 1,
    projects: [{ id: 'app', name: 'app', directory: '/tmp' }],
    entries: [entry('app/api', 'service'), entry('app/boot', 'task')],
    groups: [],
  };
}

it('keeps restart impact stable until entries, operations, or config change', async () => {
  let processes: string[] = [];
  let tasks: string[] = [];
  let health = 'unknown';
  const adapter = {
    status: (id: string) =>
      ({
        state: processes.includes(id) || tasks.includes(id) ? 'running' : 'stopped',
        health,
      }) as EntryStatus,
    start: async () => undefined,
    stop: async () => undefined,
    ready: async () => true,
    shutdown: async () => undefined,
    waitTask: async () => ({ state: 'succeeded' }) as EntryStatus,
  };
  const monitor = new HealthMonitor({}, () => undefined);
  const ops = new Operations(
    config(),
    {},
    { process: adapter, compose: adapter },
    monitor,
    () => undefined,
    identity,
  );
  try {
    const first = ops.impact();
    health = 'healthy';
    await delay(30);
    expect(ops.impact()).toEqual(first);
    processes = ['app/api'];
    const withProcess = ops.impact();
    expect(withProcess.impactKey).not.toBe(first.impactKey);
    expect(withProcess.processEntryIds).toEqual(['app/api']);
    tasks = ['app/boot'];
    const withTask = ops.impact();
    expect(withTask.taskIds).toEqual(['app/boot']);
    expect(withTask.impactKey).not.toBe(withProcess.impactKey);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = ops.enqueue('reload', {}, async () => {
      await gate;
    });
    const during = ops.impact();
    expect(during.operation).toEqual({ id: operation.id, action: 'reload' });
    expect(during.impactKey).not.toBe(withTask.impactKey);
    expect(ops.impact().impactKey).toBe(during.impactKey);
    ops.applyConfig(config('version: 1\nprojects: {}\n'), {});
    expect(ops.impact().impactKey).not.toBe(during.impactKey);
    release();
    await ops.wait(operation.id);
  } finally {
    await ops.shutdown();
  }
});

it('rejects a stale shutdown expectation before stopping anything', async () => {
  let stopped = 0;
  const adapter = {
    status: () => ({ state: 'stopped' }) as EntryStatus,
    start: async () => undefined,
    stop: async () => undefined,
    ready: async () => true,
    shutdown: async () => {
      stopped += 1;
    },
    waitTask: async () => ({ state: 'succeeded' }) as EntryStatus,
  };
  const monitor = new HealthMonitor({}, () => undefined);
  const ops = new Operations(
    config(),
    {},
    { process: adapter, compose: adapter },
    monitor,
    () => undefined,
    identity,
  );
  try {
    const impactKey = ops.impact().impactKey;
    expect(() =>
      ops.admitShutdown({ pid: identity.pid + 1, startedAt: identity.startedAt, impactKey }),
    ).toThrow(expect.objectContaining({ code: 'MANAGER_CONFLICT' }));
    expect(() =>
      ops.admitShutdown({ pid: identity.pid, startedAt: 'other-start', impactKey }),
    ).toThrow(expect.objectContaining({ code: 'MANAGER_CONFLICT' }));
    expect(() =>
      ops.admitShutdown({ pid: identity.pid, startedAt: identity.startedAt, impactKey: 'stale' }),
    ).toThrow(expect.objectContaining({ code: 'MANAGER_CONFLICT' }));
    expect(ops.shutdownStatus()).toEqual({ state: 'idle' });
    expect(stopped).toBe(0);
    expect(ops.submit('start', { entry: 'app/api' }).id).toBeTruthy();
  } finally {
    await ops.shutdown();
  }
});

it('admits a matching shutdown once and rejects new work immediately', async () => {
  let processStops = 0;
  let composeStops = 0;
  const processAdapter = {
    status: () => ({ state: 'running' }) as EntryStatus,
    start: async () => undefined,
    stop: async () => undefined,
    ready: async () => true,
    shutdown: async () => {
      processStops += 1;
    },
    waitTask: async () => ({ state: 'succeeded' }) as EntryStatus,
  };
  const composeAdapter = {
    status: () => ({ state: 'running' }) as EntryStatus,
    start: async () => undefined,
    stop: async () => undefined,
    ready: async () => true,
    shutdown: async () => {
      composeStops += 1;
    },
  };
  const monitor = new HealthMonitor({}, () => undefined);
  const ops = new Operations(
    config(),
    {},
    { process: processAdapter, compose: composeAdapter },
    monitor,
    () => undefined,
    identity,
  );
  const expected = {
    pid: identity.pid,
    startedAt: identity.startedAt,
    impactKey: ops.impact().impactKey,
  };
  ops.admitShutdown(expected);
  expect(ops.shutdownStatus()).toEqual({ state: 'stopping' });
  expect(processStops).toBe(0);
  expect(() => ops.submit('start', { entry: 'app/api' })).toThrow(
    expect.objectContaining({ code: 'MANAGER_STOPPING' }),
  );
  ops.admitShutdown(expected);
  expect(() => ops.admitShutdown({ ...expected, impactKey: 'other' })).toThrow(
    expect.objectContaining({ code: 'MANAGER_CONFLICT' }),
  );
  await ops.shutdown();
  await ops.shutdown();
  expect(processStops).toBe(1);
  expect(composeStops).toBe(1);
});

it('autostarts only entries marked for autostart', async () => {
  const started: string[] = [];
  const states = new Map<string, string>();
  const entries = [
    entry('app/api', 'service'),
    entry('app/extra', 'service'),
    entry('app/boot', 'task'),
  ];
  entries[0]!.autostart = true;
  entries[2]!.autostart = true;
  const adapter = {
    status: (id: string) =>
      ({ state: states.get(id) ?? (id.endsWith('boot') ? 'idle' : 'stopped') }) as EntryStatus,
    start: async (item: Entry) => {
      started.push(item.id);
      states.set(item.id, 'running');
    },
    stop: async () => undefined,
    ready: async () => true,
    shutdown: async () => undefined,
    waitTask: async (id: string) => {
      states.set(id, 'succeeded');
      return { state: 'succeeded' } as EntryStatus;
    },
  };
  const monitor = new HealthMonitor({}, () => undefined);
  const ops = new Operations(
    { ...config(), entries },
    {},
    { process: adapter, compose: adapter },
    monitor,
    () => undefined,
  );
  try {
    await ops.autostart();
    expect(started).toEqual(['app/api', 'app/boot']);
    expect(ops.startupStatus()).toEqual({ state: 'succeeded' });
    expect(states.has('app/extra')).toBe(false);
  } finally {
    await ops.shutdown();
  }
});

it('waits for the active operation during shutdown and does not signal this process', async () => {
  let release: () => void = () => undefined;
  let ran = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signals: Array<number | string> = [];
  const originalKill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === process.pid) {
      signals.push(signal ?? 0);
    }
    return originalKill(pid, signal);
  }) as typeof process.kill;
  const adapter = {
    status: () => ({ state: 'stopped' }) as EntryStatus,
    start: async () => undefined,
    stop: async () => undefined,
    ready: async () => true,
    shutdown: async () => undefined,
    waitTask: async () => ({ state: 'succeeded' }) as EntryStatus,
  };
  const monitor = new HealthMonitor({}, () => undefined);
  const ops = new Operations(
    config(),
    {},
    { process: adapter, compose: adapter },
    monitor,
    () => undefined,
    identity,
  );
  try {
    ops.enqueue('reload', {}, async () => {
      await gate;
      ran = true;
    });
    let settled = false;
    const pending = ops.shutdown().then(() => {
      settled = true;
    });
    expect(settled).toBe(false);
    expect(ran).toBe(false);
    release();
    await pending;
    expect(ran).toBe(true);
    expect(settled).toBe(true);
    expect(signals).toEqual([]);
  } finally {
    process.kill = originalKill;
    await ops.shutdown();
  }
});

it('does not launch a dependent when its task completes during shutdown', async () => {
  const dependency = entry('app/boot', 'task');
  const dependent = entry('app/api', 'service');
  dependent.dependsOn = [dependency.id];
  const waiting = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<EntryStatus>();
  const started: string[] = [];
  const adapter = {
    status: () => ({ state: 'stopped' }) as EntryStatus,
    start: async (item: Entry) => {
      started.push(item.id);
    },
    stop: async () => undefined,
    ready: async () => true,
    shutdown: async () => {
      completed.resolve({ state: 'succeeded' } as EntryStatus);
    },
    waitTask: async () => {
      waiting.resolve();
      return completed.promise;
    },
  };
  const ops = new Operations(
    { ...config(), entries: [dependency, dependent] },
    {},
    { process: adapter, compose: adapter },
    new HealthMonitor({}, () => undefined),
    () => undefined,
    identity,
  );
  const operation = ops.submit('start', { entry: dependent.id });
  await waiting.promise;
  await ops.shutdown();
  expect(started).toEqual([dependency.id]);
  expect(await ops.wait(operation.id)).toMatchObject({
    state: 'failed',
    error: { code: 'MANAGER_STOPPING' },
  });
});
