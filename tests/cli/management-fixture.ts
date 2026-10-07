import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { processIdentity } from '../../src/config/process-identity.js';
import { applicationProtocol, packageVersion } from '../../src/shared/build-info.js';

interface FixtureInfo {
  managementVersion: 2;
  version: string;
  applicationProtocol: number;
  pid: number;
  startedAt: string;
  configPath: string;
  endpoint: string;
  launchSettings: {
    port: number;
    ui: string | null;
    environmentCapture?: { loginShell?: string; timeoutMs?: number };
  };
  startup: { state: 'running' | 'succeeded' | 'failed'; error?: { code: string; message: string } };
  shutdown: { state: 'idle' | 'stopping' };
  impact: {
    processEntryIds: string[];
    taskIds: string[];
    operations: { id: string; action: string }[];
    impactKey: string;
  };
}

export interface ManagementDouble {
  folder: string;
  state: string;
  config: string;
  endpoint: string;
  pid: number;
  startedAt: string;
  hits: string[];
  stopBodies: unknown[];
  info: FixtureInfo;
  close: () => Promise<void>;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) {
    return {};
  }
  return JSON.parse(text) as unknown;
}

export async function startManagementDouble(options?: {
  version?: string;
  protocol?: number;
  ui?: string | null;
  impactKey?: string;
  processEntryIds?: string[];
  taskIds?: string[];
  operations?: { id: string; action: string }[];
  legacyImpact?: { operation: { id: string; action?: string } | null };
  liveProcess?: boolean;
  infoStatus?: number;
  infoBody?: unknown;
  stopResult?: { status: number; body: unknown } | 'conflict';
  onRequest?: (hit: string) => Promise<void> | void;
}): Promise<ManagementDouble> {
  const folder = await mkdtemp(path.join(tmpdir(), 'servicemon-cli-'));
  const state = path.join(folder, 'state');
  const config = path.join(folder, 'config.yaml');
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(
    config,
    `version: 1\nprojects:\n  demo:\n    directory: ${JSON.stringify(folder)}\n    services:\n      api:\n        command: "true"\n`,
  );
  let sleeper: ChildProcess | undefined;
  let pid = 2_147_483_646;
  let startedAt = 'not-a-live-manager';
  if (options?.liveProcess) {
    sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const identity = await processIdentity(sleeper.pid ?? 0);
    if (identity.state !== 'alive' || sleeper.pid === undefined) {
      sleeper.kill('SIGTERM');
      throw new Error('Sleeper did not stay alive.');
    }
    pid = sleeper.pid;
    startedAt = identity.startedAt;
  }
  const hits: string[] = [];
  const stopBodies: unknown[] = [];
  const published: { info?: FixtureInfo } = {};
  const server = createServer((request, response) => {
    void (async () => {
      const hit = `${request.method ?? 'GET'} ${request.url ?? '/'}`;
      hits.push(hit);
      await options?.onRequest?.(hit);
      if (request.method === 'GET' && request.url === '/api/manager/info') {
        if (options?.infoBody !== undefined) {
          send(response, options.infoStatus ?? 200, options.infoBody);
          return;
        }
        const info = published.info;
        const data =
          options?.legacyImpact && info
            ? {
                ...info,
                managementVersion: 1,
                impact: {
                  processEntryIds: info.impact.processEntryIds,
                  taskIds: info.impact.taskIds,
                  ...options.legacyImpact,
                  impactKey: info.impact.impactKey,
                },
              }
            : info;
        send(response, 200, { ok: true, data, error: null });
        return;
      }
      if (request.method === 'POST' && request.url === '/api/manager/stop') {
        stopBodies.push(await readBody(request));
        if (options?.stopResult === 'conflict') {
          send(response, 409, {
            ok: false,
            data: null,
            error: { code: 'MANAGER_CONFLICT', message: 'Restart impact changed.' },
          });
          return;
        }
        if (options?.stopResult) {
          send(response, options.stopResult.status, options.stopResult.body);
          return;
        }
        send(response, 200, { ok: true, data: { stopping: true }, error: null });
        return;
      }
      if (request.method === 'GET' && request.url?.startsWith('/api/operations/')) {
        const id = decodeURIComponent(request.url.slice('/api/operations/'.length));
        send(response, 200, {
          ok: true,
          data: {
            id,
            action: 'start',
            target: { entry: 'demo/api' },
            state: 'pending',
            affected: ['demo/api'],
            scope: ['demo/api'],
            startedAt: '2026-10-05T00:00:00.000Z',
          },
          error: null,
        });
        return;
      }
      send(response, 200, {
        ok: true,
        data: { accepted: true, operationId: 'op-1', entries: [] },
        error: null,
      });
    })().catch((error: unknown) => {
      send(response, 500, {
        ok: false,
        data: null,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Fixture did not bind a port.');
  }
  const endpoint = `http://127.0.0.1:${address.port}`;
  const info: FixtureInfo = {
    managementVersion: 2,
    version: options?.version ?? packageVersion,
    applicationProtocol: options?.protocol ?? applicationProtocol,
    pid,
    startedAt,
    configPath: config,
    endpoint,
    launchSettings: { port: address.port, ui: options?.ui ?? null },
    startup: { state: 'succeeded' },
    shutdown: { state: 'idle' },
    impact: {
      processEntryIds: options?.processEntryIds ?? ['demo/api'],
      taskIds: options?.taskIds ?? ['demo/once'],
      operations: options?.operations ?? [{ id: 'op-wait', action: 'start' }],
      impactKey: options?.impactKey ?? 'impact-a',
    },
  };
  published.info = info;
  await writeFile(
    path.join(state, 'instance.json'),
    `${JSON.stringify({
      configPath: config,
      endpoint,
      pid,
      startedAt,
      token: 'fixture-token',
      metadata: {
        version: info.version,
        applicationProtocol: info.applicationProtocol,
        launchSettings: info.launchSettings,
      },
    })}\n`,
  );
  return {
    folder,
    state,
    config,
    endpoint,
    pid,
    startedAt,
    hits,
    stopBodies,
    info,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      if (sleeper && sleeper.exitCode === null && sleeper.signalCode === null) {
        sleeper.kill('SIGTERM');
      }
      await rm(folder, { recursive: true, force: true });
    },
  };
}

export async function withManagerEnv<T>(
  manager: Pick<ManagementDouble, 'folder' | 'state' | 'config'>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = {
    config: process.env.SERVICEMON_CONFIG,
    state: process.env.SERVICEMON_STATE_DIR,
    label: process.env.SERVICEMON_LAUNCH_AGENT_LABEL,
    agents: process.env.SERVICEMON_LAUNCH_AGENTS_DIR,
  };
  process.env.SERVICEMON_CONFIG = manager.config;
  process.env.SERVICEMON_STATE_DIR = manager.state;
  process.env.SERVICEMON_LAUNCH_AGENT_LABEL = `com.servicemon.test.${process.pid}.${path.basename(manager.folder)}`;
  process.env.SERVICEMON_LAUNCH_AGENTS_DIR = path.join(manager.folder, 'agents');
  await mkdir(process.env.SERVICEMON_LAUNCH_AGENTS_DIR, { recursive: true });
  try {
    return await run();
  } finally {
    if (previous.config === undefined) {
      delete process.env.SERVICEMON_CONFIG;
    } else {
      process.env.SERVICEMON_CONFIG = previous.config;
    }
    if (previous.state === undefined) {
      delete process.env.SERVICEMON_STATE_DIR;
    } else {
      process.env.SERVICEMON_STATE_DIR = previous.state;
    }
    if (previous.label === undefined) {
      delete process.env.SERVICEMON_LAUNCH_AGENT_LABEL;
    } else {
      process.env.SERVICEMON_LAUNCH_AGENT_LABEL = previous.label;
    }
    if (previous.agents === undefined) {
      delete process.env.SERVICEMON_LAUNCH_AGENTS_DIR;
    } else {
      process.env.SERVICEMON_LAUNCH_AGENTS_DIR = previous.agents;
    }
  }
}
