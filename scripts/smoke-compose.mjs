import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const exec = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), 'servicemon-compose-smoke-'));
const project = `smcsmoke${Date.now().toString(36)}`;
const directory = join(temp, 'fixture');
const file = join(directory, 'compose.yaml');
const config = join(temp, 'config.yaml');
const state = join(temp, 'state');
const env = { ...process.env, SERVICEMON_CONFIG: config, SERVICEMON_STATE_DIR: state };
let cli;
let follower;
let followError = '';
const docker = (...args) => exec('docker', args, { cwd: directory });
const compose = (...args) => docker('compose', '--project-name', project, '--project-directory', directory, '--file', file, ...args);
const invoke = (...args) => exec(cli, [...args, '--json'], { env });
const json = async (...args) => {
  const result = JSON.parse((await invoke(...args)).stdout);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.data;
};
const waitFor = async (check) => {
  for (let n = 0; n < 160; n++) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Compose fixture condition did not become true; follower exit=${follower?.exitCode}; ${followError}`);
};
try {
  await mkdir(directory, { recursive: true });
  await writeFile(file, `services:
  db:
    image: ubuntu:24.04
    command: ["sleep", "600"]
    healthcheck:
      test: ["CMD", "true"]
      interval: 1s
      timeout: 1s
      retries: 5
    volumes:
      - data:/var/lib/data
  app:
    image: ubuntu:24.04
    command: ["sh", "-c", "echo compose-log-marker; sleep 600"]
    depends_on:
      db:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "true"]
      interval: 1s
      timeout: 1s
      retries: 5
volumes:
  data:
`);
  await writeFile(config, `version: 1
server:
  port: 0
projects:
  demo:
    directory: ${JSON.stringify(directory)}
    compose_groups:
      infra:
        file: compose.yaml
        project_name: ${project}
`);
  await exec('npm', ['run', 'build']);
  const packed = await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', temp, '--json']);
  await exec('npm', ['install', '--ignore-scripts', '--prefix', join(temp, 'install'), '--no-audit', '--no-fund', join(temp, JSON.parse(packed.stdout)[0].filename)]);
  cli = join(temp, 'install/node_modules/.bin/servicemon');
  await compose('up', '--detach', 'db');
  await json('serve', '--background');
  await waitFor(async () => (await json('status', 'demo/infra.db')).entries[0].state === 'running');
  await json('start', '--compose', 'demo/infra');
  const initial = (await json('status')).entries;
  assert.equal(initial.length, 2);
  assert.equal(initial.find(entry => entry.id === 'demo/infra.app').health, 'healthy');
  const appId = initial.find(entry => entry.id === 'demo/infra.app').containers[0].id;
  const dbId = initial.find(entry => entry.id === 'demo/infra.db').containers[0].id;
  const originalId = (await docker('inspect', '-f', '{{.Id}}', appId)).stdout.trim();
  const records = async () => (await invoke('logs', 'demo/infra.app', '--tail', '100')).stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  await waitFor(async () => (await records()).some(record => record.text.includes('compose-log-marker') && record.containerId === appId));
  const followed = [];
  let pending = '';
  follower = spawn(cli, ['logs', 'demo/infra.app', '--json', '--follow'], { env });
  follower.stderr.setEncoding('utf8');
  follower.stderr.on('data', chunk => { followError += chunk; });
  follower.stdout.setEncoding('utf8');
  follower.stdout.on('data', chunk => {
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) if (line.trim()) {
      const record = JSON.parse(line);
      if (record.ok === false) followError += line;
      else followed.push(record);
    }
  });
  await waitFor(() => followed.some(record => record.containerId === appId && record.text.includes('compose-log-marker')));
  await compose('up', '--detach', '--no-deps', '--force-recreate', 'app');
  const replacement = (await compose('ps', '--quiet', 'app')).stdout.trim();
  const replacementId = (await docker('inspect', '-f', '{{.Id}}', replacement)).stdout.trim();
  assert.notEqual(replacementId, originalId);
  await waitFor(async () => (await records()).some(record => record.text.includes('compose-log-marker') && record.containerId && replacementId.startsWith(record.containerId)));
  await waitFor(() => followed.some(record => record.containerId && replacementId.startsWith(record.containerId) && record.text.includes('compose-log-marker')));
  await json('stop', 'demo/infra.app');
  assert.equal((await json('status', 'demo/infra.db')).entries[0].state, 'running');
  assert.equal((await docker('inspect', '-f', '{{.State.Running}}', dbId)).stdout.trim(), 'true');
  await docker('volume', 'inspect', `${project}_data`);
  await json('manager', 'stop');
  await waitFor(async () => {
    try { await readFile(join(state, 'instance.json')); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  });
  assert.equal((await docker('inspect', '-f', '{{.State.Running}}', dbId)).stdout.trim(), 'true');
  await docker('volume', 'inspect', `${project}_data`);
  console.log('PASS installed CLI discovers existing containers, starts a Compose group, reads native health, and follows replacement container logs');
  console.log('PASS individual Compose Stop and manager shutdown preserve the neighbor container and volume');
} finally {
  follower?.kill('SIGTERM');
  if (cli) { try { await json('manager', 'stop'); } catch {} }
  await compose('down', '--volumes', '--remove-orphans');
  await rm(temp, { recursive: true, force: true });
}
