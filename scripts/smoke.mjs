import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { stringify } from 'yaml';

const exec = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'servicemon-smoke-'));
const configPath = join(temp, 'config.yaml'),
  state = join(temp, 'state'),
  shell = join(temp, 'login-shell'),
  marker = join(temp, 'environment');
const label = `dev.servicemon.smoke.${process.pid}.${Date.now()}`;
const env = {
  ...process.env,
  SERVICEMON_CONFIG: configPath,
  SERVICEMON_STATE_DIR: state,
  SERVICEMON_LOGIN_SHELL: shell,
  SERVICEMON_LAUNCH_AGENT_LABEL: label,
  SERVICEMON_LAUNCH_AGENTS_DIR: join(temp, 'agents'),
};
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const command = (code) => quote(process.execPath) + ' -e ' + quote(code);
const service = (label) =>
  command(`console.log(${JSON.stringify(label)});setInterval(()=>{},1000)`);
let cli, endpoint;
const invoke = async (...args) => {
  try {
    const result = await exec(cli, args, { env, timeout: 30000 });
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== 'number') {
      throw error;
    }
    return { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
};
const json = async (...args) => {
  const result = await invoke(...args, '--json');
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  return value.data;
};
try {
  await mkdir(join(temp, 'bin'));
  await writeFile(
    join(temp, 'bin', 'servicemon-smoke-tool'),
    '#!/bin/sh\nprintf "tool-from-login-shell\\n"\n',
  );
  await chmod(join(temp, 'bin', 'servicemon-smoke-tool'), 0o700);
  await writeFile(marker, 'first');
  await writeFile(
    shell,
    `#!/bin/sh\nexport PATH=${quote(join(temp, 'bin'))}:"$PATH"\nexport SERVICEMON_SMOKE_VALUE="$(/bin/cat ${quote(marker)})"\nprintf 'shell-noise\\n'\nexec /bin/zsh -f "$@"\n`,
  );
  await chmod(shell, 0o700);
  await exec('npm', ['run', 'build'], { timeout: 120000 });
  const pack = JSON.parse(
    (await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp])).stdout,
  )[0];
  await exec('npm', ['install', '--ignore-scripts', '--prefix', temp, join(temp, pack.filename)], {
    timeout: 120000,
  });
  cli = join(temp, 'node_modules/.bin/servicemon');
  const config = {
    version: 1,
    server: { port: 0 },
    timeouts: { stop_seconds: 1, readiness_seconds: 1 },
    projects: {
      shared: { directory: temp, services: { db: { command: service('database') } } },
      app: {
        directory: temp,
        tasks: {
          setup: {
            command: command('require("fs").appendFileSync("task-runs","x")'),
            depends_on: ['shared/db'],
          },
        },
        services: {
          api: { command: service('api'), depends_on: ['setup'], restart_dependents: true },
          ui: { command: service('ui'), depends_on: ['api'] },
          late: {
            command: service('late'),
            healthcheck: {
              type: 'command',
              command: 'test -f ready',
              interval_seconds: 0.1,
              timeout_seconds: 0.1,
            },
            readiness_seconds: 0.2,
          },
          blocked: { command: service('blocked'), depends_on: ['late'] },
        },
      },
    },
  };
  config.projects.shared.services.db.command = command(
    'const fs=require("fs");const write=()=>{fs.writeFileSync("env-first.tmp",process.env.SERVICEMON_SMOKE_VALUE);fs.renameSync("env-first.tmp","env-first")};write();setInterval(write,50)',
  );
  config.projects.shared.services.db.healthcheck = {
    type: 'command',
    command: 'test -f env-first',
    interval_seconds: 0.1,
    timeout_seconds: 0.1,
  };
  await writeFile(configPath, '# Keep this comment\n' + stringify(config));
  endpoint = (await json('serve', '--background', '--port', '0')).endpoint;
  assert.equal((await json('serve', '--background', '--port', '0')).endpoint, endpoint);
  const root = await fetch(endpoint);
  assert.equal(root.status, 200);
  const html = await root.text();
  assert.match(html, /Servicemon/);
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(new URL(asset, endpoint))).status, 200);
  console.log('PASS installed background CLI serves built dashboard and reuses one manager');
  const foreign = await fetch(endpoint + '/api/config/reload', {
    method: 'POST',
    headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(foreign.status, 403);
  const started = await json('start', 'app/ui');
  assert.deepEqual(
    new Set(started.affected),
    new Set(['shared/db', 'app/setup', 'app/api', 'app/ui']),
  );
  assert.equal(await readFile(join(temp, 'task-runs'), 'utf8'), 'x');
  await json('stop', 'app/ui');
  const before = (await json('status')).entries;
  const oldApi = before.find((e) => e.id === 'app/api').runId;
  await json('restart', 'app/api');
  let entries = (await json('status')).entries;
  assert.equal(entries.find((e) => e.id === 'app/ui').state, 'stopped');
  assert.notEqual(entries.find((e) => e.id === 'app/api').runId, oldApi);
  assert.equal(await readFile(join(temp, 'task-runs'), 'utf8'), 'x');
  console.log(
    'PASS cross-project dependency order, task reuse, and stopped recursive restart targets',
  );
  const accepted = await json('start', 'app/blocked', '--no-wait');
  let operation;
  const deadline = Date.now() + 5000;
  do {
    operation = await json('operation', accepted.operationId);
    if (!['pending', 'running'].includes(operation.state)) {
      break;
    }
    await delay(25);
  } while (Date.now() < deadline);
  assert.equal(operation.state, 'failed');
  assert.equal(operation.error.code, 'READINESS_TIMEOUT');
  entries = (await json('status')).entries;
  assert.equal(entries.find((e) => e.id === 'app/late').state, 'running');
  assert.equal(entries.find((e) => e.id === 'app/blocked').state, 'stopped');
  await writeFile(join(temp, 'ready'), '');
  await delay(250);
  assert.equal((await json('status')).entries.find((e) => e.id === 'app/blocked').state, 'stopped');
  console.log(
    'PASS no-wait operation completes with timeout without stopping its process or starting its dependent',
  );
  const logs = await invoke('logs', 'app/api', '--json');
  assert.equal(logs.code, 0);
  assert.ok(
    logs.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .some((record) => record.stream === 'stdout' && record.text.includes('api')),
  );
  await writeFile(marker, 'second');
  await writeFile(configPath, 'version: [invalid');
  const invalid = await invoke('reload', '--json');
  assert.equal(invalid.code, 2);
  assert.ok((await json('status')).reloadError);
  config.projects.app.services.api.command = service('replacement');
  await writeFile(configPath, '# Keep this comment\n' + stringify(config));
  const applied = await json('reload');
  assert.deepEqual(applied.affected, ['app/api']);
  entries = (await json('status')).entries;
  assert.equal(entries.find((e) => e.id === 'app/api').state, 'stopped');
  assert.equal(entries.find((e) => e.id === 'shared/db').state, 'running');
  await json(
    'service',
    'add',
    'app/added',
    '--command',
    service('added'),
    '--notes',
    'Smoke definition',
  );
  assert.match(await readFile(configPath, 'utf8'), /# Keep this comment/);
  assert.ok((await json('service', 'list')).some((entry) => entry.id === 'app/added'));
  await json('service', 'remove', 'app/added');
  console.log(
    'PASS retained NDJSON output, invalid reload preservation, stop-and-apply, and online YAML edits',
  );
  await json(
    'task',
    'add',
    'app/environment',
    '--command',
    command('require("fs").writeFileSync("env-second",process.env.SERVICEMON_SMOKE_VALUE)'),
  );
  await json('run', 'app/environment');
  await delay(100);
  assert.equal(await readFile(join(temp, 'env-first'), 'utf8'), 'first');
  assert.equal(await readFile(join(temp, 'env-second'), 'utf8'), 'second');
  await json('task', 'remove', 'app/environment');
  console.log('PASS refreshed login environment applies only to new runs');
  await json('manager', 'stop');
  for (let n = 0; n < 100; n++) {
    const status = await invoke('manager', 'status', '--json');
    if (status.code === 3) {
      break;
    }
    await delay(50);
    if (n === 99) {
      throw new Error('Manager did not stop');
    }
  }
  await json('service', 'add', 'app/offline', '--command', service('offline'));
  await json('config', 'validate');
  await json('service', 'remove', 'app/offline');
  const custom = join(temp, 'custom');
  await mkdir(custom);
  await writeFile(
    join(custom, 'index.html'),
    '<html><body>Custom root<script src="local.js"></script></body></html>',
  );
  await writeFile(join(custom, 'local.js'), 'console.log("custom");');
  await writeFile(join(temp, 'private.txt'), 'outside-root');
  await symlink(join(temp, 'private.txt'), join(custom, 'escape.txt'));
  endpoint = (
    await json('serve', '--background', '--port', '0', '--ui', join(custom, 'index.html'))
  ).endpoint;
  assert.match(await (await fetch(endpoint)).text(), /Custom root/);
  assert.equal((await fetch(endpoint + '/local.js')).status, 200);
  assert.equal((await fetch(endpoint + '/escape.txt')).status, 404);
  assert.equal((await fetch(endpoint + '/%2e%2e%2fprivate.txt')).status, 404);
  const retained = await invoke('logs', 'app/api', '--json');
  assert.equal(retained.code, 0);
  assert.ok(retained.stdout.includes('api'));
  assert.equal((await json('status')).entries.find((e) => e.id === 'app/setup').state, 'idle');
  console.log(
    'PASS offline definition edits, custom asset boundaries, retained logs, and session task reset',
  );
  await json('manager', 'stop');
  for (let n = 0; n < 100; n++) {
    if ((await invoke('manager', 'status', '--json')).code === 3) {
      break;
    }
    await delay(50);
    if (n === 99) {
      throw new Error('Manager did not stop before startup check');
    }
  }
  if (process.env.SERVICEMON_SKIP_LAUNCHD === '1') {
    console.log(
      'SKIP launchd: SERVICEMON_SKIP_LAUNCHD=1; this scenario requires a macOS GUI login session',
    );
  } else {
    await writeFile(
      configPath,
      stringify({
        version: 1,
        server: { port: 0 },
        projects: {
          login: {
            directory: temp,
            tasks: { probe: { command: 'servicemon-smoke-tool > launch-tool', autostart: true } },
          },
        },
      }),
    );
    await json('startup', 'enable');
    for (let n = 0; n < 200; n++) {
      const result = await invoke('manager', 'status', '--json');
      if (result.code === 0) {
        break;
      }
      await delay(50);
      if (n === 199) {
        throw new Error('LaunchAgent manager did not start');
      }
    }
    for (let n = 0; n < 200; n++) {
      try {
        assert.equal(await readFile(join(temp, 'launch-tool'), 'utf8'), 'tool-from-login-shell\n');
        break;
      } catch (error) {
        if (n === 199) {
          throw error;
        }
        await delay(50);
      }
    }
    await json('manager', 'stop');
    await delay(1500);
    assert.equal((await invoke('manager', 'status', '--json')).code, 3);
    await json('startup', 'disable');
    console.log(
      'PASS isolated LaunchAgent captures login tool paths and manager Stop does not restart it',
    );
  }
} finally {
  if (cli) {
    try {
      await invoke('manager', 'stop', '--json');
    } catch {}
  }
  if (cli && process.env.SERVICEMON_SKIP_LAUNCHD !== '1') {
    try {
      await invoke('startup', 'disable', '--json');
    } catch {}
  }
  for (let n = 0; n < 100; n++) {
    try {
      await readFile(join(state, 'instance.json'));
      await delay(50);
    } catch {
      break;
    }
  }
  await rm(temp, { recursive: true, force: true });
}
