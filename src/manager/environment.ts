import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AppError } from '../shared/errors.js';

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function parseEnv(body: Buffer): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const entry of body.toString('utf8').split('\0')) {
    if (entry.length === 0) {
      continue;
    }
    const split = entry.indexOf('=');
    if (split <= 0) {
      continue;
    }
    env[entry.slice(0, split)] = entry.slice(split + 1);
  }
  return env;
}

function timeoutMs(): number {
  const raw = process.env.SERVICEMON_ENV_CAPTURE_TIMEOUT_MS;
  if (!raw) {
    return 15000;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError(
      'ENVIRONMENT_CAPTURE_FAILED',
      'SERVICEMON_ENV_CAPTURE_TIMEOUT_MS must be a positive integer.',
    );
  }
  return value;
}

export async function captureEnvironment(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SERVICEMON_LOGIN_SHELL || process.env.SHELL || '/bin/zsh';
  const limit = timeoutMs();
  const directory = await mkdtemp(path.join(tmpdir(), 'servicemon-env-'));
  const captureFile = path.join(directory, 'env');
  const command = `/usr/bin/env -0 > ${quote(captureFile)}`;
  const child = spawn(shell, ['-l', '-c', command], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.resume();
  let stderr = Buffer.alloc(0);
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = Buffer.concat([stderr, chunk]).subarray(-4096);
  });
  const { promise, resolve } = Promise.withResolvers<{ code: number | null; error?: Error }>();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }, limit);
  child.once('error', (error) => resolve({ code: null, error }));
  child.once('close', (code) => resolve({ code }));
  try {
    const result = await promise;
    if (timedOut) {
      throw new AppError('ENVIRONMENT_CAPTURE_FAILED', `Login shell timed out after ${limit} ms.`, {
        shell,
      });
    }
    if (result.error) {
      throw new AppError('ENVIRONMENT_CAPTURE_FAILED', result.error.message, { shell });
    }
    if (result.code !== 0) {
      throw new AppError('ENVIRONMENT_CAPTURE_FAILED', `Login shell exited ${result.code}.`, {
        shell,
        stderr: stderr.toString('utf8'),
      });
    }
    return parseEnv(await readFile(captureFile));
  } finally {
    clearTimeout(timer);
    await rm(directory, { recursive: true, force: true });
  }
}
