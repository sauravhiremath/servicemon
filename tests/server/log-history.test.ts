import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LogStore } from '../../src/logs/store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it('returns no records for tail 0 and keeps the cursor at the latest selected record', async () => {
  const directory = await tempDir();
  const store = new LogStore(directory, { perEntryBytes: 10_000, totalBytes: 10_000 });
  store.append('proj/api', 'run-1', 'stdout', 'one');
  store.append('proj/api', 'run-1', 'stdout', 'two');
  const last = store.append('proj/api', 'run-1', 'stdout', 'three');
  const tail = store.history('proj/api', { tail: 0 });
  const followed = store.history('proj/api', { after: tail.cursor });
  expect(tail.records).toEqual([]);
  expect(tail.cursor).toBe(last.sequence);
  expect(tail.gap).toBe(false);
  expect(followed.records).toEqual([]);
  expect(store.history('proj/api', { tail: 1 }).records.map((record) => record.text)).toEqual([
    'three',
  ]);
  expect(store.history('proj/api', { after: 1, tail: 0 })).toMatchObject({
    records: [],
    cursor: last.sequence,
    gap: false,
  });
  store.close();
  const reopened = new LogStore(directory, { perEntryBytes: 10_000, totalBytes: 10_000 });
  expect(reopened.history('proj/api', { tail: 0 }).cursor).toBe(last.sequence);
  reopened.close();
});

it('does not publish a live gap ahead of the next retained record', async () => {
  const directory = await tempDir();
  const store = new LogStore(directory, { perEntryBytes: 100_000, totalBytes: 100_000 });
  const seen: { stream: string; sequence: number }[] = [];
  store.subscribe('proj/api', (record) =>
    seen.push({ stream: record.stream, sequence: record.sequence }),
  );
  for (let index = 0; index < 40; index += 1) {
    store.append('proj/api', 'run-1', 'stdout', `line-${index}`);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  const history = store.history('proj/api');
  const gap = seen.find((record) => record.stream === 'gap');
  const next = store.append('proj/api', 'run-1', 'stdout', 'after-burst');
  expect(history.records).toHaveLength(40);
  expect(gap).toBeDefined();
  expect(gap!.sequence).toBeLessThanOrEqual(history.cursor);
  expect(gap!.sequence).not.toBe(next.sequence);
  expect(next.sequence).toBe(history.cursor + 1);
  store.close();
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'servicemon-log-history-'));
  directories.push(directory);
  return directory;
}
