import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const cli = path.resolve(process.argv[2]);
const root = await mkdtemp(path.join(tmpdir(), 'servicemon-installed-'));
const state = path.join(root, 'state');
const config = path.join(root, 'config.yaml');
const env = { ...process.env, SERVICEMON_CONFIG: config, SERVICEMON_STATE_DIR: state };
const exec = promisify(execFile);
async function json(...args) {
  const result = JSON.parse((await exec(cli, [...args, '--json'], { env, timeout: 20000 })).stdout);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return result.data;
}
const definition = {
  version: 1,
  server: { port: 0 },
  timeouts: { stop_seconds: 1 },
  projects: {
    demo: {
      directory: root,
      services: { worker: { command: 'echo service-marker; exec sleep 600' } },
      tasks: { probe: { command: 'echo task-marker; printf completed > result' } },
    },
  },
};
const failures = [];
try {
  await writeFile(config, JSON.stringify(definition));
  await json('config', 'validate');
  const { endpoint } = await json('serve', '--background', '--port', '0');
  const response = await fetch(endpoint);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Servicemon/);
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(new URL(asset, endpoint))).status, 200);
  assert.equal(
    (await fetch(endpoint + '/api/status', { headers: { Origin: 'https://foreign.example' } }))
      .status,
    403,
  );
  const cliVersion = (await exec(cli, ['--version'], { env, timeout: 20000 })).stdout.trim();
  let info;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const infoResponse = await fetch(endpoint + '/api/manager/info');
    assert.equal(infoResponse.status, 200);
    const body = await infoResponse.json();
    assert.equal(body.ok, true, JSON.stringify(body.error));
    info = body.data;
    if (info.startup.state !== 'running') {
      break;
    }
    await delay(50);
  }
  assert.equal(info.startup.state, 'succeeded', JSON.stringify(info.startup));
  assert.equal(info.managementVersion, 2);
  assert.deepEqual(info.impact.operations, []);
  assert.equal(info.version, cliVersion);
  assert.equal(Number.isInteger(info.applicationProtocol), true);
  assert.equal(info.endpoint, endpoint);
  assert.equal(info.launchSettings.port, Number(new URL(endpoint).port));
  assert.equal(info.launchSettings.ui, null);
  assert.equal(typeof info.pid, 'number');
  assert.equal(typeof info.startedAt, 'string');
  assert.equal(typeof info.impact?.impactKey, 'string');
  assert.equal(info.impact.impactKey.length > 0, true);
  const manager = await json('manager', 'status');
  assert.equal(manager.running, true);
  assert.equal(manager.cliVersion, cliVersion);
  assert.equal(manager.managerVersion, cliVersion);
  assert.equal(manager.applicationProtocol, info.applicationProtocol);
  assert.equal(manager.compatible, true);
  assert.equal(manager.restartRequired, false);
  assert.equal(manager.pid, info.pid);
  assert.equal(manager.endpoint, endpoint);
  assert.equal(manager.configPath, config);
  await json('start', 'demo/worker');
  assert.equal((await json('status', 'demo/worker')).entries[0].state, 'running');
  await json('run', 'demo/probe');
  assert.equal(await readFile(path.join(root, 'result'), 'utf8'), 'completed');
  assert.match((await exec(cli, ['logs', 'demo/probe', '--json'], { env })).stdout, /task-marker/);
  definition.projects.demo.services.worker.command = 'echo replacement-marker; exec sleep 600';
  await writeFile(config, JSON.stringify(definition));
  await json('reload');
  assert.equal((await json('status', 'demo/worker')).entries[0].state, 'stopped');
  await json('start', 'demo/worker');
  await json('stop', 'demo/worker');
  assert.equal((await json('status', 'demo/worker')).entries[0].state, 'stopped');
  console.log(
    'PASS installed CLI: validate, plain dashboard/assets, foreign-origin denial, manager build information, service, task, logs, reload, stop',
  );
} catch (error) {
  failures.push(error);
}
try {
  try {
    await json('manager', 'stop');
  } catch (error) {
    if (!String(error.stdout).includes('MANAGER_UNAVAILABLE')) {
      throw error;
    }
  }
  for (let n = 0; n < 100; n++) {
    try {
      await readFile(path.join(state, 'instance.json'));
    } catch (error) {
      if (error.code === 'ENOENT') {
        break;
      }
      throw error;
    }
    if (n === 99) {
      throw new Error('Fixture manager did not stop');
    }
    await delay(50);
  }
} catch (error) {
  failures.push(error);
}
try {
  await rm(root, { recursive: true, force: true });
} catch (error) {
  failures.push(error);
}
if (failures.length) {
  throw new AggregateError(failures, 'Installed CLI smoke check failed');
}
