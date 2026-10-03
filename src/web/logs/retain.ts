import type { LogHistory, LogRecord } from '../../shared/types.js';

const CLIENT_LOG_RECORD_LIMIT = 2000;
const CLIENT_LOG_CHAR_LIMIT = 512_000;
const LIVE_LOG_BUFFER_LIMIT = 500;
export const HISTORY_TAIL = 500;

export type RetainedLogs = {
  records: LogRecord[];
  cursor: number;
  gap: boolean;
  trimmed: boolean;
  error?: string;
};

export function recordKey(record: LogRecord): string {
  return `${record.runId}:${record.sequence}`;
}

export function rememberLive(buffer: Map<string, LogRecord[]>, record: LogRecord): void {
  const current = buffer.get(record.entryId) ?? [];
  if (current.some((item) => recordKey(item) === recordKey(record))) {
    return;
  }
  current.push(record);
  current.sort((left, right) => left.sequence - right.sequence);
  while (current.length > LIVE_LOG_BUFFER_LIMIT) {
    current.shift();
  }
  buffer.set(record.entryId, current);
}

export function joinHistory(history: LogHistory, buffered: readonly LogRecord[]): RetainedLogs {
  const seen = new Set(history.records.map(recordKey));
  const extra = buffered.filter(
    (record) =>
      record.stream !== 'gap' && record.sequence > history.cursor && !seen.has(recordKey(record)),
  );
  return trimRecords(
    [...history.records, ...extra].sort((left, right) => left.sequence - right.sequence),
    history.gap,
    history.error,
  );
}

export function appendLive(current: RetainedLogs, record: LogRecord): RetainedLogs | 'gap' {
  if (record.stream === 'gap') {
    return 'gap';
  }
  if (
    current.records.some((item) => recordKey(item) === recordKey(record)) ||
    record.sequence <= current.cursor
  ) {
    return current;
  }
  if (
    record.sequence !== current.cursor + 1 &&
    !(current.records.length === 0 && record.sequence === 1)
  ) {
    return 'gap';
  }
  return trimRecords([...current.records, record], current.gap, current.error);
}

function trimRecords(records: LogRecord[], gap: boolean, error?: string): RetainedLogs {
  let next = records;
  let trimmed = false;
  while (next.length > CLIENT_LOG_RECORD_LIMIT) {
    next = next.slice(next.length - CLIENT_LOG_RECORD_LIMIT);
    trimmed = true;
  }
  let chars = next.reduce((sum, record) => sum + record.text.length, 0);
  while (next.length > 1 && chars > CLIENT_LOG_CHAR_LIMIT) {
    chars -= next[0]?.text.length ?? 0;
    next = next.slice(1);
    trimmed = true;
  }
  const cursor = next.length ? next[next.length - 1]!.sequence : 0;
  return { records: next, cursor, gap, trimmed, error };
}
