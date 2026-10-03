import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ComposeGroup } from '../../src/shared/types.js';

function projectName(): string {
  return `smc${Date.now().toString(36)}${randomBytes(2).toString('hex')}`.toLowerCase();
}

export async function makeGroup(yaml?: string): Promise<ComposeGroup> {
  const directory = await mkdtemp(join(tmpdir(), 'smc-'));
  const file = join(directory, 'compose.yaml');
  const source =
    yaml ??
    (await readFile(new URL('../fixtures/compose/docker-compose.yaml', import.meta.url), 'utf8'));
  await writeFile(file, source);
  return {
    id: 'demo/infra',
    projectId: 'demo',
    key: 'infra',
    name: 'Infra',
    directory,
    file,
    projectName: projectName(),
    autostart: false,
    overrides: {},
  };
}

export async function removeGroup(group: ComposeGroup): Promise<void> {
  const result = await docker(
    [
      'compose',
      '--project-name',
      group.projectName,
      '--project-directory',
      group.directory,
      '--file',
      group.file,
      'down',
      '-v',
      '--remove-orphans',
    ],
    group.directory,
  );
  await rm(group.directory, { recursive: true, force: true });
  if (
    result.code !== 0 &&
    !/failed to parse|no such file|no configuration file/i.test(
      `${result.stderr}\n${result.stdout}`,
    )
  ) {
    throw new Error(result.stderr || result.stdout);
  }
}

export function docker(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { promise, resolve, reject } = Promise.withResolvers<{
    stdout: string;
    stderr: string;
    code: number;
  }>();
  const child = spawn('docker', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('error', reject);
  child.on('exit', (code) =>
    resolve({
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      code: code ?? 1,
    }),
  );
  return promise;
}

export async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 30000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) {
      return;
    }
    await delay(250);
  }
  throw new Error('timed out');
}
