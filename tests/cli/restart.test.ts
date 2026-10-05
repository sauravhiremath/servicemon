import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { stringify } from 'yaml';
import { createCommandClient, restartManager } from '../../src/cli/manager.js';
import { printError } from '../../src/cli/output.js';
import { packageVersion } from '../../src/shared/build-info.js';
import { persistentCommand, shellCommand } from '../helpers/runtime.js';
import { startManagementDouble, withManagerEnv } from './management-fixture.js';
import type { ManagementDouble } from './management-fixture.js';

const exec = promisify(execFile);

function printed(error: unknown): { stdout: string; code: number | undefined } {
  const lines: string[] = [];
  const log = console.log;
  const previous = process.exitCode;
  console.log = (line?: unknown) => {
    lines.push(String(line));
  };
  try {
    printError(error, true);
    return {
      stdout: lines.join('\n'),
      code: typeof process.exitCode === 'number' ? process.exitCode : undefined,
    };
  } finally {
    console.log = log;
    process.exitCode = previous;
  }
}

it('requires --yes before a script can restart', async () => {
  const manager = await startManagementDouble({ liveProcess: true });
  try {
    await withManagerEnv(manager, async () => {
      const error = await restartManager({ terminal: false }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: 'INVALID_INPUT' });
      expect(manager.hits).toEqual([]);
      expect(manager.stopBodies).toEqual([]);
      expect(process.kill(manager.pid, 0)).toBe(true);
      const output = printed(error);
      expect(output.code).toBe(2);
      expect(output.stdout.split('\n')).toHaveLength(1);
      expect(JSON.parse(output.stdout).error.message).toContain('manager restart --yes');
    });
  } finally {
    await manager.close();
  }
});

it('does not stop the manager when restart is refused', async () => {
  const manager = await startManagementDouble({ liveProcess: true });
  try {
    await withManagerEnv(manager, async () => {
      let prompt = '';
      const error = await restartManager({
        terminal: true,
        confirm: async (text) => {
          prompt = text;
          return false;
        },
      }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: 'MANAGER_RESTART_CANCELLED' });
      expect(prompt).toContain(`Running version: ${packageVersion}`);
      expect(prompt).toContain(`Installed version: ${packageVersion}`);
      expect(prompt).toContain(manager.config);
      expect(prompt).toContain('Dashboard: built-in');
      expect(prompt).toContain('demo/api');
      expect(prompt).toContain('demo/once');
      expect(prompt).toContain('op-wait');
      expect(prompt).toContain('Compose containers stay running.');
      expect(prompt).toContain('Only normal autostart runs after replacement.');
      expect(prompt).toContain('Task output and operation IDs do not make tasks safe to replay.');
      expect(prompt).toContain('[y/N]');
      expect(manager.stopBodies).toEqual([]);
      expect(process.kill(manager.pid, 0)).toBe(true);
      expect(printed(error).code).toBe(1);
    });
  } finally {
    await manager.close();
  }
});

it('does not stop when impact changes after consent', async () => {
  const holder: { manager?: ManagementDouble } = {};
  const manager = await startManagementDouble({
    liveProcess: true,
    onRequest(hit) {
      const current = holder.manager;
      if (
        current &&
        hit === 'GET /api/manager/info' &&
        current.hits.filter((item) => item === 'GET /api/manager/info').length > 1
      ) {
        current.info.impact.impactKey = 'impact-b';
      }
    },
  });
  holder.manager = manager;
  try {
    await withManagerEnv(manager, async () => {
      await expect(restartManager({ terminal: false, yes: true })).rejects.toMatchObject({
        code: 'MANAGER_CONFLICT',
      });
      expect(manager.stopBodies).toEqual([]);
      expect(process.kill(manager.pid, 0)).toBe(true);
    });
  } finally {
    await manager.close();
  }
});

it('does not stop when config content changes after consent', async () => {
  const manager = await startManagementDouble({ liveProcess: true });
  try {
    await withManagerEnv(manager, async () => {
      await expect(
        restartManager({
          terminal: true,
          confirm: async () => {
            await writeFile(manager.config, 'version: 1\nprojects: {}\n');
            return true;
          },
        }),
      ).rejects.toMatchObject({ code: 'MANAGER_CONFLICT' });
      expect(manager.stopBodies).toEqual([]);
      expect(process.kill(manager.pid, 0)).toBe(true);
    });
  } finally {
    await manager.close();
  }
});

it('rejects a conflicting config before shutdown', async () => {
  const manager = await startManagementDouble({ liveProcess: true });
  try {
    await withManagerEnv(manager, async () => {
      const other = path.join(manager.folder, 'other.yaml');
      await writeFile(other, 'version: 1\nprojects: {}\n');
      await expect(
        restartManager({ terminal: false, yes: true, explicitConfig: other }),
      ).rejects.toMatchObject({ code: 'MANAGER_CONFLICT' });
      expect(manager.stopBodies).toEqual([]);
    });
  } finally {
    await manager.close();
  }
});

it('returns a config error before shutdown', async () => {
  const manager = await startManagementDouble({ liveProcess: true });
  try {
    await withManagerEnv(manager, async () => {
      await writeFile(manager.config, 'version: 2\n');
      await expect(restartManager({ terminal: false, yes: true })).rejects.toMatchObject({
        code: 'INVALID_CONFIG',
        details: { phase: 'preflight', running: true, command: 'servicemon manager status' },
      });
      expect(manager.stopBodies).toEqual([]);
      expect(process.kill(manager.pid, 0)).toBe(true);
    });
  } finally {
    await manager.close();
  }
});

it('returns a dashboard error before shutdown', async () => {
  const missing = path.join(tmpdir(), `servicemon-missing-${process.pid}.html`);
  const manager = await startManagementDouble({ liveProcess: true, ui: missing });
  try {
    await withManagerEnv(manager, async () => {
      await expect(restartManager({ terminal: false, yes: true })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(manager.stopBodies).toEqual([]);
      expect(process.kill(manager.pid, 0)).toBe(true);
    });
  } finally {
    await manager.close();
  }
});

it('does not force-kill or launch when shutdown exceeds the deadline', async () => {
  // The production wait is 60s. A 1ms deadline uses that same exit path.
  const manager = await startManagementDouble({ liveProcess: true });
  try {
    await withManagerEnv(manager, async () => {
      const error = await restartManager({ terminal: false, yes: true, waitMs: 1 }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        code: 'MANAGER_RESTART_TIMEOUT',
        details: {
          phase: 'shutdown',
          pid: manager.pid,
          startedAt: manager.startedAt,
          running: true,
          command: 'servicemon manager status',
        },
      });
      expect(manager.stopBodies).toEqual([
        { expected: { pid: manager.pid, startedAt: manager.startedAt, impactKey: 'impact-a' } },
      ]);
      expect(process.kill(manager.pid, 0)).toBe(true);
      const record = JSON.parse(
        await readFile(path.join(manager.state, 'instance.json'), 'utf8'),
      ) as {
        pid: number;
      };
      expect(record.pid).toBe(manager.pid);
      expect(printed(error).code).toBe(3);
    });
  } finally {
    await manager.close();
  }
});

it('does not launch when guarded shutdown rejects the impact', async () => {
  const manager = await startManagementDouble({ liveProcess: true, stopResult: 'conflict' });
  try {
    await withManagerEnv(manager, async () => {
      await expect(restartManager({ terminal: false, yes: true })).rejects.toMatchObject({
        code: 'MANAGER_CONFLICT',
      });
      expect(manager.stopBodies).toHaveLength(1);
      expect(process.kill(manager.pid, 0)).toBe(true);
    });
  } finally {
    await manager.close();
  }
});

it('continues one application request when an optional restart is refused', async () => {
  const manager = await startManagementDouble({ version: '0.0.4' });
  try {
    await withManagerEnv(manager, async () => {
      const client = createCommandClient({ terminal: true, confirm: async () => false });
      const result = await client.request<{ accepted: boolean }>('/api/status');
      expect(result.accepted).toBe(true);
      expect(manager.stopBodies).toEqual([]);
      expect(manager.hits.filter((hit) => hit === 'GET /api/status')).toEqual(['GET /api/status']);
    });
  } finally {
    await manager.close();
  }
});

it('does not send an application request when a required restart is refused', async () => {
  const manager = await startManagementDouble({ protocol: 99 });
  try {
    await withManagerEnv(manager, async () => {
      const client = createCommandClient({ terminal: true, confirm: async () => false });
      await expect(client.request('/api/status')).rejects.toMatchObject({
        code: 'MANAGER_VERSION_MISMATCH',
      });
      expect(manager.stopBodies).toEqual([]);
      expect(manager.hits).toContain('GET /api/manager/info');
      expect(manager.hits.filter((hit) => hit !== 'GET /api/manager/info')).toEqual([]);
    });
  } finally {
    await manager.close();
  }
});

it('does not prompt when the selected manager changes before restart', async () => {
  const holder: { manager?: ManagementDouble } = {};
  const manager = await startManagementDouble({
    version: '0.0.7',
    liveProcess: true,
    onRequest(hit) {
      const current = holder.manager;
      if (!current || hit !== 'GET /api/manager/info') {
        return;
      }
      if (current.hits.filter((item) => item === hit).length !== 1) {
        return;
      }
      return writeFile(
        path.join(current.state, 'instance.json'),
        `${JSON.stringify({
          configPath: current.config,
          endpoint: 'http://127.0.0.1:9',
          pid: current.pid + 1,
          startedAt: 'other-start',
          token: 'other-token',
          metadata: {
            version: '0.0.7',
            applicationProtocol: 1,
            launchSettings: { ui: null, port: 9 },
          },
        })}\n`,
      );
    },
  });
  holder.manager = manager;
  try {
    await withManagerEnv(manager, async () => {
      let asked = false;
      const client = createCommandClient({
        terminal: true,
        confirm: async () => {
          asked = true;
          return true;
        },
      });
      await expect(client.request('/api/status')).rejects.toMatchObject({
        code: 'MANAGER_CONFLICT',
      });
      expect(asked).toBe(false);
      expect(manager.stopBodies).toEqual([]);
      expect(process.kill(manager.pid, 0)).toBe(true);
    });
  } finally {
    await manager.close();
  }
});

it('cancels when the saved registration file changes after consent', async () => {
  const manager = await startManagementDouble({ liveProcess: true });
  try {
    await withManagerEnv(manager, async () => {
      const agents = process.env.SERVICEMON_LAUNCH_AGENTS_DIR;
      const label = process.env.SERVICEMON_LAUNCH_AGENT_LABEL;
      if (!agents || !label) {
        throw new Error('Isolated launch agent path is not set.');
      }
      await expect(
        restartManager({
          terminal: true,
          confirm: async () => {
            await writeFile(path.join(agents, `${label}.plist`), '<plist><dict></dict></plist>\n');
            return true;
          },
        }),
      ).rejects.toMatchObject({ code: 'MANAGER_CONFLICT' });
      expect(manager.stopBodies).toEqual([]);
      expect(process.kill(manager.pid, 0)).toBe(true);
    });
  } finally {
    await manager.close();
  }
});
it('reports a dead manager when shutdown leaves the instance record', async () => {
  const holder: { manager?: ManagementDouble } = {};
  const manager = await startManagementDouble({
    liveProcess: true,
    onRequest(hit) {
      if (hit === 'POST /api/manager/stop' && holder.manager) {
        process.kill(holder.manager.pid, 'SIGTERM');
      }
    },
  });
  holder.manager = manager;
  try {
    await withManagerEnv(manager, async () => {
      // The process is signalled by the fixture. The short deadline still uses the production exit path.
      const error = await restartManager({ terminal: false, yes: true, waitMs: 400 }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({
        code: 'MANAGER_RESTART_TIMEOUT',
        details: {
          phase: 'shutdown',
          running: false,
          command: 'servicemon serve --background',
        },
      });
      const record = JSON.parse(
        await readFile(path.join(manager.state, 'instance.json'), 'utf8'),
      ) as {
        pid: number;
      };
      expect(record.pid).toBe(manager.pid);
      expect(() => process.kill(manager.pid, 0)).toThrow();
    });
  } finally {
    await manager.close();
  }
});

it('replaces a detached manager once and preserves its settings', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'servicemon-restart-'));
  const state = path.join(folder, 'state');
  const config = path.join(folder, 'config.yaml');
  const ui = path.join(folder, 'dash.html');
  const marker = path.join(folder, 'marker');
  await mkdir(state, { recursive: true });
  await writeFile(ui, '<!doctype html><title>custom-dashboard</title>');
  await writeFile(
    config,
    stringify({
      version: 1,
      server: { port: 0 },
      projects: {
        demo: {
          directory: folder,
          services: {
            stay: { command: persistentCommand, autostart: true },
            manual: { command: persistentCommand },
          },
          tasks: {
            once: {
              command: shellCommand(`require("fs").appendFileSync(${JSON.stringify(marker)}, "x")`),
            },
          },
        },
      },
    }),
  );
  const label = `com.servicemon.restart.${process.pid}.${path.basename(folder)}`;
  const env = {
    ...process.env,
    SERVICEMON_CONFIG: config,
    SERVICEMON_STATE_DIR: state,
    SERVICEMON_LAUNCH_AGENT_LABEL: label,
    SERVICEMON_LAUNCH_AGENTS_DIR: path.join(folder, 'agents'),
  };
  const cli = async (...args: string[]) => {
    try {
      const result = await exec(process.execPath, [path.resolve('dist/cli/main.js'), ...args], {
        env,
        timeout: 30000,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? 1 };
    }
  };
  try {
    const started = await cli(
      'serve',
      '--background',
      '--port',
      '0',
      '--ui',
      ui,
      '--config',
      config,
    );
    expect(started.code, started.stderr).toBe(0);
    const endpoint = started.stdout.trim();
    const port = new URL(endpoint).port;
    const ran = await cli('run', 'demo/once', '--json');
    expect(ran.code, ran.stdout + ran.stderr).toBe(0);
    expect(await readFile(marker, 'utf8')).toBe('x');
    const manual = await cli('start', 'demo/manual', '--json');
    expect(manual.code, manual.stderr).toBe(0);
    const before = JSON.parse(await readFile(path.join(state, 'instance.json'), 'utf8')) as {
      pid: number;
    };
    const restarted = await cli('manager', 'restart', '--yes', '--json');
    expect(restarted.stderr).not.toContain('[y/N]');
    expect(restarted.stdout.trim().split('\n')).toHaveLength(1);
    const body = JSON.parse(restarted.stdout) as {
      ok: boolean;
      data: {
        previous: { pid: number };
        current: { pid: number; endpoint: string };
        port: number;
        ui: string | null;
        startupRegistration: { registered: boolean };
      };
    };
    expect(restarted.code, restarted.stdout).toBe(0);
    expect(body.ok).toBe(true);
    expect(body.data.previous.pid).toBe(before.pid);
    expect(body.data.current.pid).not.toBe(before.pid);
    expect(String(body.data.port)).toBe(port);
    expect(new URL(body.data.current.endpoint).port).toBe(port);
    expect(body.data.ui).toBe(await realpath(ui));
    expect(body.data.startupRegistration.registered).toBe(false);
    expect(await readFile(marker, 'utf8')).toBe('x');
    const page = await fetch(body.data.current.endpoint);
    expect(await page.text()).toContain('custom-dashboard');
    const status = await cli('status', '--json');
    expect(status.code, status.stdout).toBe(0);
    const entries = JSON.parse(status.stdout).data.entries as { id: string; state: string }[];
    expect(entries.find((entry) => entry.id === 'demo/stay')?.state).toBe('running');
    expect(entries.find((entry) => entry.id === 'demo/manual')?.state).not.toBe('running');
    expect(entries.find((entry) => entry.id === 'demo/once')?.state).not.toBe('running');
  } finally {
    await cli('manager', 'stop');
    await rm(folder, { recursive: true, force: true });
  }
}, 90_000);

it('reports autostart failure and leaves the replacement running', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'servicemon-autostart-'));
  const state = path.join(folder, 'state');
  const config = path.join(folder, 'config.yaml');
  const ui = path.join(folder, 'dash.html');
  await mkdir(state, { recursive: true });
  await writeFile(ui, '<!doctype html><title>autostart</title>');
  await writeFile(
    config,
    stringify({
      version: 1,
      server: { port: 0 },
      projects: {
        demo: {
          directory: folder,
          services: { boot: { command: 'exit 1', autostart: true } },
        },
      },
    }),
  );
  const env = {
    ...process.env,
    SERVICEMON_CONFIG: config,
    SERVICEMON_STATE_DIR: state,
    SERVICEMON_LAUNCH_AGENT_LABEL: `com.servicemon.autostart.${process.pid}.${path.basename(folder)}`,
    SERVICEMON_LAUNCH_AGENTS_DIR: path.join(folder, 'agents'),
  };
  const cli = async (...args: string[]) => {
    try {
      const result = await exec(process.execPath, [path.resolve('dist/cli/main.js'), ...args], {
        env,
        timeout: 30000,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const failed = error as { stdout?: string; stderr?: string; code?: number };
      return { stdout: failed.stdout ?? '', stderr: failed.stderr ?? '', code: failed.code ?? 1 };
    }
  };
  try {
    const started = await cli(
      'serve',
      '--background',
      '--port',
      '0',
      '--ui',
      ui,
      '--config',
      config,
    );
    expect(started.code, started.stderr).toBe(0);
    const restarted = await cli('manager', 'restart', '--yes', '--json');
    expect(restarted.stdout.trim().split('\n')).toHaveLength(1);
    expect(restarted.code).toBe(3);
    const body = JSON.parse(restarted.stdout) as {
      ok: boolean;
      error: { code: string; details: { phase: string; running: boolean; command: string } };
    };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('MANAGER_RESTART_FAILED');
    expect(body.error.details.phase).toBe('autostart');
    expect(body.error.details.running).toBe(true);
    expect(body.error.details.command).toBe('servicemon manager status');
    const status = await cli('manager', 'status', '--json');
    expect(status.code, status.stdout).toBe(0);
    expect(JSON.parse(status.stdout).data.running).toBe(true);
    const info = await fetch(JSON.parse(status.stdout).data.endpoint + '/api/manager/info').then(
      (response) => response.json(),
    );
    expect(info.data.startup.error).toMatchObject({
      code: 'PROCESS_EXITED',
      entryId: 'demo/boot',
      operationId: expect.any(String),
      details: { code: 1 },
    });
    expect(body.error.details).toMatchObject({ cause: info.data.startup.error });
  } finally {
    await cli('manager', 'stop');
    await rm(folder, { recursive: true, force: true });
  }
}, 90_000);

it('reports launch failure without selecting another port when the preserved port is occupied', async () => {
  const manager: ManagementDouble = await startManagementDouble({
    liveProcess: true,
    async onRequest(hit) {
      if (hit === 'POST /api/manager/stop') {
        process.kill(manager.pid, 'SIGTERM');
        await rm(path.join(manager.state, 'instance.json'));
      }
    },
  });
  try {
    await withManagerEnv(manager, async () => {
      const result = await exec(
        process.execPath,
        [path.resolve('dist/cli/main.js'), 'manager', 'restart', '--yes', '--json'],
        { env: process.env, timeout: 30000 },
      ).then(
        (value) => ({ ...value, code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error,
      );
      expect(result.code, result.stdout + result.stderr).toBe(3);
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: {
          code: 'MANAGER_RESTART_FAILED',
          details: { phase: 'startup', running: false },
        },
      });
      await expect(
        readFile(path.join(manager.state, 'instance.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await fetch(manager.endpoint + '/api/manager/info')).status).toBe(200);
      expect(manager.stopBodies).toHaveLength(1);
    });
  } finally {
    await manager.close();
  }
}, 45000);

it.skipIf(process.env.SERVICEMON_SKIP_LAUNCHD === '1')(
  'rejects invalid replacement launcher arguments and restarts after startup is disabled',
  async () => {
    const folder = await mkdtemp(path.join(tmpdir(), 'servicemon-restart-registration-'));
    const config = path.join(folder, 'config.yaml');
    const state = path.join(folder, 'state');
    const label = `test.servicemon.restart.${process.pid}.${path.basename(folder)}`;
    const env = {
      ...process.env,
      SERVICEMON_CONFIG: config,
      SERVICEMON_STATE_DIR: state,
      SERVICEMON_LAUNCH_AGENT_LABEL: label,
      SERVICEMON_LAUNCH_AGENTS_DIR: path.join(folder, 'agents'),
      SERVICEMON_STARTUP_EXECUTABLE: '',
    };
    const cli = async (...args: string[]) =>
      exec(process.execPath, [path.resolve('dist/cli/main.js'), ...args], {
        env,
        timeout: 90000,
      }).then(
        (value) => ({ ...value, code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error,
      );
    try {
      await writeFile(config, stringify({ version: 1, server: { port: 0 }, projects: {} }));
      const enabled = await cli('startup', 'enable', '--json');
      expect(enabled.code, enabled.stdout + enabled.stderr).toBe(0);
      await expect
        .poll(async () => (await cli('manager', 'status', '--json')).code, { timeout: 15000 })
        .toBe(0);
      const before = JSON.parse((await cli('manager', 'status', '--json')).stdout).data;
      env.SERVICEMON_STARTUP_EXECUTABLE = 'relative/path';
      const rejected = await cli('manager', 'restart', '--yes', '--json');
      expect(rejected.code).toBe(2);
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_INPUT', details: { phase: 'preflight', running: true } },
      });
      expect(JSON.parse((await cli('manager', 'status', '--json')).stdout).data.pid).toBe(
        before.pid,
      );
      env.SERVICEMON_STARTUP_EXECUTABLE = '';
      const disabled = await cli('startup', 'disable', '--json');
      expect(disabled.code, disabled.stdout + disabled.stderr).toBe(0);
      let previousPid = before.pid;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const restarted = await cli('manager', 'restart', '--yes', '--json');
        expect(restarted.code, restarted.stdout + restarted.stderr).toBe(0);
        const report = JSON.parse(restarted.stdout).data;
        expect(report.previous.pid).toBe(previousPid);
        expect(report.current.pid).not.toBe(previousPid);
        expect(report.current.endpoint).toBe(before.endpoint);
        expect(report.startupRegistration.registered).toBe(false);
        previousPid = report.current.pid;
      }
      await expect(readFile(path.join(state, 'launch-agent.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(
        readFile(path.join(env.SERVICEMON_LAUNCH_AGENTS_DIR, `${label}.plist`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const disabledJobs = await exec('/bin/launchctl', [
        'print-disabled',
        `gui/${process.getuid!()}`,
      ]);
      expect(disabledJobs.stdout).toContain(`"${label}" => disabled`);
    } finally {
      await cli('manager', 'stop', '--json');
      await cli('startup', 'disable', '--json');
      await exec('/bin/launchctl', ['bootout', `gui/${process.getuid!()}/${label}`]).catch(
        () => {},
      );
      await rm(folder, { recursive: true, force: true });
    }
  },
  120000,
);
