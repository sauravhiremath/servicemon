import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcp, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LogStore } from '../../src/logs/store.js';
import { HealthMonitor } from '../../src/manager/health.js';
import { ProcessAdapter } from '../../src/process/runner.js';
import type { Entry } from '../../src/shared/types.js';

const directories: string[] = [];
const groups: number[] = [];
const servers: Array<Server | TcpServer> = [];

afterEach(async () => {
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* The group is already gone. */
    }
  }
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('health checks', () => {
  it('accepts the expected HTTP status and a TCP connection', async () => {
    const http = await listenHttp((_request, response) => response.writeHead(204).end('no'));
    const tcp = await listenTcp();
    const monitor = new HealthMonitor(process.env, () => undefined);
    const directory = await tempDir();
    await expect(
      monitor.check(
        entry(directory, { type: 'http', url: http.url, expected_status: 204, timeout_seconds: 1 }),
      ),
    ).resolves.toBe(true);
    await expect(
      monitor.check(entry(directory, { type: 'http', url: http.url, timeout_seconds: 1 })),
    ).resolves.toBe(false);
    await expect(
      monitor.check(
        entry(directory, { type: 'tcp', host: '127.0.0.1', port: tcp.port, timeout_seconds: 1 }),
      ),
    ).resolves.toBe(true);
    await expect(
      monitor.check(
        entry(directory, { type: 'tcp', host: '127.0.0.1', port: 1, timeout_seconds: 1 }),
      ),
    ).resolves.toBe(false);
    expect(monitor.health('proj/api')).toBe('unhealthy');
    await monitor.shutdown();
  });

  it('times out an HTTP check and a command group without stopping a service', async () => {
    const directory = await tempDir();
    const slow = await listenHttp(() => undefined);
    const pidfile = join(directory, 'check.pid');
    const service = entry(directory, undefined, `sleep 30`);
    const logs = new LogStore(directory, { perEntryBytes: 100_000, totalBytes: 100_000 });
    const adapter = new ProcessAdapter([service], process.env, logs, directory, () => undefined);
    await adapter.start(service, process.env);
    const servicePid = adapter.status(service.id).pid!;
    groups.push(servicePid);
    const monitor = new HealthMonitor({ ...process.env, PIDFILE: pidfile }, () => undefined);
    const httpEntry = entry(directory, { type: 'http', url: slow.url, timeout_seconds: 0.3 });
    await expect(monitor.check(httpEntry)).resolves.toBe(false);
    expect(adapter.status(service.id).state).toBe('running');
    expect(alive(servicePid)).toBe(true);

    const command = entry(directory, {
      type: 'command',
      command: 'echo $$ > "$PIDFILE"; sleep 30',
      timeout_seconds: 0.3,
    });
    await expect(monitor.check(command)).resolves.toBe(false);
    const checkPid = Number(await readFile(pidfile, 'utf8'));
    await waitFor(() => !alive(checkPid));
    expect(alive(servicePid)).toBe(true);
    expect(adapter.status(service.id).state).toBe('running');
    await adapter.shutdown();
    logs.close();
    await monitor.shutdown();
  });

  it('does not overlap checks and uses the updated environment', async () => {
    const directory = await tempDir();
    const count = join(directory, 'count');
    const monitor = new HealthMonitor(
      { ...process.env, TOKEN: 'one', COUNT: count },
      () => undefined,
    );
    const command = entry(directory, {
      type: 'command',
      command: 'echo x >> "$COUNT"; test "$TOKEN" = one',
      timeout_seconds: 2,
    });
    const first = monitor.check(command);
    const second = monitor.check(command);
    expect(second).toBe(first);
    await expect(first).resolves.toBe(true);
    expect((await readFile(count, 'utf8')).trim().split('\n')).toEqual(['x']);
    monitor.updateEnvironment({ ...process.env, TOKEN: 'two', COUNT: count });
    await expect(monitor.check(command)).resolves.toBe(false);
    expect(monitor.health(command.id)).toBe('unhealthy');
    await monitor.shutdown();
  });

  it('observes later health recovery without starting anything', async () => {
    let status = 500;
    const http = await listenHttp((_request, response) => response.writeHead(status).end('x'));
    const changes: string[] = [];
    const monitor = new HealthMonitor(process.env, () => changes.push('change'));
    const directory = await tempDir();
    const watched = entry(directory, {
      type: 'http',
      url: http.url,
      interval_seconds: 0.2,
      timeout_seconds: 1,
    });
    monitor.watch(watched);
    await waitFor(() => monitor.health(watched.id) === 'unhealthy');
    status = 200;
    await waitFor(() => monitor.health(watched.id) === 'healthy');
    expect(changes.length).toBeGreaterThan(0);
    monitor.unwatch(watched.id);
    status = 500;
    await delay(400);
    expect(monitor.health(watched.id)).toBe('healthy');
    await monitor.shutdown();
  });

  it('stops an in-flight command check on shutdown', async () => {
    const directory = await tempDir();
    const pidfile = join(directory, 'check.pid');
    const monitor = new HealthMonitor({ ...process.env, PIDFILE: pidfile }, () => undefined);
    const pending = monitor.check(
      entry(directory, {
        type: 'command',
        command: 'echo $$ > "$PIDFILE"; sleep 30',
        timeout_seconds: 5,
      }),
    );
    await waitFor(async () => {
      try {
        return alive(Number(await readFile(pidfile, 'utf8')));
      } catch {
        return false;
      }
    });
    const pid = Number(await readFile(pidfile, 'utf8'));
    await monitor.shutdown();
    await expect(pending).resolves.toBe(false);
    await waitFor(() => !alive(pid));
  });

  it('reports an unhealthy command check when its directory is missing', async () => {
    const crashes: string[] = [];
    const onError = (error: Error) => {
      crashes.push(error.message);
    };
    process.on('uncaughtException', onError);
    const monitor = new HealthMonitor(process.env, () => undefined);
    try {
      const missing = entry('/no/such/servicemon-dir', {
        type: 'command',
        command: 'exit 0',
        timeout_seconds: 1,
      });
      await expect(monitor.check(missing)).resolves.toBe(false);
      await delay(50);
      expect(crashes).toEqual([]);
      expect(monitor.health(missing.id)).toBe('unhealthy');
    } finally {
      process.off('uncaughtException', onError);
      await monitor.shutdown();
    }
  });
});

function entry(directory: string, healthcheck: Entry['healthcheck'], command = 'sleep 1'): Entry {
  return {
    id: 'proj/api',
    projectId: 'proj',
    key: 'api',
    name: 'API',
    kind: 'service',
    directory,
    command,
    links: [],
    dependsOn: [],
    autostart: false,
    restartDependencies: false,
    restartDependents: false,
    stopSeconds: 2,
    readinessSeconds: 5,
    ...(healthcheck ? { healthcheck } : {}),
  };
}

async function listenHttp(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string }> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('HTTP test server has no port.');
  }
  return { url: `http://127.0.0.1:${address.port}/health` };
}

async function listenTcp(): Promise<{ port: number }> {
  const server = createTcp((socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('TCP test server has no port.');
  }
  return { port: address.port };
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'servicemon-health-'));
  directories.push(directory);
  return directory;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(30);
  }
  throw new Error('Condition was not met.');
}

function closeServer(server: Server | TcpServer): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}
