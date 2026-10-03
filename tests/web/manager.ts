import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as base, expect } from '@playwright/test';

export type Manager = {
  url: string;
  configPath: string;
  stateDir: string;
  directory: string;
};



function fixtureConfig(directory: string): string {
  const services = Array.from({ length: 21 }, (_, index) => {
    const name = `svc-${String(index + 1).padStart(2, '0')}`;
    const project = index < 12 ? 'fixture-a' : 'fixture-b';
    return { project, name, command: 'sleep 45' };
  });
  const a = services.filter((service) => service.project === 'fixture-a');
  const b = services.filter((service) => service.project === 'fixture-b');
  const serviceYaml = (service: { name: string; command: string }) => `      ${service.name}:\n        command: ${service.command}\n`;
  return `version: 1
projects:
  fixture-a:
    name: Fixture A
    directory: ${JSON.stringify(directory)}
    services:
      talker:
        command: >-
          sh -c 'printf "hello-fixture\\n<script>alert(1)</script>\\n"; printf "LOG: routine checkpoint\\nWARNING: fixture warning\\nERROR: fixture error\\n" >&2; i=0; while [ "$i" -lt 40 ]; do i=$((i+1)); printf "line-%s\\n" "$i"; sleep 0.15; done; sleep 45'
        notes: Talker notes
        links:
          - http://127.0.0.1:9/docs
${a.map(serviceYaml).join('')}
    tasks:
      once:
        command: echo task-ok
        notes: One shot
  fixture-b:
    name: Fixture B
    directory: ${JSON.stringify(directory)}
    services:
${b.map(serviceYaml).join('')}`;
}

export const test = base.extend<{ manager: Manager }, { installedCli: string }>({
  installedCli: [async ({}, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'servicemon-web-install-'));
    const exec = promisify(execFile);
    try {
      const packed = await exec('npm', ['pack', '--ignore-scripts', '--pack-destination', directory, '--json']);
      const tarball = path.join(directory, JSON.parse(packed.stdout)[0].filename);
      await exec('npm', ['install', '--prefix', directory, '--no-audit', '--no-fund', tarball]);
      await use(path.join(directory, 'node_modules/.bin/servicemon'));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
  manager: async ({ installedCli, page }, use) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'servicemon-web-'));
    const stateDir = path.join(directory, 'state');
    const configPath = path.join(directory, 'config.yaml');
    await writeFile(configPath, fixtureConfig(directory));
    const port = 0;
    const cli = installedCli;
    const child = spawn(process.execPath, [cli, 'serve', '--config', configPath, '--port', String(port)], {
      env: { ...process.env, SERVICEMON_CONFIG: configPath, SERVICEMON_STATE_DIR: stateDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += String(chunk); });
    child.stderr?.on('data', (chunk) => { output += String(chunk); });
    const url = await printedEndpoint(child, () => output);
    try {
      await waitForUrl(url, child, () => output);
      await page.goto(url);
      await use({ url, configPath, stateDir, directory });
    } finally {
      await stopChild(child);
      await rm(directory, { recursive: true, force: true });
    }
  },
});

async function printedEndpoint(child: ChildProcess, output: () => string): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    const match = output().match(/https?:\/\/127\.0\.0\.1:\d+/);
    if (match) return match[0];
    if (child.exitCode !== null) throw new Error(`Manager exited ${child.exitCode} before it printed an endpoint.\n${output()}`);
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 100);
    await promise;
  }
  throw new Error(`Manager did not print an endpoint.\n${output()}`);
}

async function waitForUrl(url: string, child: ChildProcess, output: () => string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (child.exitCode !== null) throw new Error(`Manager exited ${child.exitCode} before ${url} was ready.\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The manager is still starting.
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 200);
    await promise;
  }
  throw new Error(`Manager did not serve ${url}.\n${output()}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || !child.pid) return;
  child.kill('SIGTERM');
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    resolve();
  }, 3000);
  child.once('exit', () => {
    clearTimeout(timer);
    resolve();
  });
  await promise;
}

export { expect };
