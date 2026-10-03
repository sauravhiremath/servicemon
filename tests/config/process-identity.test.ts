import type * as ChildProcess from 'node:child_process';
import { expect, it, vi } from 'vitest';
import { ownStartedAt } from '../../src/config/process-identity.js';

const state = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: state.execFile }));

it('reads this process start time again after a failed lookup', async () => {
  const actual = await vi.importActual<typeof ChildProcess>('node:child_process');
  state.execFile.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (error: NodeJS.ErrnoException, stdout: string) => void;
    callback(Object.assign(new Error('ps failed'), { status: 1 }), '');
  });
  state.execFile.mockImplementation((...args: unknown[]) =>
    actual.execFile(...(args as Parameters<typeof actual.execFile>)),
  );
  await expect(ownStartedAt()).rejects.toMatchObject({ code: 'OWNERSHIP_CONFLICT' });
  await expect(ownStartedAt()).resolves.toMatch(/\d/);
});
