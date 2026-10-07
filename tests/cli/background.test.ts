import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startBackground } from '../../src/cli/background.js';
import { processIdentity } from '../../src/config/process-identity.js';
import { applicationProtocol, packageVersion } from '../../src/shared/build-info.js';
import { exitCode } from '../../src/shared/errors.js';

// The replacement process waits before publishing. The parent must observe the
// dead record first; a fake timer in this file cannot drive that process.
const publisher = `import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
await delay(250);
const startedAt = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
const config = process.argv[process.argv.indexOf('--config') + 1];
await writeFile(process.env.SERVICEMON_STATE_DIR + '/instance.json', JSON.stringify({
  configPath: config, endpoint: 'http://127.0.0.1:4242', pid: process.pid, startedAt, token: 'new',
  metadata: { version: ${JSON.stringify(packageVersion)}, applicationProtocol: ${applicationProtocol}, launchSettings: { ui: null, port: 4242 } },
}));
setInterval(() => {}, 1000);
`;

async function fixture(): Promise<{ directory: string; state: string; config: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), 'servicemon-bg-'));
  const state = path.join(directory, 'state');
  await mkdir(state, { recursive: true });
  const config = path.join(directory, 'config.yaml');
  await writeFile(config, 'version: 1\n');
  return { directory, state, config };
}

it('does not report a dead manager endpoint while the replacement is still starting', async () => {
  const { directory, state, config } = await fixture();
  const command = path.join(directory, 'publish.mjs');
  let pid: number | undefined;
  try {
    await writeFile(command, publisher);
    await writeFile(
      path.join(state, 'instance.json'),
      JSON.stringify({
        configPath: config,
        endpoint: 'http://127.0.0.1:9',
        pid: 2_147_483_646,
        startedAt: 'dead',
        token: 'old',
        metadata: {
          version: packageVersion,
          applicationProtocol,
          launchSettings: { ui: null, port: 9 },
        },
      }),
    );
    await expect(startBackground({ config, state }, command)).resolves.toBe(
      'http://127.0.0.1:4242',
    );
    const parsed: unknown = JSON.parse(await readFile(path.join(state, 'instance.json'), 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('pid' in parsed) ||
      typeof parsed.pid !== 'number'
    ) {
      throw new Error('Replacement did not publish a pid.');
    }
    pid = parsed.pid;
  } finally {
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps the child config error instead of calling every startup failure unavailable', async () => {
  const { directory, state, config } = await fixture();
  const command = path.join(directory, 'fail.mjs');
  try {
    await writeFile(
      command,
      "console.error('CONFIG_NOT_FOUND: Config not found: /missing.yaml');\nprocess.exit(2);\n",
    );
    const error = await startBackground({ config, state }, command).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'CONFIG_NOT_FOUND' ||
      !('message' in error) ||
      typeof error.message !== 'string'
    ) {
      throw error;
    }
    expect(error.message).toBe('Config not found: /missing.yaml');
    expect(exitCode(error.code)).toBe(2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('reuses a live manager and does not signal a manager for another config', async () => {
  const { directory, state, config } = await fixture();
  const command = path.join(directory, 'exit.mjs');
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  try {
    const identity = await processIdentity(sleeper.pid ?? 0);
    if (identity.state !== 'alive' || sleeper.pid === undefined) {
      throw new Error('Sleeper did not stay alive.');
    }
    await writeFile(command, 'process.exit(0);\n');
    await writeFile(
      path.join(state, 'instance.json'),
      JSON.stringify({
        configPath: config,
        endpoint: 'http://127.0.0.1:7331',
        pid: sleeper.pid,
        startedAt: identity.startedAt,
        token: 'live',
        metadata: {
          version: packageVersion,
          applicationProtocol,
          launchSettings: { ui: null, port: 7331 },
        },
      }),
    );
    await expect(startBackground({ config, state }, command)).resolves.toBe(
      'http://127.0.0.1:7331',
    );
    await expect(
      startBackground({ config: path.join(directory, 'other.yaml'), state }, command),
    ).rejects.toMatchObject({ code: 'MANAGER_CONFLICT' });
    await expect(
      startBackground(
        { config, state, replace: { pid: 2_147_483_646, startedAt: 'old-manager' } },
        command,
      ),
    ).rejects.toMatchObject({ code: 'MANAGER_CONFLICT' });
    expect(process.kill(sleeper.pid, 0)).toBe(true);
  } finally {
    sleeper.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not report the previous manager endpoint as replacement success', async () => {
  const { directory, state, config } = await fixture();
  const command = path.join(directory, 'publish.mjs');
  const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  let replacement: number | undefined;
  try {
    const identity = await processIdentity(sleeper.pid ?? 0);
    if (identity.state !== 'alive' || sleeper.pid === undefined) {
      throw new Error('Sleeper did not stay alive.');
    }
    await writeFile(command, publisher);
    await writeFile(
      path.join(state, 'instance.json'),
      JSON.stringify({
        configPath: config,
        endpoint: 'http://127.0.0.1:7331',
        pid: sleeper.pid,
        startedAt: identity.startedAt,
        token: 'old',
        metadata: {
          version: packageVersion,
          applicationProtocol,
          launchSettings: { ui: null, port: 7331 },
        },
      }),
    );
    await expect(
      startBackground(
        { config, state, replace: { pid: sleeper.pid, startedAt: identity.startedAt } },
        command,
      ),
    ).resolves.toBe('http://127.0.0.1:4242');
    const parsed: unknown = JSON.parse(await readFile(path.join(state, 'instance.json'), 'utf8'));
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('pid' in parsed) ||
      typeof parsed.pid !== 'number'
    ) {
      throw new Error('Replacement did not publish a pid.');
    }
    replacement = parsed.pid;
    expect(replacement).not.toBe(sleeper.pid);
    expect(process.kill(sleeper.pid, 0)).toBe(true);
  } finally {
    if (replacement !== undefined) {
      try {
        process.kill(replacement, 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
    sleeper.kill('SIGTERM');
    await rm(directory, { recursive: true, force: true });
  }
});
