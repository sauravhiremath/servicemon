import { describe, expect, it } from 'vitest';
import type { LogRecord } from '../../src/shared/types.js';
import {
  displayLines,
  findMatches,
  filterRecords,
  responseTokens,
  explicitSeverity,
  formatTime,
} from '../../src/web/logs/view.js';

const record = (text: string, sequence = 1, stream: LogRecord['stream'] = 'stdout'): LogRecord => ({
  entryId: 'one',
  runId: 'run',
  sequence,
  stream,
  text,
  timestamp: 'invalid-time',
});
describe('log view', () => {
  it('finds literal repeated occurrences in displayed fields only', () => {
    const lines = displayLines([record('A.b a.B\ncontext')]);
    expect(findMatches(lines, 'a.b').map((m) => [m.lineKey, m.start, m.end])).toEqual([
      [lines[0]!.key, 13, 16],
      [lines[0]!.key, 17, 20],
    ]);
    expect(findMatches(lines, 'stdout')).toEqual([]);
    expect(formatTime('invalid-time')).toBe('invalid-time');
  });
  it('keeps raw offsets when case conversion changes a Unicode character length', () => {
    const lines = displayLines([record('İ before Needle')]);
    const match = findMatches(lines, 'needle')[0]!;
    expect(lines[0]!.text.slice(match.start, match.end)).toBe('Needle');
  });
  it('filters complete multiline records but preserves run and gap records', () => {
    const records = [
      record('start', 1, 'boundary'),
      record('first\nneedle', 2),
      record('other', 3),
      record('lost', 4, 'gap'),
    ];
    expect(filterRecords(records, 'needle')).toEqual([records[0], records[1], records[3]]);
  });
  it('only colors explicit response statuses', () => {
    for (const text of [
      '--> GET /path 404 2ms',
      'HTTP/1.1 503 Service Unavailable',
      'status=500',
    ]) {
      const tokens = responseTokens(text);
      expect(tokens).toHaveLength(1);
      expect(text.slice(tokens[0]!.start, tokens[0]!.end)).toMatch(/^(404|503|500)$/);
    }
    for (const text of [
      '<-- GET /path 500',
      'request id 500',
      'GET /path request-id=404',
      'count=503',
      '--> GET /path 200 2ms',
      '--> GET /path 302 2ms',
      'status=5000',
    ]) {
      expect(responseTokens(text)).toEqual([]);
    }
    expect(explicitSeverity('routine error in stderr')).toBeNull();
    expect(explicitSeverity('ERROR: failed')).toBe('error');
    expect(explicitSeverity('WARNING: retry')).toBe('warning');
  });
});
