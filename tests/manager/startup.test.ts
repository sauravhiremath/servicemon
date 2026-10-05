import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import {
  disableStartup,
  enableStartup,
  inspectStartupRegistration,
  renewAndStartRegistration,
} from '../../src/manager/launch-agent.js';

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

it('rejects a conflicting registration before it signals or launches', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'servicemon-registration-'));
  const calls = path.join(root, 'calls');
  const env = {
    SERVICEMON_LAUNCH_AGENT_LABEL: `test.servicemon.inspect.${process.pid}`,
    SERVICEMON_LAUNCH_AGENTS_DIR: path.join(root, 'agents'),
    SERVICEMON_LAUNCHCTL: path.join(root, 'launchctl'),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const state = path.join(root, 'state');
  const config = path.join(root, 'config.yaml');
  const plistPath = path.join(
    env.SERVICEMON_LAUNCH_AGENTS_DIR,
    `${env.SERVICEMON_LAUNCH_AGENT_LABEL}.plist`,
  );
  try {
    await mkdir(env.SERVICEMON_LAUNCH_AGENTS_DIR, { recursive: true });
    await writeFile(
      env.SERVICEMON_LAUNCHCTL,
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${calls}'\nif [ "$1" = print ] && [ -f '${root}/loaded' ]; then printf 'pid = 4242\\nstate = running\\n'; exit 0; fi\nif [ "$1" = print ]; then echo 'Could not find service' >&2; fi\nexit 1\n`,
    );
    await chmod(env.SERVICEMON_LAUNCHCTL, 0o700);
    Object.assign(process.env, env);
    await writeFile(
      plistPath,
      `<key>SERVICEMON_CONFIG</key>\n<string>${path.join(root, 'other.yaml')}</string>\n<key>SERVICEMON_STATE_DIR</key>\n<string>${path.join(root, 'other-state')}</string>\n`,
    );
    await mkdir(state, { recursive: true });
    await writeFile(
      path.join(state, 'launch-agent.json'),
      `${JSON.stringify({ label: env.SERVICEMON_LAUNCH_AGENT_LABEL, plistPath })}\n`,
    );
    await expect(inspectStartupRegistration(config, state)).rejects.toMatchObject({
      code: 'MANAGER_CONFLICT',
    });
    expect(await readFile(calls, 'utf8')).toBe(
      'print\ngui/' + process.getuid!() + '/' + env.SERVICEMON_LAUNCH_AGENT_LABEL + '\n',
    );
    await writeFile(path.join(root, 'loaded'), 'loaded');
    await rm(path.join(state, 'launch-agent.json'));
    await rm(calls);
    await expect(inspectStartupRegistration(config, state)).rejects.toMatchObject({
      code: 'MANAGER_CONFLICT',
    });
    expect(await readFile(calls, 'utf8')).not.toContain('bootstrap');
    await rm(calls, { force: true });
    await expect(
      renewAndStartRegistration({ configPath: config, stateDir: state, port: 0, ui: null }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      renewAndStartRegistration({
        configPath: config,
        stateDir: state,
        port: 4311,
        ui: path.join(root, 'missing.html'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(readFile(calls)).rejects.toMatchObject({ code: 'ENOENT' });
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

it.skipIf(process.env.SERVICEMON_SKIP_LAUNCHD === '1')(
  'renews a registered manager through launchd without a second child',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'servicemon-renew-'));
    const selected = `test.servicemon.renew.${process.pid}.${Date.now()}`;
    const domain = `gui/${process.getuid!()}/${selected}`;
    const ui = path.join(root, 'dash', 'index.html');
    const env = {
      SERVICEMON_LAUNCH_AGENT_LABEL: selected,
      SERVICEMON_LAUNCH_AGENTS_DIR: path.join(root, 'agents'),
      SERVICEMON_STARTUP_EXECUTABLE: path.join(root, 'launcher'),
      SERVICEMON_LAUNCHCTL: path.join(root, 'launchctl'),
      SERVICEMON_LOGIN_SHELL: '/bin/from-process',
    };
    const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    const exec = promisify(execFile);
    Object.assign(process.env, env);
    const state = path.join(root, 'state');
    const config = path.join(root, 'config.yaml');
    const previousScript = process.argv[1];
    process.argv[1] = env.SERVICEMON_STARTUP_EXECUTABLE;
    let pid: number | undefined;
    try {
      await mkdir(path.dirname(ui), { recursive: true });
      await writeFile(ui, '<!doctype html><title>renew</title>\n');
      await writeFile(
        env.SERVICEMON_LAUNCHCTL,
        `#!/bin/sh\nif [ "$1" = bootstrap ] && [ -f '${root}/fail' ]; then /bin/rm '${root}/fail'; exit 1; fi\nexec /bin/launchctl "$@"\n`,
      );
      await chmod(env.SERVICEMON_LAUNCHCTL, 0o700);
      await writeFile(
        env.SERVICEMON_STARTUP_EXECUTABLE,
        `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync('${root}/pid',String(process.pid));fs.writeFileSync('${root}/ppid',String(process.ppid));fs.writeFileSync('${root}/argv',JSON.stringify(process.argv));fs.writeFileSync('${root}/shell',process.env.SERVICEMON_LOGIN_SHELL||'');setInterval(()=>{},1000);\n`,
      );
      await chmod(env.SERVICEMON_STARTUP_EXECUTABLE, 0o700);
      const settings = {
        port: 4317,
        ui,
        environmentCapture: { loginShell: '/bin/from-settings', timeoutMs: 3200 },
      };
      const registration = await enableStartup(config, state, settings);
      await expect
        .poll(async () => Number(await readFile(path.join(root, 'pid'), 'utf8')))
        .toBeGreaterThan(0);
      pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
      const plist = await readFile(registration.plistPath, 'utf8');
      expect(plist).toContain('--port');
      expect(plist).toContain('4317');
      expect(plist).toContain(ui);
      expect(plist).toContain('/bin/from-settings');
      expect(plist).not.toContain('/bin/from-process');
      await expect(enableStartup(config, state, settings)).resolves.toEqual(registration);
      expect(Number(await readFile(path.join(root, 'pid'), 'utf8'))).toBe(pid);
      await expect(enableStartup(config, state, { ...settings, port: 4318 })).rejects.toMatchObject(
        {
          code: 'MANAGER_CONFLICT',
        },
      );
      process.kill(pid, 0);
      expect(await readFile(registration.plistPath, 'utf8')).toContain('4317');
      await writeFile(
        path.join(state, 'instance.json'),
        `${JSON.stringify({
          configPath: path.resolve(config),
          endpoint: 'http://127.0.0.1:4317',
          pid,
          startedAt: 'test-start',
          token: 'secret-token',
          metadata: {
            version: '0.1.2',
            applicationProtocol: 1,
            launchSettings: { ui, port: 4317 },
          },
        })}\n`,
      );
      await expect(inspectStartupRegistration(config, state)).resolves.toMatchObject({
        registered: true,
        loaded: true,
        label: selected,
      });
      await expect(
        renewAndStartRegistration({
          configPath: config,
          stateDir: state,
          port: 4317,
          ui,
          environmentCapture: settings.environmentCapture,
        }),
      ).rejects.toMatchObject({ code: 'MANAGER_CONFLICT' });
      process.kill(pid, 0);
      process.kill(pid, 'SIGTERM');
      await expect
        .poll(async () =>
          (await exec('/bin/launchctl', ['print', domain])).stdout.includes(`pid = ${pid}`),
        )
        .toBe(false);
      const renewed = await renewAndStartRegistration({
        configPath: config,
        stateDir: state,
        port: 4317,
        ui,
        environmentCapture: settings.environmentCapture,
      });
      await expect
        .poll(async () => Number(await readFile(path.join(root, 'pid'), 'utf8')))
        .not.toBe(pid);
      pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
      expect(Number(await readFile(path.join(root, 'ppid'), 'utf8'))).not.toBe(process.pid);
      expect(await readFile(path.join(root, 'argv'), 'utf8')).toContain('4317');
      expect(await readFile(path.join(root, 'argv'), 'utf8')).toContain(ui);
      expect(await readFile(path.join(root, 'shell'), 'utf8')).toBe('/bin/from-settings');
      expect(renewed).toEqual(registration);
      process.kill(pid, 'SIGTERM');
      await expect
        .poll(async () =>
          (await exec('/bin/launchctl', ['print', domain])).stdout.includes(`pid = ${pid}`),
        )
        .toBe(false);
      await rm(path.join(root, 'pid'), { force: true });
      await rm(path.join(root, 'argv'), { force: true });
      await writeFile(path.join(root, 'fail'), 'fail');
      await expect(
        renewAndStartRegistration({
          configPath: config,
          stateDir: state,
          port: 4399,
          ui,
          environmentCapture: settings.environmentCapture,
        }),
      ).rejects.toMatchObject({ code: 'TOOL_UNAVAILABLE' });
      const restored = await readFile(registration.plistPath, 'utf8');
      expect(restored).toContain('4317');
      expect(restored).not.toContain('4399');
      await expect
        .poll(async () => {
          try {
            const next = Number(await readFile(path.join(root, 'pid'), 'utf8'));
            process.kill(next, 0);
            return next > 0;
          } catch {
            return false;
          }
        })
        .toBe(true);
      expect(await readFile(path.join(root, 'argv'), 'utf8')).toContain('4317');
      expect(await readFile(path.join(root, 'argv'), 'utf8')).not.toContain('4399');
      pid = Number(await readFile(path.join(root, 'pid'), 'utf8'));
      await disableStartup(state);
      process.kill(pid, 0);
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // The process already exited.
        }
      }
      await exec('/bin/launchctl', ['bootout', domain]).catch(() => undefined);
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
  30000,
);

it('changes the registration snapshot when the plist or launchd identity changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'servicemon-snapshot-'));
  const calls = path.join(root, 'calls');
  const env = {
    SERVICEMON_LAUNCH_AGENT_LABEL: `test.servicemon.snapshot.${process.pid}`,
    SERVICEMON_LAUNCH_AGENTS_DIR: path.join(root, 'agents'),
    SERVICEMON_LAUNCHCTL: path.join(root, 'launchctl'),
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const state = path.join(root, 'state');
  const config = path.join(root, 'config.yaml');
  const plistPath = path.join(
    env.SERVICEMON_LAUNCH_AGENTS_DIR,
    `${env.SERVICEMON_LAUNCH_AGENT_LABEL}.plist`,
  );
  try {
    await mkdir(env.SERVICEMON_LAUNCH_AGENTS_DIR, { recursive: true });
    await mkdir(state, { recursive: true });
    await writeFile(
      env.SERVICEMON_LAUNCHCTL,
      `#!/bin/sh\nprintf '%s\\n' "$@" >> '${calls}'\nif [ "$1" != print ]; then exit 1; fi\nif [ -f '${root}/pid' ]; then printf 'pid = %s\\nstate = running\\ncpu = %s\\n' "$(cat '${root}/pid')" "$(cat '${root}/cpu' 2>/dev/null || echo 0)"; exit 0; fi\necho 'Could not find service' >&2\nexit 1\n`,
    );
    await chmod(env.SERVICEMON_LAUNCHCTL, 0o700);
    Object.assign(process.env, env);
    const absent = await inspectStartupRegistration(config, state);
    const absentAgain = await inspectStartupRegistration(config, state);
    expect(absent).toMatchObject({ registered: false, loaded: false });
    expect(absent.registrationKey).toBe(absentAgain.registrationKey);
    const plist = `<key>SERVICEMON_CONFIG</key>\n<string>${config}</string>\n<key>SERVICEMON_STATE_DIR</key>\n<string>${state}</string>\n<string>serve</string>\n`;
    await writeFile(plistPath, plist);
    await writeFile(
      path.join(state, 'launch-agent.json'),
      `${JSON.stringify({ label: env.SERVICEMON_LAUNCH_AGENT_LABEL, plistPath })}\n`,
    );
    const registered = await inspectStartupRegistration(config, state);
    const registeredAgain = await inspectStartupRegistration(config, state);
    expect(registered).toMatchObject({
      registered: true,
      loaded: false,
      label: env.SERVICEMON_LAUNCH_AGENT_LABEL,
    });
    expect(registered.registrationKey).toBe(registeredAgain.registrationKey);
    expect(registered.registrationKey).not.toBe(absent.registrationKey);
    await writeFile(
      plistPath,
      plist.replace('<string>serve</string>', '<string>serve --port 9</string>'),
    );
    const edited = await inspectStartupRegistration(config, state);
    expect(edited.label).toBe(registered.label);
    expect(edited.registered).toBe(true);
    expect(edited.registrationKey).not.toBe(registered.registrationKey);
    await writeFile(path.join(root, 'pid'), '20');
    await writeFile(path.join(root, 'cpu'), '1');
    await writeFile(
      path.join(state, 'instance.json'),
      `${JSON.stringify({
        configPath: config,
        endpoint: 'http://127.0.0.1:9',
        pid: 20,
        startedAt: 'test-start',
        token: 'secret-token',
        metadata: {
          version: '0.1.2',
          applicationProtocol: 1,
          launchSettings: { ui: null, port: 9 },
        },
      })}\n`,
    );
    const running = await inspectStartupRegistration(config, state);
    await writeFile(path.join(root, 'cpu'), '9');
    const noisy = await inspectStartupRegistration(config, state);
    expect(noisy.registrationKey).toBe(running.registrationKey);
    expect(running.registrationKey).not.toBe(edited.registrationKey);
    await rm(calls, { force: true });
    await writeFile(path.join(root, 'pid'), '21');
    await expect(inspectStartupRegistration(config, state)).rejects.toMatchObject({
      code: 'MANAGER_CONFLICT',
    });
    expect(await readFile(calls, 'utf8')).not.toContain('bootstrap');
    expect(await readFile(calls, 'utf8')).not.toContain('bootout');
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
