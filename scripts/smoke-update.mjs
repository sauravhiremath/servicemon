import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const OLD_VERSION = '0.1.2-smoke.1';
const NEW_VERSION = '0.1.2-smoke.2';
const PROMPT = '[y/N]';
const root = await mkdtemp(path.join(tmpdir(), 'servicemon-update-'));
const sessions = [];
let oldCli;
let newCli;
let publishedCli;
let composeCleanup;
let failure;

const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const nodeCommand = (code) => `${quote(process.execPath)} -e ${quote(code)}`;
const sleepCommand = () => nodeCommand('setInterval(() => {}, 1000)');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PYTHON = String.raw`
import json, os, pty, select, sys, time
instruction = json.load(open(sys.argv[1], encoding="utf-8"))
argv = instruction["argv"]
env = {key: str(value) for key, value in instruction["env"].items()}
answer = instruction["answer"]
expect = instruction["expect"].encode()
deadline = time.time() + instruction["timeout"]
payloads = {"yes": b"yes\n", "no": b"no\n", "eof": b"\x04", "int": b"\x03"}
if answer not in payloads:
    raise SystemExit("unsupported terminal answer")
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(argv[0], argv, env)
os.set_blocking(fd, False)
buf = bytearray()
sent = False

def take():
    global sent
    try:
        chunk = os.read(fd, 65536)
    except OSError:
        return False
    if not chunk:
        return False
    buf.extend(chunk)
    if not sent and expect in buf:
        sent = True
        try:
            os.write(fd, payloads[answer])
        except OSError:
            pass
    return True

status = None
while status is None and time.time() < deadline:
    readable, _, _ = select.select([fd], [], [], 0.1)
    if readable:
        take()
    waited, state = os.waitpid(pid, os.WNOHANG)
    if waited:
        status = state
drain_until = time.time() + 0.5
while time.time() < drain_until:
    readable, _, _ = select.select([fd], [], [], 0.05)
    if not readable or not take():
        break
if status is None:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    sys.stderr.write(buf.decode("utf-8", "replace"))
    raise SystemExit("terminal scenario timed out before the command exited")
if not sent:
    sys.stderr.write(buf.decode("utf-8", "replace"))
    raise SystemExit("terminal scenario did not show the confirmation prompt")
code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
signal = os.WTERMSIG(status) if os.WIFSIGNALED(status) else None
json.dump({"code": code, "signal": signal, "output": buf.decode("utf-8", "replace"), "sent": sent}, sys.stdout)
`;

function isolatedEnv(dir) {
  const env = { ...process.env };
  delete env.SERVICEMON_STARTUP_EXECUTABLE;
  delete env.SERVICEMON_LAUNCHCTL;
  env.SERVICEMON_CONFIG = path.join(dir, 'config.yaml');
  env.SERVICEMON_STATE_DIR = path.join(dir, 'state');
  env.SERVICEMON_LAUNCH_AGENT_LABEL = `test.servicemon.update.${process.pid}.${path.basename(dir)}`;
  env.SERVICEMON_LAUNCH_AGENTS_DIR = path.join(dir, 'agents');
  return env;
}

async function invoke(file, env, args, timeout = 30000) {
  try {
    const result = await exec(file, args, { env, timeout, encoding: 'utf8' });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error.code !== 'number') {
      throw error;
    }
    return {
      code: error.code,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    };
  }
}

function envelope(stdout, label) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} did not return one JSON envelope.\n${stdout}`, { cause: error });
  }
  assert.equal(value.ok === true || value.ok === false, true, stdout);
  assert.equal('data' in value && 'error' in value, true, stdout);
  if (value.ok) {
    assert.equal(value.error, null, stdout);
  } else {
    assert.equal(value.data, null, stdout);
    assert.equal(typeof value.error?.code, 'string', stdout);
  }
  return value;
}

async function json(file, env, args, timeout = 30000) {
  const result = await invoke(file, env, [...args, '--json'], timeout);
  assert.equal(result.code, 0, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
  const body = envelope(result.stdout, args.join(' '));
  assert.equal(body.ok, true);
  return body.data;
}

async function until(check, label, attempts = 200, pause = 50) {
  for (let n = 0; n < attempts; n += 1) {
    if (await check()) {
      return;
    }
    await delay(pause);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function managerInfo(endpoint) {
  const response = await fetch(`${endpoint}/api/manager/info`);
  if (response.status !== 200) {
    throw new Error(`Manager info returned ${response.status}: ${await response.text()}`);
  }
  const body = await response.json();
  assert.equal(body.ok, true, JSON.stringify(body));
  return body.data;
}

async function settledInfo(endpoint) {
  let info;
  for (let n = 0; n < 100; n += 1) {
    info = await managerInfo(endpoint);
    if (info.startup.state !== 'running') {
      return info;
    }
    await delay(50);
  }
  throw new Error(`Startup did not finish.\n${JSON.stringify(info)}`);
}

function assertIdentity(info, { version, endpoint, ui }) {
  assert.equal(info.managementVersion, 2);
  assert.equal(Array.isArray(info.impact.operations), true);
  assert.equal('operation' in info.impact, false);
  assert.equal(info.version, version);
  assert.equal(Number.isInteger(info.applicationProtocol), true);
  assert.equal(info.endpoint, endpoint);
  assert.equal(typeof info.pid, 'number');
  assert.equal(typeof info.startedAt, 'string');
  assert.equal(typeof info.configPath, 'string');
  assert.equal(info.launchSettings.port, Number(new URL(endpoint).port));
  assert.equal(info.launchSettings.ui, ui);
  assert.equal(typeof info.impact?.impactKey, 'string');
  assert.equal(info.impact.impactKey.length > 0, true);
  assert.equal(info.shutdown?.state === 'idle' || info.shutdown?.state === 'stopping', true);
}

function assertStatus(status, expected) {
  assert.equal(status.running, true);
  assert.equal(status.cliVersion, expected.cliVersion);
  assert.equal(status.managerVersion, expected.managerVersion);
  assert.equal(Number.isInteger(status.applicationProtocol), true);
  assert.equal(status.compatible, expected.compatible);
  assert.equal(status.restartRequired, expected.restartRequired);
  assert.equal(typeof status.pid, 'number');
  assert.equal(typeof status.endpoint, 'string');
  assert.equal(typeof status.configPath, 'string');
}

function readRestart(data) {
  assert.equal(typeof data?.endpoint, 'string');
  assert.equal(typeof data?.configPath, 'string');
  assert.equal(data?.port, Number(new URL(data.endpoint).port));
  assert.equal(data?.ui === null || typeof data?.ui === 'string', true);
  assert.equal(typeof data?.startupRegistration?.registered, 'boolean');
  assert.equal(Number.isInteger(data?.applicationProtocol), true);
  assert.equal(data?.current?.endpoint, data.endpoint);
  for (const side of ['previous', 'current']) {
    assert.equal(typeof data[side]?.pid, 'number', side);
    assert.equal(typeof data[side]?.startedAt, 'string', side);
    assert.equal(typeof data[side]?.version, 'string', side);
  }
  return data;
}

async function entry(env, id) {
  return (await json(newCli, env, ['status', id])).entries[0];
}

async function terminal(file, args, env, answer, timeout = 120) {
  const instruction = path.join(
    root,
    `pty-${answer}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
  );
  await writeFile(
    instruction,
    JSON.stringify({ argv: [file, ...args], env, answer, expect: PROMPT, timeout }),
  );
  try {
    const result = await exec('python3', ['-c', PYTHON, instruction], {
      timeout: (timeout + 10) * 1000,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `PTY helper failed for ${answer}.\n${error.stdout ?? ''}\n${error.stderr ?? ''}`,
      { cause: error },
    );
  }
}

async function stopManager(env) {
  if (!newCli) {
    return;
  }
  await invoke(newCli, env, ['manager', 'stop', '--json'], 20000);
  const instance = path.join(env.SERVICEMON_STATE_DIR, 'instance.json');
  for (let n = 0; n < 100; n += 1) {
    let text;
    try {
      text = await readFile(instance, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
    if (n === 99) {
      const record = JSON.parse(text);
      const command = (
        await exec('/bin/ps', ['-p', String(record.pid), '-o', 'command='], {
          encoding: 'utf8',
        }).catch(() => ({ stdout: '' }))
      ).stdout;
      if (command.includes(env.SERVICEMON_STATE_DIR) && alive(record.pid)) {
        process.kill(record.pid, 'SIGTERM');
      }
      return;
    }
    await delay(50);
  }
}

async function installTrees() {
  await exec('npm', ['run', 'build'], { timeout: 180000, encoding: 'utf8' });
  console.log('BUILD complete');
  const packed = JSON.parse(
    (
      await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], {
        timeout: 120000,
        encoding: 'utf8',
      })
    ).stdout,
  )[0];
  const archive = path.join(root, packed.filename);
  for (const [name, version] of [
    ['old', OLD_VERSION],
    ['new', NEW_VERSION],
  ]) {
    const prefix = path.join(root, name);
    await mkdir(prefix, { recursive: true });
    await exec(
      'npm',
      ['install', '--ignore-scripts', '--prefix', prefix, '--no-audit', '--no-fund', archive],
      { timeout: 180000, encoding: 'utf8' },
    );
    const manifestPath = path.join(prefix, 'node_modules/servicemon/package.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.version = version;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const cli = path.join(prefix, 'node_modules/.bin/servicemon');
    const reported = (await exec(cli, ['--version'], { encoding: 'utf8' })).stdout.trim();
    assert.equal(
      reported,
      version,
      `${name} tree reported ${reported}. The package version must be read from package.json at process start.`,
    );
    if (name === 'old') {
      oldCli = cli;
    } else {
      newCli = cli;
    }
  }
}

async function installPublishedTree() {
  const source = path.join(root, 'published-source');
  const name = 'servicemon-0.1.3-source.tar.gz';
  const archive = path.join(root, name);
  const release = 'https://github.com/sauravhiremath/servicemon/releases/download/v0.1.3';
  const [response, checksumResponse] = await Promise.all([
    fetch(`${release}/${name}`),
    fetch(`${release}/${name}.sha256`),
  ]);
  assert.equal(response.ok, true, `Published archive returned HTTP ${response.status}`);
  assert.equal(
    checksumResponse.ok,
    true,
    `Published checksum returned HTTP ${checksumResponse.status}`,
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  const checksum = (await checksumResponse.text()).trim().split(/\s+/)[0];
  assert.equal(createHash('sha256').update(bytes).digest('hex'), checksum);
  await writeFile(archive, bytes);
  await mkdir(source, { recursive: true });
  await exec('tar', ['-xzf', archive, '--strip-components=1', '-C', source], {
    timeout: 30000,
    encoding: 'utf8',
  });
  await exec('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: source,
    timeout: 180000,
    encoding: 'utf8',
  });
  await exec('npm', ['run', 'build'], { cwd: source, timeout: 180000, encoding: 'utf8' });
  const packed = JSON.parse(
    (
      await exec('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', source], {
        cwd: source,
        timeout: 120000,
        encoding: 'utf8',
      })
    ).stdout,
  )[0];
  const prefix = path.join(root, 'published');
  await exec(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--prefix',
      prefix,
      '--no-audit',
      '--no-fund',
      path.join(source, packed.filename),
    ],
    { timeout: 180000, encoding: 'utf8' },
  );
  publishedCli = path.join(prefix, 'node_modules/.bin/servicemon');
  assert.equal(
    (await exec(publishedCli, ['--version'], { encoding: 'utf8' })).stdout.trim(),
    '0.1.3',
  );
}

async function publishedUpgrade() {
  const dir = path.join(root, 'published-upgrade');
  const { env } = await openFixture(
    'published-upgrade',
    serviceDefinition(dir, {
      services: { worker: { command: sleepCommand() } },
    }),
  );
  const started = await json(publishedCli, env, ['serve', '--background', '--port', '0']);
  await json(publishedCli, env, ['start', 'demo/worker']);
  const before = await settledInfo(started.endpoint);
  assert.equal(before.managementVersion, 1);
  assert.equal(before.applicationProtocol, 1);
  assert.equal(before.impact.operation, null);
  assertStatus(await json(newCli, env, ['manager', 'status']), {
    cliVersion: NEW_VERSION,
    managerVersion: '0.1.3',
    compatible: false,
    restartRequired: true,
  });
  const blocked = await invoke(newCli, env, ['status', '--json']);
  assert.equal(blocked.code, 5, blocked.stdout + blocked.stderr);
  assert.equal(envelope(blocked.stdout, 'published status').error.code, 'MANAGER_VERSION_MISMATCH');
  const result = await restartJson(env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const data = readRestart(result.body.data);
  assert.equal(data.previous.version, '0.1.3');
  assert.notEqual(data.current.pid, before.pid);
  assert.equal(alive(before.pid), false);
  assert.equal(data.endpoint, started.endpoint);
  assertIdentity(await settledInfo(data.endpoint), {
    version: NEW_VERSION,
    endpoint: data.endpoint,
    ui: null,
  });
  assert.equal((await entry(env, 'demo/worker')).state, 'stopped');
  console.log('PASS published 0.1.3 management inspection and guarded upgrade to version 2');
}

async function checkPty() {
  const file = path.join(root, 'pty-self-check.mjs');
  await writeFile(
    file,
    [
      "import readline from 'node:readline';",
      'const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });',
      'const answer = await new Promise((resolve) => {',
      '  let settled = false;',
      '  const finish = (value) => { if (!settled) { settled = true; resolve(value); } };',
      "  rl.once('close', () => finish('CLOSE'));",
      "  rl.once('SIGINT', () => finish('SIGINT'));",
      "  rl.question('Confirm? [y/N] ', (value) => finish(value));",
      '});',
      'console.log(JSON.stringify({ tty: Boolean(process.stdin.isTTY && process.stderr.isTTY), answer }));',
      'rl.close();',
      '',
    ].join('\n'),
  );
  const yes = await terminal(process.execPath, [file], process.env, 'yes', 10);
  assert.equal(yes.code, 0, yes.output);
  assert.match(yes.output, /"tty":true/);
  assert.match(yes.output, /"answer":"yes"/);
  const eof = await terminal(process.execPath, [file], process.env, 'eof', 10);
  assert.match(eof.output, /"answer":"CLOSE"/);
  const interrupted = await terminal(process.execPath, [file], process.env, 'int', 10);
  assert.equal(
    interrupted.signal === 2 || interrupted.output.includes('"answer":"SIGINT"'),
    true,
    interrupted.output,
  );
}

async function openFixture(name, definition) {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  const env = isolatedEnv(dir);
  sessions.push(env);
  await writeFile(env.SERVICEMON_CONFIG, JSON.stringify(definition));
  return { dir, env };
}

function serviceDefinition(dir, extra = {}) {
  return {
    version: 1,
    server: { port: 0 },
    timeouts: { stop_seconds: 1 },
    projects: { demo: { directory: dir, ...extra } },
  };
}

async function scriptNotice() {
  const { env } = await openFixture(
    'notice',
    serviceDefinition(path.join(root, 'notice'), {
      services: { worker: { command: sleepCommand() } },
    }),
  );
  await json(oldCli, env, ['serve', '--background', '--port', '0']);
  await json(oldCli, env, ['start', 'demo/worker']);
  const before = await json(oldCli, env, ['manager', 'status']);
  const result = await invoke(newCli, env, ['status', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const body = envelope(result.stdout, 'status');
  assert.equal(body.ok, true);
  assert.match(result.stderr, new RegExp(escapeRegExp(OLD_VERSION)));
  assert.match(result.stderr, new RegExp(escapeRegExp(NEW_VERSION)));
  assert.doesNotMatch(result.stdout, /\[y\/N\]/);
  assert.doesNotMatch(result.stderr, /\[y\/N\]/);
  const after = await json(newCli, env, ['manager', 'status']);
  assert.equal(after.pid, before.pid);
  assert.equal(after.endpoint, before.endpoint);
  assertStatus(after, {
    cliVersion: NEW_VERSION,
    managerVersion: OLD_VERSION,
    compatible: true,
    restartRequired: false,
  });
  assert.equal((await entry(env, 'demo/worker')).state, 'running');
  const refused = await invoke(newCli, env, ['manager', 'restart', '--json']);
  const refusedBody = envelope(refused.stdout, 'manager restart');
  assert.equal(refused.code, 2, refused.stdout + refused.stderr);
  assert.equal(refusedBody.ok, false);
  assert.equal(refusedBody.error.code, 'INVALID_INPUT');
  assert.equal((await json(newCli, env, ['manager', 'status'])).pid, before.pid);
  console.log('PASS compatible script keeps the same manager and writes one JSON envelope');
}

async function restartJson(env) {
  const result = await invoke(newCli, env, ['manager', 'restart', '--yes', '--json'], 120000);
  const body = envelope(result.stdout, 'manager restart --yes --json');
  return { ...result, body };
}

async function customUi() {
  const { dir, env } = await openFixture('custom-ui', { version: 1 });
  const ui = path.join(dir, 'index.html');
  await writeFile(ui, '<!doctype html><title>smoke</title>smoke-custom-dashboard');
  await writeFile(
    env.SERVICEMON_CONFIG,
    JSON.stringify(serviceDefinition(dir, { services: { worker: { command: sleepCommand() } } })),
  );
  const started = await json(oldCli, env, ['serve', '--background', '--port', '0', '--ui', ui]);
  const before = await settledInfo(started.endpoint);
  const uiPath = await realpath(ui);
  assert.equal(before.startup.state, 'succeeded', JSON.stringify(before.startup));
  assertIdentity(before, { version: OLD_VERSION, endpoint: started.endpoint, ui: uiPath });
  assert.match(await (await fetch(started.endpoint)).text(), /smoke-custom-dashboard/);
  const result = await restartJson(env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.body.ok, true);
  const data = readRestart(result.body.data);
  assert.equal(data.previous.version, OLD_VERSION);
  assert.equal(data.current.version, NEW_VERSION);
  assert.equal(data.previous.pid, before.pid);
  assert.notEqual(data.current.pid, before.pid);
  assert.equal(data.startupRegistration.registered, false);
  assert.equal(new URL(data.endpoint).port, new URL(started.endpoint).port);
  assert.doesNotMatch(result.stdout, /\[y\/N\]/);
  const after = await settledInfo(data.endpoint);
  assert.equal(after.startup.state, 'succeeded', JSON.stringify(after.startup));
  assertIdentity(after, { version: NEW_VERSION, endpoint: data.endpoint, ui: uiPath });
  assert.match(await (await fetch(data.endpoint)).text(), /smoke-custom-dashboard/);
  assert.equal(alive(before.pid), false);
  console.log('PASS detached restart preserves the bound port and custom dashboard');
}

async function builtinUi() {
  const { env } = await openFixture(
    'builtin-ui',
    serviceDefinition(path.join(root, 'builtin-ui'), {
      services: { worker: { command: sleepCommand() } },
    }),
  );
  const started = await json(oldCli, env, ['serve', '--background', '--port', '0']);
  const before = await settledInfo(started.endpoint);
  assert.equal(before.startup.state, 'succeeded');
  assertIdentity(before, { version: OLD_VERSION, endpoint: started.endpoint, ui: null });
  assert.match(await (await fetch(started.endpoint)).text(), /Servicemon/);
  const result = await restartJson(env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const data = readRestart(result.body.data);
  assert.equal(new URL(data.endpoint).port, new URL(started.endpoint).port);
  assert.equal(data.startupRegistration.registered, false);
  const after = await settledInfo(data.endpoint);
  assertIdentity(after, { version: NEW_VERSION, endpoint: data.endpoint, ui: null });
  assert.match(await (await fetch(data.endpoint)).text(), /Servicemon/);
  assert.equal(alive(before.pid), false);
  console.log('PASS detached restart preserves the bound port and built-in dashboard');
}

async function invalidConfig() {
  const { env } = await openFixture(
    'invalid-config',
    serviceDefinition(path.join(root, 'invalid-config'), {
      services: { worker: { command: sleepCommand() } },
    }),
  );
  const started = await json(oldCli, env, ['serve', '--background', '--port', '0']);
  const before = await settledInfo(started.endpoint);
  await writeFile(env.SERVICEMON_CONFIG, 'version: [invalid');
  const result = await restartJson(env);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error.code, 'INVALID_CONFIG');
  assert.equal(alive(before.pid), true);
  assert.equal((await json(newCli, env, ['manager', 'status'])).pid, before.pid);
  assert.equal((await fetch(`${started.endpoint}/api/status`)).status, 200);
  console.log('PASS invalid config preflight leaves the old manager running');
}

async function missingDashboard() {
  const { dir, env } = await openFixture('missing-ui', { version: 1 });
  const ui = path.join(dir, 'index.html');
  await writeFile(ui, '<!doctype html>smoke-custom-dashboard');
  await writeFile(env.SERVICEMON_CONFIG, JSON.stringify(serviceDefinition(dir)));
  const started = await json(oldCli, env, ['serve', '--background', '--port', '0', '--ui', ui]);
  const before = await settledInfo(started.endpoint);
  await rm(ui);
  const result = await restartJson(env);
  assert.equal(result.code, 2, result.stdout + result.stderr);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error.code, 'INVALID_INPUT');
  assert.equal(alive(before.pid), true);
  assert.equal((await json(newCli, env, ['manager', 'status'])).pid, before.pid);
  assert.equal((await fetch(`${started.endpoint}/api/status`)).status, 200);
  console.log('PASS missing dashboard preflight leaves the old manager running');
}

function taskDefinition(dir, hold, boot) {
  return serviceDefinition(dir, {
    services: { worker: { command: sleepCommand() } },
    tasks: {
      hold: {
        command: nodeCommand(
          `require("fs").appendFileSync(${JSON.stringify(hold)}, "s"); setInterval(() => {}, 1000)`,
        ),
      },
      peer: { command: sleepCommand() },
      boot: {
        command: nodeCommand(`require("fs").appendFileSync(${JSON.stringify(boot)}, "b")`),
        autostart: true,
      },
    },
  });
}

async function waitForTask(env, hold, boot) {
  const manager = await json(oldCli, env, ['manager', 'status']);
  assert.equal((await settledInfo(manager.endpoint)).startup.state, 'succeeded');
  await until(async () => {
    try {
      return (await readFile(boot, 'utf8')) === 'b';
    } catch {
      return false;
    }
  }, 'initial autostart');
  await json(oldCli, env, ['run', 'demo/hold', '--no-wait']);
  await until(async () => {
    try {
      return (
        (await readFile(hold, 'utf8')) === 's' &&
        (await entry(env, 'demo/hold')).state === 'running'
      );
    } catch {
      return false;
    }
  }, 'active task');
  await json(oldCli, env, ['run', 'demo/peer', '--no-wait']);
  await until(
    async () => (await entry(env, 'demo/peer')).state === 'running',
    'independent active task',
  );
  const info = await managerInfo(manager.endpoint);
  assert.equal(info.impact.operations.length, 2, JSON.stringify(info.impact));
  assert.deepEqual(
    [...info.impact.taskIds].sort((left, right) => left.localeCompare(right)),
    ['demo/hold', 'demo/peer'],
  );
}

async function taskReplay() {
  const dir = path.join(root, 'tasks');
  const hold = path.join(dir, 'hold');
  const boot = path.join(dir, 'boot');
  const { env } = await openFixture('tasks', taskDefinition(dir, hold, boot));
  const started = await json(oldCli, env, ['serve', '--background', '--port', '0']);
  assert.equal((await settledInfo(started.endpoint)).startup.state, 'succeeded');
  await json(oldCli, env, ['start', 'demo/worker']);
  await waitForTask(env, hold, boot);
  const result = await restartJson(env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const data = readRestart(result.body.data);
  assert.equal(await readFile(hold, 'utf8'), 's');
  await until(async () => (await readFile(boot, 'utf8')) === 'bb', 'replacement autostart');
  assert.notEqual((await entry(env, 'demo/hold')).state, 'running');
  assert.equal((await entry(env, 'demo/worker')).state, 'stopped');
  assert.equal(alive(data.previous.pid), false);
  assert.equal(data.current.version, NEW_VERSION);
  console.log('PASS restart does not replay the active task and runs normal autostart');
}

async function autostartFailure() {
  const { env } = await openFixture(
    'autostart-fail',
    serviceDefinition(path.join(root, 'autostart-fail'), {
      tasks: { boom: { command: nodeCommand('process.exit(17)'), autostart: true } },
    }),
  );
  const started = await invoke(oldCli, env, ['serve', '--background', '--port', '0', '--json']);
  let before;
  await until(async () => {
    const status = await invoke(newCli, env, ['manager', 'status', '--json']);
    if (status.code !== 0) {
      return false;
    }
    before = envelope(status.stdout, 'manager status').data;
    return true;
  }, `autostart fixture manager\n${started.stdout}${started.stderr}`);
  const info = await settledInfo(before.endpoint);
  assert.equal(info.startup.state, 'failed', JSON.stringify(info.startup));
  const result = await restartJson(env);
  assert.equal(result.code, 3, result.stdout + result.stderr);
  assert.equal(result.body.ok, false);
  assert.equal(result.body.error.code, 'MANAGER_RESTART_FAILED');
  const details = result.body.error.details;
  assert.equal(details.phase, 'autostart');
  assert.equal(details.running, true);
  assert.equal(details.command, 'servicemon manager status');
  assert.equal(alive(before.pid), false);
  const after = await invoke(newCli, env, ['manager', 'status', '--json']);
  const running = after.code === 0;
  assert.equal(details.running, running, `${after.stdout}${after.stderr}`);
  if (running) {
    const data = envelope(after.stdout, 'status after autostart failure').data;
    assert.notEqual(data.pid, before.pid);
    assert.equal(data.managerVersion, NEW_VERSION);
    assert.equal((await settledInfo(data.endpoint)).startup.state, 'failed');
  }
  console.log('PASS failed autostart reports its phase and running state without success');
}

async function terminalCase(answer) {
  const dir = path.join(root, `terminal-${answer}`);
  const hold = path.join(dir, 'hold');
  const boot = path.join(dir, 'boot');
  const { env } = await openFixture(`terminal-${answer}`, taskDefinition(dir, hold, boot));
  await json(oldCli, env, ['serve', '--background', '--port', '0']);
  await waitForTask(env, hold, boot);
  const before = await json(oldCli, env, ['manager', 'status']);
  const impact = (await managerInfo(before.endpoint)).impact;
  const session = await terminal(newCli, ['manager', 'restart'], env, answer);
  assert.equal(session.sent, true, session.output);
  assert.equal(session.output.split(PROMPT).length - 1, 1, session.output);
  for (const operation of impact.operations) {
    assert.equal(
      session.output.includes(`${operation.id} (${operation.action})`),
      true,
      session.output,
    );
  }
  assert.match(session.output, new RegExp(escapeRegExp(OLD_VERSION)));
  assert.match(session.output, new RegExp(escapeRegExp(NEW_VERSION)));
  const configPath = await realpath(env.SERVICEMON_CONFIG);
  assert.equal(
    session.output.includes(env.SERVICEMON_CONFIG) || session.output.includes(configPath),
    true,
    session.output,
  );
  if (answer === 'yes') {
    assert.equal(session.code, 0, session.output);
    assert.equal(session.signal, null);
    assert.equal(await readFile(hold, 'utf8'), 's');
    await until(
      async () => (await readFile(boot, 'utf8')) === 'bb',
      'terminal replacement autostart',
    );
    const after = await json(newCli, env, ['manager', 'status']);
    assert.notEqual(after.pid, before.pid);
    assert.equal(after.managerVersion, NEW_VERSION);
    assert.equal(alive(before.pid), false);
    assert.notEqual((await entry(env, 'demo/hold')).state, 'running');
  } else {
    const refused = session.code === 1 || (answer === 'int' && session.signal === 2);
    assert.equal(refused, true, JSON.stringify({ code: session.code, signal: session.signal }));
    if (session.code === 1) {
      assert.match(session.output, /MANAGER_RESTART_CANCELLED/);
    }
    const after = await json(oldCli, env, ['manager', 'status']);
    assert.equal(after.pid, before.pid);
    assert.equal(await readFile(hold, 'utf8'), 's');
    assert.equal((await entry(env, 'demo/hold')).state, 'running');
    assert.equal(await readFile(boot, 'utf8'), 'b');
  }
  console.log(`PASS terminal ${answer} uses one real confirmation and checks the old process`);
}
async function automaticOnce() {
  const dir = path.join(root, 'automatic-once');
  const boot = path.join(dir, 'boot');
  const once = path.join(dir, 'once');
  const { env } = await openFixture(
    'automatic-once',
    serviceDefinition(dir, {
      tasks: {
        boot: {
          command: nodeCommand(`require("fs").appendFileSync(${JSON.stringify(boot)}, "b")`),
          autostart: true,
        },
        once: {
          command: nodeCommand(
            `const fs=require("fs"); fs.appendFileSync(${JSON.stringify(once)}, fs.readFileSync(${JSON.stringify(boot)}, "utf8") + "\\n")`,
          ),
        },
      },
    }),
  );
  await json(oldCli, env, ['serve', '--background', '--port', '0']);
  await until(async () => {
    try {
      return (await readFile(boot, 'utf8')) === 'b';
    } catch {
      return false;
    }
  }, 'initial autostart before automatic restart');
  const before = await json(oldCli, env, ['manager', 'status']);
  const session = await terminal(newCli, ['run', 'demo/once'], env, 'yes');
  assert.equal(session.sent, true, session.output);
  assert.equal(session.code, 0, session.output);
  assert.equal(session.signal, null);
  assert.equal(session.output.split(PROMPT).length - 1, 1, session.output);
  assert.equal(await readFile(boot, 'utf8'), 'bb');
  assert.equal(await readFile(once, 'utf8'), 'bb\n');
  const after = await json(newCli, env, ['manager', 'status']);
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.managerVersion, NEW_VERSION);
  assert.equal(after.cliVersion, NEW_VERSION);
  assert.equal(alive(before.pid), false);
  console.log('PASS terminal yes runs the original task once after replacement autostart');
}

async function composeCase() {
  try {
    await exec('docker', ['info'], { timeout: 15000, encoding: 'utf8' });
  } catch (error) {
    const detail = `${error.stderr || ''}${error.stdout || ''}${error.message || error}`.trim();
    console.log(`SKIP compose restart: Docker is not available. ${detail}`);
    return;
  }
  const dir = path.join(root, 'compose');
  const directory = path.join(dir, 'fixture');
  await mkdir(directory, { recursive: true });
  const project = `smusmoke${process.pid.toString(36)}${Date.now().toString(36)}`;
  const file = path.join(directory, 'compose.yaml');
  composeCleanup = { directory, project, file };
  await writeFile(
    file,
    'services:\n  db:\n    image: ubuntu:24.04\n    command: ["sleep", "600"]\n',
  );
  const { env } = await openFixture('compose', {
    version: 1,
    server: { port: 0 },
    projects: {
      demo: {
        directory,
        compose_groups: { infra: { file: 'compose.yaml', project_name: project } },
      },
    },
  });
  await exec(
    'docker',
    [
      'compose',
      '--project-name',
      project,
      '--project-directory',
      directory,
      '--file',
      file,
      'up',
      '--detach',
      'db',
    ],
    { timeout: 180000, encoding: 'utf8' },
  );
  await json(oldCli, env, ['serve', '--background', '--port', '0']);
  let containerId;
  await until(
    async () => {
      const status = await json(newCli, env, ['status', 'demo/infra.db']);
      containerId = status.entries[0].containers?.[0]?.id;
      return status.entries[0].state === 'running' && Boolean(containerId);
    },
    'fixture container',
    160,
    250,
  );
  const full = (
    await exec('docker', ['inspect', '-f', '{{.Id}}', containerId], { encoding: 'utf8' })
  ).stdout.trim();
  const result = await restartJson(env);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const after = await json(newCli, env, ['status', 'demo/infra.db']);
  assert.equal(after.entries[0].containers[0].id, containerId);
  assert.equal(after.entries[0].state, 'running');
  const fullAfter = (
    await exec('docker', ['inspect', '-f', '{{.Id}}', containerId], { encoding: 'utf8' })
  ).stdout.trim();
  assert.equal(fullAfter, full);
  assert.equal(
    (
      await exec('docker', ['inspect', '-f', '{{.State.Running}}', full], { encoding: 'utf8' })
    ).stdout.trim(),
    'true',
  );
  console.log('PASS restart keeps the fixture Compose container identity');
}

try {
  await exec('python3', ['-c', 'import pty'], { encoding: 'utf8' });
  await checkPty();
  await installTrees();
  await installPublishedTree();
  await publishedUpgrade();
  await scriptNotice();
  await customUi();
  await builtinUi();
  await invalidConfig();
  await missingDashboard();
  await taskReplay();
  await autostartFailure();
  for (const answer of ['yes', 'no', 'eof', 'int']) {
    await terminalCase(answer);
  }
  await automaticOnce();
  await composeCase();
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const env of sessions) {
    try {
      await stopManager(env);
    } catch (error) {
      cleanupErrors.push(error);
    }
    await exec('/bin/launchctl', [
      'bootout',
      `gui/${process.getuid()}/${env.SERVICEMON_LAUNCH_AGENT_LABEL}`,
    ]).catch(() => {});
  }
  if (composeCleanup) {
    try {
      await exec(
        'docker',
        [
          'compose',
          '--project-name',
          composeCleanup.project,
          '--project-directory',
          composeCleanup.directory,
          '--file',
          composeCleanup.file,
          'down',
          '--volumes',
          '--remove-orphans',
        ],
        { timeout: 120000, encoding: 'utf8' },
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await rm(root, { recursive: true, force: true });
  if (!failure && cleanupErrors.length) {
    failure = new AggregateError(cleanupErrors, 'Smoke update cleanup failed');
  }
}
if (failure) {
  throw failure;
}
