import { spawn } from 'node:child_process';
import { AppError } from '../shared/errors.js';

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve: (value: T | PromiseLike<T>) => void;
      reject: (reason?: unknown) => void;
    };
  }
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

function stringEnv(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

export function sameEnv(left: NodeJS.ProcessEnv, right: NodeJS.ProcessEnv): boolean {
  const a = stringEnv(left);
  const b = stringEnv(right);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

export function runDocker(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CommandResult> {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResult>();
  const child = spawn('docker', args, {
    cwd: options.cwd,
    env: stringEnv(options.env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let settled = false;
  const finish = (error?: AppError, result?: CommandResult) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    if (error) {
      reject(error);
    } else {
      resolve(result!);
    }
  };
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish(
      new AppError('COMPOSE_FAILED', `Docker command timed out: docker ${args.join(' ')}`, {
        timeoutMs: options.timeoutMs ?? 30000,
      }),
    );
  }, options.timeoutMs ?? 30000);
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.on('error', (error: NodeJS.ErrnoException) => {
    finish(
      new AppError('DOCKER_UNAVAILABLE', 'Docker Compose is not available.', {
        message: error.message,
        code: error.code,
      }),
    );
  });
  child.on('exit', (code) => {
    finish(undefined, {
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      code: code ?? 1,
    });
  });
  return promise;
}

export function mapComposeFailure(result: CommandResult, fallback: string): AppError {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  const details = {
    stderr: result.stderr.slice(-4000),
    stdout: result.stdout.slice(-2000),
    code: result.code,
  };
  if (
    /cannot connect to the docker daemon|is the docker daemon running|error during connect|permission denied while trying to connect|dial unix/i.test(
      text,
    )
  ) {
    return new AppError('DOCKER_UNAVAILABLE', text || 'Docker is not available.', details);
  }
  if (
    /no such service|unknown service|yaml:|invalid|compose file|not found|couldn't find env file/i.test(
      text,
    )
  ) {
    return new AppError('INVALID_CONFIG', text || fallback, details);
  }
  return new AppError('COMPOSE_FAILED', text || fallback, details);
}

export async function dockerCompose(
  args: string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<CommandResult> {
  const result = await runDocker(['compose', ...args], options);
  if (result.code !== 0) {
    throw mapComposeFailure(result, `docker compose ${args.join(' ')} failed.`);
  }
  return result;
}
