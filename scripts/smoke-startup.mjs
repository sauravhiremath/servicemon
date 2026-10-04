import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'servicemon-upgrade-'));
const label = `test.servicemon.upgrade.${process.pid}.${Date.now()}`;
const state = path.join(root, 'state'),
  config = path.join(root, 'config.yaml');
const opt = path.join(root, 'opt'),
  cli = path.join(opt, 'servicemon/bin/servicemon');
const env = {
  ...process.env,
  SERVICEMON_CONFIG: config,
  SERVICEMON_STATE_DIR: state,
  SERVICEMON_LAUNCH_AGENT_LABEL: label,
  SERVICEMON_LAUNCH_AGENTS_DIR: path.join(root, 'agents'),
};
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
async function json(...args) {
  return JSON.parse((await exec(cli, [...args, '--json'], { env, timeout: 30000 })).stdout).data;
}
async function until(check) {
  for (let n = 0; n < 200; n++) {
    if (await check()) {
      return;
    }
    await delay(50);
  }
  throw new Error('Startup fixture condition timed out.');
}
async function stop() {
  await json('manager', 'stop');
  await until(async () => {
    try {
      await readFile(path.join(state, 'instance.json'));
      return false;
    } catch (error) {
      if (error.code === 'ENOENT') {
        return true;
      }
      throw error;
    }
  });
  await until(async () => {
    const { stdout } = await exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]);
    return !/^\s*(?:pid = \d+|state = running)\s*$/m.test(stdout);
  });
}
try {
  await exec('npm', ['run', 'build'], { timeout: 120000 });
  await mkdir(opt);
  await mkdir(path.join(root, 'unrelated'));
  await writeFile(path.join(root, 'unrelated/node'), '#!/bin/sh\necho wrong-node >&2\nexit 99\n');
  await chmod(path.join(root, 'unrelated/node'), 0o755);
  env.PATH = path.join(root, 'unrelated') + ':' + process.env.PATH;
  for (const version of ['one', 'two']) {
    const app = path.join(root, version, 'app'),
      runtime = path.join(root, version, 'runtime');
    await mkdir(path.join(app, 'bin'), { recursive: true });
    await mkdir(path.join(runtime, 'bin'), { recursive: true });
    await cp('dist', path.join(app, 'dist'), { recursive: true });
    await copyFile('package.json', path.join(app, 'package.json'));
    await symlink(path.resolve('node_modules'), path.join(app, 'node_modules'));
    await symlink(process.execPath, path.join(runtime, 'bin/node'));
    await writeFile(
      path.join(app, 'bin/servicemon'),
      `#!/bin/sh\nexport SERVICEMON_STARTUP_EXECUTABLE=${quote(cli)}\nexec ${quote(path.join(opt, 'node/bin/node'))} ${quote(path.join(opt, 'servicemon/dist/cli/main.js'))} "$@"\n`,
    );
    await chmod(path.join(app, 'bin/servicemon'), 0o755);
  }
  await symlink(path.join(root, 'one/app'), path.join(opt, 'servicemon'));
  await symlink(path.join(root, 'one/runtime'), path.join(opt, 'node'));
  const definition = {
    version: 1,
    server: { port: 0 },
    projects: {
      login: {
        directory: root,
        tasks: { probe: { command: 'echo retained-log; printf first > result', autostart: true } },
      },
    },
  };
  await writeFile(config, JSON.stringify(definition));
  await json('startup', 'enable');
  await until(async () => {
    try {
      return (await readFile(path.join(root, 'result'), 'utf8')) === 'first';
    } catch {
      return false;
    }
  });
  const first = await json('manager', 'status');
  await json('startup', 'enable');
  assert.equal((await json('manager', 'status')).pid, first.pid);
  await json('startup', 'disable');
  assert.equal((await json('manager', 'status')).pid, first.pid);
  await stop();
  await json('startup', 'enable');
  await until(async () => {
    try {
      return (await json('manager', 'status')).running;
    } catch {
      return false;
    }
  });
  await stop();
  await rm(path.join(opt, 'servicemon'));
  await rm(path.join(opt, 'node'));
  await symlink(path.join(root, 'two/app'), path.join(opt, 'servicemon'));
  await symlink(path.join(root, 'two/runtime'), path.join(opt, 'node'));
  await rm(path.join(root, 'one'), { recursive: true });
  definition.projects.login.tasks.probe.command = 'echo upgraded-log; printf second > result';
  await writeFile(config, JSON.stringify(definition));
  await exec('/bin/launchctl', ['kickstart', `gui/${process.getuid()}/${label}`]);
  await until(async () => (await readFile(path.join(root, 'result'), 'utf8')) === 'second');
  assert.notEqual((await json('manager', 'status')).pid, first.pid);
  const logs = (await exec(cli, ['logs', 'login/probe', '--json'], { env })).stdout;
  assert.match(logs, /retained-log/);
  assert.match(logs, /upgraded-log/);
  await json('startup', 'disable');
  await stop();
  const retained = await readFile(config, 'utf8');
  await rm(path.join(root, 'two'), { recursive: true });
  assert.equal(await readFile(config, 'utf8'), retained);
  await readFile(path.join(root, 'result'));
  console.log(
    'PASS real launchd: repeat enable, non-stopping disable, same-session renewal, stable launcher after both old targets are removed, retained logs/config',
  );
} finally {
  await exec('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
