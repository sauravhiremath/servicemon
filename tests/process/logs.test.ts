import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StreamDecoder } from '../../src/logs/decoder.js';
import { LogStore } from '../../src/logs/store.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('stream decoder', () => {
  it('keeps split UTF-8 characters whole and bounds chunks without a newline', () => {
    const decoder = new StreamDecoder(8);
    expect(decoder.push(Buffer.from([0xe2, 0x82]))).toEqual([]);
    expect(decoder.push(Buffer.from([0xac, 0x61]))).toEqual(['€a']);
    const chunks = decoder.push(Buffer.from('abcdefghij'));
    expect(chunks.join('')).toBe('abcdefghij');
    expect(chunks.every((chunk) => Buffer.byteLength(chunk) <= 8)).toBe(true);
    expect(decoder.flush()).toEqual([]);
  });
});

describe('log store', () => {
  it('retains history across store restarts and reports a gap for an old cursor', async () => {
    const directory = await tempDir();
    const first = new LogStore(directory, { perEntryBytes: 1000, totalBytes: 2000 });
    first.append('proj/api', 'run-1', 'stdout', 'a'.repeat(600));
    const second = first.append('proj/api', 'run-1', 'stdout', 'b'.repeat(600));
    first.close();
    const reopened = new LogStore(directory, { perEntryBytes: 1000, totalBytes: 2000 });
    const history = reopened.history('proj/api', { after: 0 });
    expect(history.records.map((record) => record.text)).toEqual(['b'.repeat(600)]);
    expect(history.gap).toBe(true);
    expect(history.oldestCursor).toBe(second.sequence);
    expect(history.cursor).toBe(second.sequence);
    reopened.close();
  });

  it('applies the total limit to logs from another entry', async () => {
    const directory = await tempDir();
    const store = new LogStore(directory, { perEntryBytes: 1000, totalBytes: 1000 });
    store.append('proj/old', 'run-1', 'stdout', '1'.repeat(600));
    store.append('proj/new', 'run-2', 'stderr', '2'.repeat(600));
    const old = store.history('proj/old', { after: 0 });
    const current = store.history('proj/new');
    expect(old.gap).toBe(true);
    expect(old.records).toEqual([]);
    expect(current.records.map((record) => record.text)).toEqual(['2'.repeat(600)]);
    expect(current.records[0]?.stream).toBe('stderr');
    store.close();
  });

  it('defers subscriber delivery and retains history when live delivery overflows', async () => {
    const directory = await tempDir();
    const store = new LogStore(directory, { perEntryBytes: 100_000, totalBytes: 100_000 });
    try {
      const seen: string[] = [];
      store.subscribe('proj/api', (record) => seen.push(record.stream));
      const messages = Array.from({ length: 100 }, (_, index) => String(index));
      for (const message of messages) {
        store.append('proj/api', 'run-1', 'stdout', message);
      }
      expect(seen).toEqual([]);
      await flush();
      expect(seen).toEqual(['gap']);
      expect(store.history('proj/api').records.map((record) => record.text)).toEqual(messages);

      store.append('proj/api', 'run-1', 'stdout', 'after gap');
      expect(seen).toEqual(['gap']);
      await flush();
      expect(seen).toEqual(['gap', 'stdout']);
      expect(store.history('proj/api').records.map((record) => record.text)).toEqual([
        ...messages,
        'after gap',
      ]);
    } finally {
      store.close();
    }
  });

  it('does not duplicate records when history resumes at the live cursor', async () => {
    const directory = await tempDir();
    const store = new LogStore(directory, { perEntryBytes: 10_000, totalBytes: 10_000 });
    const live: number[] = [];
    store.subscribe('proj/api', (record) => {
      if (record.stream !== 'gap') {
        live.push(record.sequence);
      }
    });
    store.append('proj/api', 'run-1', 'boundary', 'run started');
    store.append('proj/api', 'run-1', 'stdout', 'one');
    const history = store.history('proj/api');
    store.append('proj/api', 'run-1', 'stdout', 'two');
    await flush();
    const next = store.history('proj/api', { after: history.cursor });
    const sequences = [...history.records, ...next.records].map((record) => record.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(next.records.map((record) => record.text)).toEqual(['two']);
    expect(
      live
        .filter((sequence) => sequence <= history.cursor)
        .every((sequence) => history.records.some((record) => record.sequence === sequence)),
    ).toBe(true);
    store.close();
  });

  it('keeps a bounded live buffer when the log directory cannot be created', async () => {
    const directory = await tempDir();
    const blocked = join(directory, 'not-a-directory');
    await writeFile(blocked, 'x');
    const store = new LogStore(blocked, { perEntryBytes: 100, totalBytes: 100 });
    store.append('proj/api', 'run-1', 'stdout', 'kept');
    const history = store.history('proj/api');
    expect(history.error).toContain('Log persistence failed');
    expect(history.records.map((record) => record.text)).toEqual(['kept']);
    store.close();
  });
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'servicemon-logs-'));
  directories.push(directory);
  return directory;
}

function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}
