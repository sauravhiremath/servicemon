import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { expect, it } from 'vitest';
import type { ManagerClient } from '../../src/cli/client.js';
import { addDefinitionCommands } from '../../src/cli/definitions.js';
import { createCommandClient, managerStatus, managerStop } from '../../src/cli/manager.js';
import { printError } from '../../src/cli/output.js';
import { applicationProtocol, packageVersion } from '../../src/shared/build-info.js';
import { AppError } from '../../src/shared/errors.js';
import { startManagementDouble, withManagerEnv } from './management-fixture.js';

function captureError(
  error: unknown,
  json = true,
): { stdout: string; stderr: string; code: number | undefined } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const log = console.log;
  const err = console.error;
  const previous = process.exitCode;
  console.log = (line?: unknown) => {
    stdout.push(String(line));
  };
  console.error = (line?: unknown) => {
    stderr.push(String(line));
  };
  try {
    printError(error, json);
    return {
      stdout: stdout.join('\n'),
      stderr: stderr.join('\n'),
      code: typeof process.exitCode === 'number' ? process.exitCode : undefined,
    };
  } finally {
    console.log = log;
    console.error = err;
    process.exitCode = previous;
  }
}

it('blocks an incompatible script command before the application action', async () => {
  const manager = await startManagementDouble({
    version: '9.9.9',
    protocol: applicationProtocol + 1,
  });
  try {
    await withManagerEnv(manager, async () => {
      const client = createCommandClient({ terminal: false });
      const error = await client.request('/api/entries/demo%2Fapi/start', {}).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        code: 'MANAGER_VERSION_MISMATCH',
        details: {
          cliVersion: packageVersion,
          managerVersion: '9.9.9',
          cliProtocol: applicationProtocol,
          applicationProtocol: applicationProtocol + 1,
          command: 'servicemon manager restart',
        },
      });
      expect(manager.hits).toEqual(['GET /api/manager/info']);
      const printed = captureError(error);
      expect(printed.code).toBe(5);
      expect(printed.stderr).toBe('');
      expect(printed.stdout.split('\n')).toHaveLength(1);
      expect(JSON.parse(printed.stdout)).toMatchObject({
        ok: false,
        data: null,
        error: { code: 'MANAGER_VERSION_MISMATCH' },
      });
    });
  } finally {
    await manager.close();
  }
});

it('continues a compatible script and writes the version notice only to stderr', async () => {
  const manager = await startManagementDouble({ version: '0.0.1', protocol: applicationProtocol });
  const notices: string[] = [];
  const err = console.error;
  console.error = (line?: unknown) => {
    notices.push(String(line));
  };
  try {
    await withManagerEnv(manager, async () => {
      const client = createCommandClient({ terminal: false });
      const result = await client.request<{ accepted: boolean }>(
        '/api/entries/demo%2Fapi/start',
        {},
      );
      expect(result.accepted).toBe(true);
      expect(manager.hits).toEqual(['GET /api/manager/info', 'POST /api/entries/demo%2Fapi/start']);
      expect(manager.stopBodies).toEqual([]);
      expect(notices.join('\n')).toContain('0.0.1');
      expect(notices.join('\n')).toContain(packageVersion);
      expect(notices.join('\n')).not.toContain('[y/N]');
    });
  } finally {
    console.error = err;
    await manager.close();
  }
});

it('does not treat an invalid management response as a version mismatch', async () => {
  const manager = await startManagementDouble({
    infoBody: { ok: true, data: { managementVersion: 1 }, error: null },
  });
  try {
    await withManagerEnv(manager, async () => {
      const client = createCommandClient({ terminal: false });
      await expect(client.request('/api/status')).rejects.toMatchObject({
        code: 'MANAGER_UNAVAILABLE',
      });
      expect(manager.hits).toEqual(['GET /api/manager/info']);
    });
  } finally {
    await manager.close();
  }
});

it('keeps later requests on the selected manager', async () => {
  const manager = await startManagementDouble();
  try {
    await withManagerEnv(manager, async () => {
      const client = createCommandClient({ terminal: false });
      await client.request('/api/status');
      await writeFile(
        path.join(manager.state, 'instance.json'),
        `${JSON.stringify({
          configPath: manager.config,
          endpoint: 'http://127.0.0.1:9',
          pid: manager.pid + 1,
          startedAt: 'replaced',
          token: 'other-token',
          metadata: {
            version: '0.1.2',
            applicationProtocol: 1,
            launchSettings: { ui: null, port: 9 },
          },
        })}\n`,
      );
      const error = await client.request('/api/status').then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: 'MANAGER_CONFLICT' });
      expect(manager.hits.filter((hit) => hit === 'GET /api/status')).toEqual(['GET /api/status']);
    });
  } finally {
    await manager.close();
  }
});

it('does not restart or drop an existing operation id when the version differs', async () => {
  const manager = await startManagementDouble({ version: '0.0.2' });
  try {
    await withManagerEnv(manager, async () => {
      const client = createCommandClient({ terminal: true, confirm: async () => true });
      const operation = await client.request<{ id: string }>(
        '/api/operations/op-keep',
        undefined,
        'observe',
      );
      expect(operation.id).toBe('op-keep');
      expect(manager.stopBodies).toEqual([]);
      expect(manager.hits).toEqual(['GET /api/manager/info', 'GET /api/operations/op-keep']);
      await writeFile(
        path.join(manager.state, 'instance.json'),
        `${JSON.stringify({
          configPath: manager.config,
          endpoint: 'http://127.0.0.1:9',
          pid: manager.pid + 1,
          startedAt: 'replaced',
          token: 'other-token',
          metadata: {
            version: '0.1.2',
            applicationProtocol: 1,
            launchSettings: { ui: null, port: 9 },
          },
        })}\n`,
      );
      await expect(client.observeOperation('op-keep')).rejects.toMatchObject({
        code: 'MANAGER_CONFLICT',
        operationId: 'op-keep',
      });
      expect(manager.hits.filter((hit) => hit.startsWith('GET /api/operations/'))).toEqual([
        'GET /api/operations/op-keep',
      ]);
    });
  } finally {
    await manager.close();
  }
});

it('does not fetch an existing operation when the protocol differs', async () => {
  const manager = await startManagementDouble({ protocol: applicationProtocol + 1 });
  try {
    await withManagerEnv(manager, async () => {
      const client = createCommandClient({ terminal: true, confirm: async () => true });
      await expect(
        client.request('/api/operations/op-keep', undefined, 'observe'),
      ).rejects.toMatchObject({ code: 'MANAGER_VERSION_MISMATCH' });
      expect(manager.hits).toEqual(['GET /api/manager/info']);
      expect(manager.stopBodies).toEqual([]);
    });
  } finally {
    await manager.close();
  }
});

it('reports manager status without a restart prompt when protocols differ', async () => {
  const manager = await startManagementDouble({
    version: '9.9.9',
    protocol: applicationProtocol + 1,
  });
  try {
    await withManagerEnv(manager, async () => {
      const status = await managerStatus();
      expect(status).toMatchObject({
        running: true,
        endpoint: manager.endpoint,
        configPath: manager.config,
        pid: manager.pid,
        cliVersion: packageVersion,
        managerVersion: '9.9.9',
        applicationProtocol: applicationProtocol + 1,
        compatible: false,
        restartRequired: true,
      });
      expect(manager.hits).toEqual(['GET /api/manager/info']);
      expect(manager.stopBodies).toEqual([]);
    });
  } finally {
    await manager.close();
  }
});

it('stops through the management contract without an upgrade prompt', async () => {
  const manager = await startManagementDouble({ protocol: applicationProtocol + 1 });
  try {
    await withManagerEnv(manager, async () => {
      await expect(managerStop()).resolves.toEqual({ stopping: true });
      expect(manager.hits).toEqual(['POST /api/manager/stop']);
      expect(manager.stopBodies).toEqual([{}]);
    });
  } finally {
    await manager.close();
  }
});

it('does not inspect the manager for local config commands', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'servicemon-local-'));
  const config = path.join(directory, 'config.yaml');
  await writeFile(config, 'version: 1\nprojects: {}\n');
  const calls: string[] = [];
  const client: ManagerClient = {
    async request() {
      calls.push('request');
      throw new Error('manager request');
    },
    async observeOperation() {
      calls.push('observe');
      throw new Error('manager request');
    },
  };
  const program = new Command().name('servicemon').option('--config <path>').exitOverride();
  program.configureOutput({ writeErr() {}, writeOut() {} });
  addDefinitionCommands(program, client);
  await program.parseAsync(['config', 'path', '--config', config], { from: 'user' });
  await program.parseAsync(['config', 'validate', '--config', config], { from: 'user' });
  await program.parseAsync(['project', 'list', '--config', config], { from: 'user' });
  expect(calls).toEqual([]);
});

it('prints one JSON envelope for a connection failure', async () => {
  const printed = captureError(
    new AppError('MANAGER_UNAVAILABLE', 'Cannot connect to the manager.'),
  );
  expect(printed.code).toBe(3);
  expect(printed.stderr).toBe('');
  expect(JSON.parse(printed.stdout).error.code).toBe('MANAGER_UNAVAILABLE');
});
