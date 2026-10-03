import type { LogRecord } from '../../shared/types.js';
import { recordKey } from './retain.js';

export type ReadingAnchor = { key: string; offset: number };
export type DisplayLine = {
  key: string;
  record: LogRecord;
  index: number;
  time: string;
  container: string;
  message: string;
  text: string;
};
export type Match = { key: string; lineKey: string; start: number; end: number };
export function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour12: false });
}
export function displayLines(records: readonly LogRecord[]): DisplayLine[] {
  return records.flatMap((record) => {
    const messages = (
      record.text || (record.stream === 'gap' ? 'Log history has a gap.' : '')
    ).split('\n');
    if (messages.length > 1 && messages.at(-1) === '') {
      messages.pop();
    }
    const time = formatTime(record.timestamp);
    const container = record.containerId ? `[${record.containerId}] ` : '';
    return messages.map((message, index) => ({
      key: `${recordKey(record)}:${index}`,
      record,
      index,
      time,
      container,
      message,
      text: `${time} ${container}${message}`,
    }));
  });
}
export function findMatches(lines: readonly DisplayLine[], query: string): Match[] {
  if (!query) {
    return [];
  }
  const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  const matches: Match[] = [];
  for (const line of lines) {
    for (const occurrence of line.text.matchAll(literal)) {
      const start = occurrence.index;
      matches.push({
        key: `${line.key}:${start}`,
        lineKey: line.key,
        start,
        end: start + occurrence[0].length,
      });
    }
  }
  return matches;
}
export function filterRecords(records: readonly LogRecord[], query: string): LogRecord[] {
  if (!query) {
    return [...records];
  }
  const keys = new Set(
    findMatches(displayLines(records), query).map((match) =>
      match.lineKey.slice(0, match.lineKey.lastIndexOf(':')),
    ),
  );
  return records.filter(
    (record) =>
      record.stream === 'boundary' || record.stream === 'gap' || keys.has(recordKey(record)),
  );
}
export function responseTokens(
  text: string,
): { start: number; end: number; kind: 'warning' | 'error' }[] {
  const patterns = [
    /\bHTTP\/\d(?:\.\d)?\s+([45]\d{2})(?=\s|$)/g,
    /(?:^|[\s,{])(?:["']?(?:http[_-]?status|status(?:Code|_code)?)["']?)\s*[:=]\s*["']?([45]\d{2})(?=["']?(?:[\s,}]|$))/gi,
    /^\s*-->\s+(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s+\S+\s+([45]\d{2})(?=\s|$)/g,
  ];
  const tokens = new Map<number, { start: number; end: number; kind: 'warning' | 'error' }>();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const code = match[1]!;
      const start = match.index + match[0].lastIndexOf(code);
      tokens.set(start, { start, end: start + 3, kind: code[0] === '5' ? 'error' : 'warning' });
    }
  }
  return [...tokens.values()].sort((a, b) => a.start - b.start);
}
export function explicitSeverity(text: string): 'error' | 'warning' | null {
  const line = text.trim().replace(/^\d{4}-\d{2}-\d{2}[T ]\S+\s+/, '');
  const token = /^\[([^\]]+)\]/.exec(line)?.[1]?.trim() ?? '';
  if (/^(?:fatal|error|err|critical)$/i.test(token)) {
    return 'error';
  }
  if (/^(?:warn|warning)$/i.test(token)) {
    return 'warning';
  }
  if (
    /^(?:FATAL|ERROR|ERR|CRITICAL)\b/.test(line) ||
    /^(?:error|err|fatal|critical)\s*:/i.test(line)
  ) {
    return 'error';
  }
  if (/^(?:WARN|WARNING)\b/.test(line) || /^(?:warn|warning)\s*:/i.test(line)) {
    return 'warning';
  }
  if (
    /(?:^|[\s,{])["']?(?:level|lvl|severity)["']?\s*[:=]\s*["']?(?:fatal|error|err|critical)["']?(?=$|[\s,}\]])/i.test(
      line,
    )
  ) {
    return 'error';
  }
  if (
    /(?:^|[\s,{])["']?(?:level|lvl|severity)["']?\s*[:=]\s*["']?(?:warn|warning)["']?(?=$|[\s,}\]])/i.test(
      line,
    )
  ) {
    return 'warning';
  }
  return null;
}
