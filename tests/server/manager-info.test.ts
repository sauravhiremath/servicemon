import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { readInstance } from '../../src/manager/instance.js';
import { startManager, type ManagerOptions } from '../../src/manager/runtime.js';
import { applicationProtocol, packageVersion } from '../../src/shared/build-info.js';
import type { Envelope, ManagerInfo, Snapshot } from '../../src/shared/types.js';
import { persistentCommand } from '../helpers/runtime.js';

// Real manager processes do not follow fake timers.

async function serve(
  options: ManagerOptions,
): Promise<{ endpoint: string; stop: () => Promise<void> }> {
  const added: Array<['SIGTERM' | 'SIGINT', (...args: unknown[]) => void]> = [];
  const original = process.on.bind(process);
  process.on = ((event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'SIGTERM' || event === 'SIGINT') {
      added.push([event, listener]);
    }
    return original(event, listener);
  }) as typeof process.on;
  let endpoint = '';
  try {
    endpoint = await startManager(options);
  } finally {
    process.on = original;
  }
  return {
    endpoint,
    stop: async () => {
      if (endpoint) {
        await fetch(endpoint + '/api/manager/stop', {
          method: 'POST',
          headers: { Origin: endpoint, 'Content-Type': 'application/json' },
          body: '{}',
        }).catch(() => undefined);
        const deadline = Date.now() + 8000;
        while ((await readInstance(options.state)) && Date.now() < deadline) {
          await delay(25);
        }
      }
      for (const [event, listener] of added) {
        process.removeListener(event, listener);
      }
    },
  };
}

async function envelope<T>(
  endpoint: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: Envelope<T> }> {
  const response = await fetch(endpoint + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { Origin: endpoint, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed: unknown = await response.json();
  if (!parsed || typeof parsed !== 'object' || !('ok' in parsed)) {
    throw new Error('Response was not an envelope.');
  }
  return { status: response.status, body: parsed as Envelope<T> };
}

it('reports fixed build information, launch settings, and guarded shutdown', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'servicemon-info-'));
  const config = path.join(folder, 'config.yaml');
  const state = path.join(folder, 'state');
  const ui = path.join(folder, 'dash', 'index.html');
  const previous = {
    shell: process.env.SERVICEMON_LOGIN_SHELL,
    timeout: process.env.SERVICEMON_ENV_CAPTURE_TIMEOUT_MS,
  };
  let manager: { endpoint: string; stop: () => Promise<void> } | undefined;
  try {
    process.env.SERVICEMON_LOGIN_SHELL = '/bin/zsh';
    process.env.SERVICEMON_ENV_CAPTURE_TIMEOUT_MS = '424242';
    await mkdir(path.dirname(ui), { recursive: true });
    await writeFile(ui, '<!doctype html><title>custom</title>\n');
    await writeFile(
      config,
      stringify({
        version: 1,
        projects: {
          demo: { directory: folder, services: { api: { command: persistentCommand } } },
        },
      }),
    );
    manager = await serve({
      config,
      state,
      port: 0,
      ui: path.relative(process.cwd(), ui),
    });
    const first = await envelope<ManagerInfo>(manager.endpoint, '/api/manager/info');
    expect(first.status).toBe(200);
    if (!first.body.ok) {
      throw new Error(first.body.error.message);
    }
    const info = first.body.data;
    expect(info).toMatchObject({
      managementVersion: 2,
      version: packageVersion,
      applicationProtocol,
      pid: process.pid,
      configPath: path.resolve(config),
      endpoint: manager.endpoint,
      launchSettings: { port: Number(new URL(manager.endpoint).port), ui: await realpath(ui) },
      startup: { state: 'succeeded' },
      shutdown: { state: 'idle' },
    });
    expect(JSON.stringify(info)).not.toContain('loginShell');
    expect(JSON.stringify(info)).not.toContain('424242');
    const record = await readInstance(state);
    if (!record) {
      throw new Error('Instance record was not written.');
    }
    expect(JSON.stringify(info)).not.toContain(record.token);
    expect(record.metadata.launchSettings.environmentCapture).toEqual({
      loginShell: '/bin/zsh',
      timeoutMs: 424242,
    });
    const again = await envelope<ManagerInfo>(manager.endpoint, '/api/manager/info');
    expect(again.body.ok && again.body.data.version).toBe(packageVersion);
    expect(again.body.ok && again.body.data.impact.impactKey).toBe(info.impact.impactKey);
    expect(
      (
        await fetch(manager.endpoint + '/api/manager/info', {
          headers: { Origin: 'https://foreign.example' },
        })
      ).status,
    ).toBe(403);
    const endpoint = manager.endpoint;
    const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        endpoint + '/api/manager/info',
        { headers: { Host: 'foreign.example' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.once('error', reject);
      req.end();
    });
    expect(invalidHost).toBe(403);
    const started = await envelope<{ operationId: string }>(
      manager.endpoint,
      '/api/entries/demo%2Fapi/start',
      {},
    );
    if (!started.body.ok) {
      throw new Error(started.body.error.message);
    }
    const operationId = started.body.data.operationId;
    const deadline = Date.now() + 5000;
    let snapshot: Snapshot | undefined;
    while (Date.now() < deadline) {
      const status = await envelope<Snapshot>(manager.endpoint, '/api/status');
      if (
        status.body.ok &&
        status.body.data.entries[0]?.state === 'running' &&
        status.body.data.operations.find((operation) => operation.id === operationId)?.state ===
          'succeeded'
      ) {
        snapshot = status.body.data;
        break;
      }
      await delay(25);
    }
    expect(snapshot?.entries[0]?.state).toBe('running');
    expect(snapshot?.operations.find((operation) => operation.id === operationId)?.state).toBe(
      'succeeded',
    );
    const running = await envelope<ManagerInfo>(manager.endpoint, '/api/manager/info');
    if (!running.body.ok) {
      throw new Error(running.body.error.message);
    }
    expect(running.body.data.impact.processEntryIds).toEqual(['demo/api']);
    expect(running.body.data.impact.impactKey).not.toBe(info.impact.impactKey);
    const settled = await envelope<ManagerInfo>(manager.endpoint, '/api/manager/info');
    expect(settled.body.ok && settled.body.data.impact.impactKey).toBe(
      running.body.data.impact.impactKey,
    );
    const wrongIdentity = await envelope<{ stopping: boolean }>(
      manager.endpoint,
      '/api/manager/stop',
      {
        expected: {
          pid: info.pid + 1,
          startedAt: info.startedAt,
          impactKey: running.body.data.impact.impactKey,
        },
      },
    );
    expect(wrongIdentity.status).toBe(409);
    expect(wrongIdentity.body.ok).toBe(false);
    if (!wrongIdentity.body.ok) {
      expect(wrongIdentity.body.error.code).toBe('MANAGER_CONFLICT');
    }
    const partial = await envelope(manager.endpoint, '/api/manager/stop', {
      expected: { pid: info.pid },
    });
    expect(partial.status).toBe(400);
    const stale = await envelope(manager.endpoint, '/api/manager/stop', {
      expected: { pid: info.pid, startedAt: info.startedAt, impactKey: info.impact.impactKey },
    });
    expect(stale.status).toBe(409);
    const still = await envelope<Snapshot>(manager.endpoint, '/api/status');
    expect(still.body.ok && still.body.data.entries[0]?.state).toBe('running');
    const admitted = await envelope<{ stopping: boolean }>(manager.endpoint, '/api/manager/stop', {
      expected: {
        pid: info.pid,
        startedAt: info.startedAt,
        impactKey: running.body.data.impact.impactKey,
      },
    });
    expect(admitted.status).toBe(200);
    expect(admitted.body).toEqual({ ok: true, data: { stopping: true }, error: null });
    const blocked = await envelope(manager.endpoint, '/api/entries/demo%2Fapi/start', {});
    expect(blocked.body.ok).toBe(false);
    if (!blocked.body.ok) {
      expect(blocked.body.error.code).toBe('MANAGER_STOPPING');
    }
  } finally {
    if (previous.shell === undefined) {
      delete process.env.SERVICEMON_LOGIN_SHELL;
    } else {
      process.env.SERVICEMON_LOGIN_SHELL = previous.shell;
    }
    if (previous.timeout === undefined) {
      delete process.env.SERVICEMON_ENV_CAPTURE_TIMEOUT_MS;
    } else {
      process.env.SERVICEMON_ENV_CAPTURE_TIMEOUT_MS = previous.timeout;
    }
    await manager?.stop();
    await rm(folder, { recursive: true, force: true });
  }
}, 40000);

it('reports a failed autostart without hiding the manager', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'servicemon-autostart-'));
  const config = path.join(folder, 'config.yaml');
  const state = path.join(folder, 'state');
  await writeFile(
    config,
    stringify({
      version: 1,
      projects: {
        demo: { directory: folder, tasks: { boot: { command: 'exit 1', autostart: true } } },
      },
    }),
  );
  const manager = await serve({ config, state, port: 0 });
  try {
    const deadline = Date.now() + 8000;
    let info: ManagerInfo | undefined;
    while (Date.now() < deadline) {
      const response = await envelope<ManagerInfo>(manager.endpoint, '/api/manager/info');
      if (response.body.ok && response.body.data.startup.state !== 'running') {
        info = response.body.data;
        break;
      }
      await delay(25);
    }
    expect(info?.startup.state).toBe('failed');
    expect(info?.startup.error?.code).toBe('TASK_FAILED');
    expect(info?.shutdown.state).toBe('idle');
    expect((await envelope<ManagerInfo>(manager.endpoint, '/api/manager/info')).status).toBe(200);
  } finally {
    await manager.stop();
    await rm(folder, { recursive: true, force: true });
  }
}, 40000);
