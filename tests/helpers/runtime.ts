import { spawn, execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import type { Envelope, Operation, Snapshot } from '../../src/shared/types.js';

export interface FixtureManager {
  folder: string;
  config: string;
  state: string;
  endpoint: string;
  api: <T>(path: string, body?: unknown, headers?: Record<string, string>) => Promise<Envelope<T>>;
  cli: (...args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;
  operation: (path: string, body?: unknown) => Promise<Operation>;
  snapshot: () => Promise<Snapshot>;
  close: () => Promise<void>;
}
export const shellCommand = (code: string) =>
  `${JSON.stringify(process.execPath)} -e '${code.replaceAll("'", "'\\''")}'`;
export const persistentCommand = shellCommand('console.log("started");setInterval(()=>{},1000)');
export async function fixtureManager(
  projects: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<FixtureManager> {
  const folder = await mkdtemp(join(tmpdir(), 'servicemon-test-')),
    config = join(folder, 'config.yaml'),
    state = join(folder, 'state');
  const definitions = Object.fromEntries(
    Object.entries(projects).map(([id, value]) => [
      id,
      { directory: folder, ...(value as object) },
    ]),
  );
  await writeFile(
    config,
    stringify({
      version: 1,
      server: { port: 0 },
      timeouts: { readiness_seconds: 2, stop_seconds: 1 },
      projects: definitions,
      ...extra,
    }),
  );
  const environment = { ...process.env, SERVICEMON_CONFIG: config, SERVICEMON_STATE_DIR: state };
  const child = spawn(
    process.execPath,
    [resolve('dist/cli/main.js'), 'serve', '--config', config, '--port', '0'],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const endpoint = await new Promise<string>((accept, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Manager startup timeout ' + stderr));
    }, 20000);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error('Manager startup exit ' + code + ' ' + stderr));
    });
    child.stdout.once('data', (data) => {
      clearTimeout(timer);
      accept(data.toString().trim());
    });
  });
  const api = async <T>(path: string, body?: unknown, headers: Record<string, string> = {}) =>
    (await (
      await fetch(endpoint + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { Origin: endpoint, 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    ).json()) as Envelope<T>;
  const cli = async (...args: string[]) => {
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [resolve('dist/cli/main.js'), ...args],
        { env: environment, timeout: 20000 },
      );
      return { ...result, code: 0 };
    } catch (error) {
      const result = error as { stdout: string; stderr: string; code: number };
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    }
  };
  const operation = async (path: string, body: unknown = {}) => {
    const accepted = await api<{ operationId: string }>(path, body);
    if (!accepted.ok) {
      throw new Error(JSON.stringify(accepted.error));
    }
    while (true) {
      const result = await api<Operation>('/api/operations/' + accepted.data.operationId);
      if (!result.ok) {
        throw new Error(JSON.stringify(result.error));
      }
      if (!['pending', 'running'].includes(result.data.state)) {
        return result.data;
      }
      await delay(25);
    }
  };
  return {
    folder,
    config,
    state,
    endpoint,
    api,
    cli,
    operation,
    snapshot: async () => {
      const result = await api<Snapshot>('/api/status');
      if (!result.ok) {
        throw new Error(JSON.stringify(result.error));
      }
      return result.data;
    },
    close: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((accept, reject) => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error('Manager shutdown timeout'));
          }, 15000);
          child.once('exit', () => {
            clearTimeout(timer);
            accept();
          });
        });
      }
      await rm(folder, { recursive: true, force: true });
    },
  };
}
