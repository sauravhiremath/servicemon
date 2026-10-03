import { spawn } from 'node:child_process';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readInstance } from '../manager/instance.js';
import { processIdentity } from '../config/process-identity.js';
import { AppError } from '../shared/errors.js';
export interface ServeOptions { config: string; state: string; port?: number; ui?: string }
function failureFromLog(text: string): AppError | undefined {
  const lines = text.trim().split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^([A-Z][A-Z0-9_]*): (.*)$/.exec(lines[index] ?? '');
    if (match?.[1] && match[2]) return new AppError(match[1], match[2]);
  }
  return undefined;
}
export async function startBackground(options: ServeOptions, entry = fileURLToPath(new URL('./main.js', import.meta.url))): Promise<string> {
  await mkdir(options.state, { recursive: true, mode: 0o700 });
  const outputPath = join(options.state, 'manager.stdout.log');
  const errorPath = join(options.state, 'manager.stderr.log');
  const offset = await stat(errorPath).then(info => info.size).catch(() => 0);
  const output = await open(outputPath, 'a', 0o600);
  const errors = await open(errorPath, 'a', 0o600);
  const args = [entry, 'serve', '--config', options.config];
  if (options.port !== undefined) args.push('--port', String(options.port));
  if (options.ui) args.push('--ui', options.ui);
  const child = spawn(process.execPath, args, { detached: true, env: { ...process.env, SERVICEMON_STATE_DIR: options.state }, stdio: ['ignore', output.fd, errors.fd] });
  await output.close();
  await errors.close();
  let spawnError: Error | undefined;
  child.once('error', error => { spawnError = error; });
  const deadline = Date.now() + 30000;
  const absoluteConfig = resolve(options.config);
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw new AppError('MANAGER_UNAVAILABLE', 'Cannot start background manager.', spawnError.message);
      const record = await readInstance(options.state);
      if (record?.endpoint) {
        const identity = await processIdentity(record.pid);
        const live = identity.state === 'alive' && identity.startedAt === record.startedAt;
        if (live && resolve(record.configPath) === absoluteConfig) {
          child.unref();
          return record.endpoint;
        }
        if (live) throw new AppError('MANAGER_CONFLICT', 'A manager uses a different config.', { active: record.configPath });
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        const fresh = (await readFile(errorPath).catch(() => Buffer.alloc(0))).subarray(offset).toString('utf8');
        throw failureFromLog(fresh) ?? new AppError('MANAGER_UNAVAILABLE', 'Background startup failed. See manager.stderr.log.', { exitCode: child.exitCode, diagnostics: fresh.slice(-8192) });
      }
      await delay(100);
    }
    throw new AppError('MANAGER_UNAVAILABLE', 'Background startup did not complete before the deadline.', { diagnostics: errorPath });
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    throw error;
  }
}
