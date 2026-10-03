import { execFile } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { captureEnvironment } from '../../src/manager/environment.js';

const exec = promisify(execFile);
const previous = {
  shell: process.env.SERVICEMON_LOGIN_SHELL,
  timeout: process.env.SERVICEMON_ENV_CAPTURE_TIMEOUT_MS,
};

afterEach(() => {
  if (previous.shell === undefined) delete process.env.SERVICEMON_LOGIN_SHELL;
  else process.env.SERVICEMON_LOGIN_SHELL = previous.shell;
  if (previous.timeout === undefined) delete process.env.SERVICEMON_ENV_CAPTURE_TIMEOUT_MS;
  else process.env.SERVICEMON_ENV_CAPTURE_TIMEOUT_MS = previous.timeout;
});

async function shell(name: string, body: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'servicemon-shell-'));
  const file = path.join(root, name);
  await writeFile(file, body);
  await chmod(file, 0o755);
  return file;
}

describe('captureEnvironment', () => {
  it('reads exported variables from a separate channel and ignores startup text', async () => {
    process.env.SERVICEMON_LOGIN_SHELL = await shell('login', `#!/bin/sh
echo STARTUP-BANNER
export FROM_LOGIN_SHELL=captured-value
prev=
cmd=
for arg in "$@"; do
  if [ "$prev" = "-c" ]; then
    cmd=$arg
  fi
  prev=$arg
done
eval "$cmd"
`);
    const env = await captureEnvironment();
    expect(env.FROM_LOGIN_SHELL).toBe('captured-value');
    expect(Object.values(env).join('\n')).not.toContain('STARTUP-BANNER');
  });

  it('reports shell failure and timeout instead of returning the parent environment', async () => {
    process.env.SERVICEMON_LOGIN_SHELL = await shell('fail', '#!/bin/sh\necho broken >&2\nexit 7\n');
    await expect(captureEnvironment()).rejects.toMatchObject({ code: 'ENVIRONMENT_CAPTURE_FAILED' });
    const root = await mkdtemp(path.join(tmpdir(), 'servicemon-timeout-'));
    const pidFile = path.join(root, 'pid');
    process.env.SERVICEMON_LOGIN_SHELL = await shell('sleep', `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nsleep 30\n`);
    process.env.SERVICEMON_ENV_CAPTURE_TIMEOUT_MS = '2000';
    await expect(captureEnvironment()).rejects.toMatchObject({ code: 'ENVIRONMENT_CAPTURE_FAILED' });
    const pid = Number((await exec('/bin/cat', [pidFile])).stdout.trim());
    await expect(exec('/bin/ps', ['-p', String(pid), '-o', 'pid='])).rejects.toThrow();
  });
});
