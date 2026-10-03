import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { disableStartup, enableStartup } from '../../src/manager/launch-agent.js';

it.skipIf(process.env.SERVICEMON_SKIP_LAUNCHD === '1')(
  'preserves a live registration on repeat enable and requires stop before replacement',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'servicemon-launch-'));
    const selected = `test.servicemon.${process.pid}.${Date.now()}`;
    const domain = `gui/${process.getuid!()}/${selected}`;
    const env = {
      SERVICEMON_LAUNCH_AGENT_LABEL: selected,
      SERVICEMON_LAUNCH_AGENTS_DIR: path.join(root, 'agents'),
      SERVICEMON_STARTUP_EXECUTABLE: path.join(root, 'launcher'),
      SERVICEMON_LAUNCHCTL: path.join(root, 'launchctl'),
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    const exec = promisify(execFile);
    Object.assign(process.env, env);
    const state = path.join(root, 'state');
    const config = path.join(root, 'config.yaml');
    let pid: number | undefined;
    const previousScript = process.argv[1];
    process.argv[1] = env.SERVICEMON_STARTUP_EXECUTABLE;
    try {
      await writeFile(
        env.SERVICEMON_LAUNCHCTL,
        `#!/bin/sh\nif [ "$1" = bootstrap ] && [ -f '${root}/fail' ]; then /bin/rm '${root}/fail'; exit 1; fi\nexec /bin/launchctl "$@"\n`,
      );
      await chmod(env.SERVICEMON_LAUNCHCTL, 0o700);
      // A real launchd job must stay alive outside the test runner's clock.
      await writeFile(
        env.SERVICEMON_STARTUP_EXECUTABLE,
        `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync('${root}/config',process.env.SERVICEMON_CONFIG);fs.writeFileSync('${root}/pid',String(process.pid));setInterval(()=>{},1000);\n`,
      );
      await chmod(env.SERVICEMON_STARTUP_EXECUTABLE, 0o700);
      const registration = await enableStartup(config, state);
      await expect
        .poll(async () => {
          try {
            pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
            return pid > 0;
          } catch {
            return false;
          }
        })
        .toBe(true);
      await expect(enableStartup(config, state)).resolves.toEqual(registration);
      process.kill(pid!, 0);
      await expect(enableStartup(path.join(root, 'changed.yaml'), state)).rejects.toMatchObject({
        code: 'MANAGER_CONFLICT',
      });
      process.kill(pid!, 0);
      await disableStartup(state);
      process.kill(pid!, 0);
      process.kill(pid!, 'SIGTERM');
      await expect
        .poll(async () =>
          (await exec('/bin/launchctl', ['print', domain])).stdout.includes(`pid = ${pid}`),
        )
        .toBe(false);
      await enableStartup(config, state);
      await expect
        .poll(async () => Number(await readFile(path.join(root, 'pid'), 'utf8')))
        .not.toBe(pid);
      pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
      process.kill(pid, 'SIGTERM');
      await expect
        .poll(async () =>
          (await exec('/bin/launchctl', ['print', domain])).stdout.includes(`pid = ${pid}`),
        )
        .toBe(false);
      await enableStartup(config, state);
      await expect
        .poll(async () => Number(await readFile(path.join(root, 'pid'), 'utf8')))
        .not.toBe(pid);
      pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
      process.kill(pid, 'SIGTERM');
      await expect
        .poll(async () =>
          (await exec('/bin/launchctl', ['print', domain])).stdout.includes(`pid = ${pid}`),
        )
        .toBe(false);
      await writeFile(path.join(root, 'fail'), 'fail next bootstrap');
      await expect(enableStartup(path.join(root, 'changed.yaml'), state)).rejects.toMatchObject({
        code: 'TOOL_UNAVAILABLE',
      });
      await expect
        .poll(async () => Number(await readFile(path.join(root, 'pid'), 'utf8')))
        .not.toBe(pid);
      expect(await readFile(path.join(root, 'config'), 'utf8')).toBe(config);
      await expect(enableStartup(config, state)).resolves.toEqual(registration);
      pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
      process.kill(pid, 'SIGTERM');
      await expect
        .poll(async () =>
          (await exec('/bin/launchctl', ['print', domain])).stdout.includes(`pid = ${pid}`),
        )
        .toBe(false);
      await disableStartup(state);
      await enableStartup(config, state);
      await expect
        .poll(async () => Number(await readFile(path.join(root, 'pid'), 'utf8')))
        .not.toBe(pid);
    } finally {
      await exec('/bin/launchctl', ['bootout', domain]).catch(() => {});
      process.argv[1] = previousScript;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  20000,
);

it('removes a failed first registration without claiming success', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'servicemon-launch-fail-'));
  const env = {
    SERVICEMON_LAUNCH_AGENT_LABEL: `test.servicemon.fail.${process.pid}`,
    SERVICEMON_LAUNCH_AGENTS_DIR: path.join(root, 'agents'),
    SERVICEMON_LAUNCHCTL: path.join(root, 'launchctl'),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  try {
    await writeFile(
      env.SERVICEMON_LAUNCHCTL,
      '#!/bin/sh\nif [ "$1" = print ]; then echo "Could not find service" >&2; fi\nexit 1\n',
    );
    await chmod(env.SERVICEMON_LAUNCHCTL, 0o700);
    Object.assign(process.env, env);
    await expect(
      enableStartup(path.join(root, 'config.yaml'), path.join(root, 'state')),
    ).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' });
    await expect(
      readFile(path.join(root, 'agents', env.SERVICEMON_LAUNCH_AGENT_LABEL + '.plist')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(path.join(root, 'state', 'launch-agent.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
