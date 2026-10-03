import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { acquireInstance, readInstance, writeInstance } from '../../src/manager/instance.js';

const exec = promisify(execFile);

describe('manager instance', () => {
  it('keeps one owner, reuses the same config, and conflicts on another config', async () => {
    const state = await mkdtemp(path.join(tmpdir(), 'servicemon-instance-'));
    const first = await acquireInstance(state, 'one.yaml');
    first.record.endpoint = 'http://127.0.0.1:7331';
    await writeInstance(state, first.record);
    const second = await acquireInstance(state, path.resolve('one.yaml'));
    expect(second.owned).toBe(false);
    expect(second.record.endpoint).toBe('http://127.0.0.1:7331');
    expect(second.record.token).toBe(first.record.token);
    await second.release();
    expect(await readInstance(state)).toMatchObject({ token: first.record.token, pid: process.pid });
    await expect(acquireInstance(state, 'other.yaml')).rejects.toMatchObject({ code: 'MANAGER_CONFLICT' });
    expect((await readInstance(state))?.configPath).toBe(first.record.configPath);
    await first.release();
    expect(await readInstance(state)).toBeUndefined();
  });

  it('waits for the owner to publish an endpoint during competing startup', async () => {
    const state = await mkdtemp(path.join(tmpdir(), 'servicemon-competing-'));
    const first = await acquireInstance(state, 'one.yaml');
    const second = acquireInstance(state, 'one.yaml');
    await new Promise(resolve => setTimeout(resolve, 100));
    first.record.endpoint = 'http://127.0.0.1:7332';
    await writeInstance(state, first.record);
    expect(await second).toMatchObject({ owned: false, record: { endpoint: first.record.endpoint, token: first.record.token } });
    await first.release();
    await rm(state, { recursive: true, force: true });
  });

  it('does not delete a lock while its owner is still writing it', async () => {
    const state = await mkdtemp(path.join(tmpdir(), 'servicemon-lock-writing-'));
    const first = await acquireInstance(state, 'one.yaml');
    const file = path.join(state, 'manager.lock');
    const complete = await readFile(file, 'utf8');
    await writeFile(file, '');
    const second = acquireInstance(state, 'one.yaml');
    await new Promise(resolve => setTimeout(resolve, 100));
    await writeFile(file, complete);
    first.record.endpoint = 'http://127.0.0.1:7333';
    await writeInstance(state, first.record);
    expect(await second).toMatchObject({ owned: false, record: { token: first.record.token } });
    await first.release();
    await rm(state, { recursive: true, force: true });
  });

  it('replaces a dead or reused identity without signalling that process', async () => {
    const state = await mkdtemp(path.join(tmpdir(), 'servicemon-stale-'));
    await writeFile(path.join(state, 'manager.lock'), JSON.stringify({ pid: 1, startedAt: 'not-the-launchd-start', token: 'old', configPath: '/other.yaml' }));
    await writeFile(path.join(state, 'instance.json'), JSON.stringify({ configPath: '/other.yaml', endpoint: 'http://old', pid: 1, startedAt: 'not-the-launchd-start', token: 'old' }));
    const acquired = await acquireInstance(state, '/fresh.yaml');
    expect(acquired.owned).toBe(true);
    expect(acquired.record.pid).toBe(process.pid);
    expect(acquired.record.token).not.toBe('old');
    const launchd = await exec('/bin/ps', ['-p', '1', '-o', 'pid=']);
    expect(launchd.stdout.trim()).toBe('1');
    await acquired.release();
    await writeFile(path.join(state, 'manager.lock'), JSON.stringify({ pid: 2_147_483_646, startedAt: 'dead', token: 'dead', configPath: '/dead.yaml' }));
    const replacement = await acquireInstance(state, '/after-dead.yaml');
    expect(replacement.owned).toBe(true);
    expect(replacement.record.configPath).toBe('/after-dead.yaml');
    const info = await stat(path.join(state, 'instance.json'));
    expect(info.mode & 0o777).toBe(0o600);
    expect((await stat(state)).mode & 0o777).toBe(0o700);
    await expect(writeInstance(state, { ...replacement.record, token: 'other' })).rejects.toMatchObject({ code: 'OWNERSHIP_CONFLICT' });
    await writeInstance(state, { ...replacement.record, endpoint: 'http://127.0.0.1:7331' });
    expect(await readInstance(state)).toMatchObject({ endpoint: 'http://127.0.0.1:7331' });
    await replacement.release();
    await rm(state, { recursive: true, force: true });
  });

  it('replaces an unreadable lock after the writer is gone', async () => {
    const state = await mkdtemp(path.join(tmpdir(), 'servicemon-garbled-lock-'));
    const file = path.join(state, 'manager.lock');
    await writeFile(file, '{');
    const old = new Date(Date.now() - 10_000);
    await utimes(file, old, old);
    const acquired = await acquireInstance(state, '/fresh.yaml');
    expect(acquired.owned).toBe(true);
    expect(acquired.record.configPath).toBe('/fresh.yaml');
    await acquired.release();
    await rm(state, { recursive: true, force: true });
  });
});
