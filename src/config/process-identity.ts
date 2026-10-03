import { execFile } from 'node:child_process';
import { AppError } from '../shared/errors.js';

export type ProcessIdentity =
  | { state: 'alive'; startedAt: string }
  | { state: 'dead' }
  | { state: 'uncertain' };

export function processIdentity(pid: number): Promise<ProcessIdentity> {
  const { promise, resolve } = Promise.withResolvers<ProcessIdentity>();
  execFile('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { timeout: 2000 }, (error, stdout) => {
    if (!error) {
      const startedAt = stdout.trim();
      resolve(startedAt ? { state: 'alive', startedAt } : { state: 'dead' });
      return;
    }
    const status = 'status' in error && typeof error.status === 'number' ? error.status : undefined;
    const code = 'code' in error ? error.code : undefined;
    resolve(status === 1 || code === 1 || code === '1' ? { state: 'dead' } : { state: 'uncertain' });
  });
  return promise;
}

let ownStart: Promise<string> | undefined;

export function ownStartedAt(): Promise<string> {
  if (ownStart) return ownStart;
  ownStart = processIdentity(process.pid).then(identity => {
    if (identity.state !== 'alive') throw new AppError('OWNERSHIP_CONFLICT', 'Cannot read this process start time.');
    return identity.startedAt;
  }).catch(error => {
    ownStart = undefined;
    throw error;
  });
  return ownStart;
}
