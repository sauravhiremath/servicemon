import { expect, it } from 'vitest';
import type { LogHistory, LogRecord } from '../../src/shared/types.js';
import { appendLive, joinHistory, type RetainedLogs } from '../../src/web/logs/retain.js';

const empty: RetainedLogs = { records: [], cursor: 0, gap: false, trimmed: false };

function record(text: string, sequence: number, stream: LogRecord['stream'] = 'stdout'): LogRecord {
  return {
    entryId: 'proj/api',
    runId: 'run-1',
    sequence,
    stream,
    text,
    timestamp: '2026-10-03T00:00:00.000Z',
  };
}

it('reloads instead of storing a live gap or a record that skips the start', () => {
  const gap: LogRecord = {
    entryId: 'proj/api',
    runId: '',
    sequence: 42,
    stream: 'gap',
    text: '',
    timestamp: '2026-10-03T00:00:00.000Z',
  };
  expect(appendLive(empty, gap)).toBe('gap');
  expect(appendLive(empty, record('late', 5))).toBe('gap');
  const first = appendLive(empty, record('one', 1));
  expect(first).toMatchObject({ cursor: 1, records: [expect.objectContaining({ text: 'one' })] });
});

it('reloads a live record that is not the next sequence and ignores a duplicate', () => {
  const current: RetainedLogs = {
    records: [record('one', 1), record('two', 2)],
    cursor: 2,
    gap: false,
    trimmed: false,
  };
  expect(appendLive(current, record('two', 2))).toBe(current);
  expect(appendLive(current, record('three', 3))).toMatchObject({
    cursor: 3,
    records: [...current.records, record('three', 3)],
  });
  expect(appendLive(current, record('missing', 4))).toBe('gap');
});

it('does not let a buffered gap record hide the next retained line', () => {
  const history: LogHistory = {
    records: [record('one', 1), record('two', 2)],
    cursor: 2,
    oldestCursor: 1,
    gap: false,
  };
  const gap: LogRecord = {
    entryId: 'proj/api',
    runId: '',
    sequence: 42,
    stream: 'gap',
    text: '',
    timestamp: '2026-10-03T00:00:00.000Z',
  };
  const joined = joinHistory(history, [gap, record('two', 2), record('three', 3)]);
  expect(joined.gap).toBe(false);
  const next = appendLive(joined, record('four', 4));
  expect(next).toMatchObject({ cursor: 4 });
  if (next === 'gap') {
    throw new Error('The next retained line was treated as a gap.');
  }
  expect(next.records.map((item) => item.text)).toEqual(['one', 'two', 'three', 'four']);
});
