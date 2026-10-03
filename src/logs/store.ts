import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { LogHistory, LogRecord } from '../shared/types.js';
import { truncateUtf8 } from './decoder.js';

export interface LogLimits {
  perEntryBytes: number;
  totalBytes: number;
}

interface Segment {
  name: string;
  bytes: number;
  first: number;
  last: number;
  startedAt: string;
}

interface EntryMeta {
  nextSequence: number;
  segments: Segment[];
}

interface Subscriber {
  entryId: string;
  listener: (record: LogRecord) => void;
  queue: LogRecord[];
  scheduled: boolean;
  gapped: boolean;
  closed: boolean;
}

const SEGMENT_CAP = 1_048_576;
const QUEUE_LIMIT = 32;
const LIVE_RECORD_LIMIT = 200;

export class LogStore {
  private readonly root: string;
  private limits: LogLimits;
  private readonly metas = new Map<string, EntryMeta>();
  private readonly live = new Map<string, LogRecord[]>();
  private readonly subscribers = new Map<string, Set<Subscriber>>();
  private persistenceError?: string;
  private closed = false;

  constructor(stateDir: string, limits: LogLimits) {
    this.root = join(stateDir, 'logs');
    this.limits = normalizeLimits(limits);
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
    } catch (error) {
      this.persistenceError = persistenceMessage(error);
    }
  }

  append(
    entryId: string,
    runId: string,
    stream: LogRecord['stream'],
    text: string,
    containerId?: string,
  ): LogRecord {
    if (this.closed) {
      throw new Error('Log store is closed.');
    }
    const meta = this.meta(entryId);
    const capped = truncateUtf8(
      text,
      Math.max(1, Math.min(this.limits.perEntryBytes, this.limits.totalBytes)),
    );
    const record: LogRecord = {
      entryId,
      runId,
      sequence: meta.nextSequence,
      timestamp: new Date().toISOString(),
      stream,
      text: capped,
      ...(containerId ? { containerId } : {}),
    };
    meta.nextSequence += 1;
    this.remember(record);
    this.persist(entryId, meta, record);
    this.notify(record);
    return record;
  }

  history(entryId: string, query: { after?: number; tail?: number } = {}): LogHistory {
    const meta = this.metas.get(entryId) ?? this.readMeta(entryId);
    const retained = this.readRetained(entryId, meta);
    const oldest = retained[0]?.sequence ?? 0;
    let gap = false;
    let records = retained;
    if (query.after !== undefined) {
      const floor = retained[0]?.sequence ?? meta.nextSequence;
      gap = query.after + 1 < floor && floor > 1;
      records = retained.filter((record) => record.sequence > query.after!);
    }
    // Array.slice treats -0 as 0, so tail 0 must not use it. An empty tail still ends at the latest selected record.
    const selectedEnd = records.at(-1)?.sequence;
    if (query.tail !== undefined) {
      records = query.tail === 0 ? [] : records.slice(-query.tail);
    }
    const cursor =
      records.at(-1)?.sequence ??
      (query.tail === 0 ? selectedEnd : undefined) ??
      query.after ??
      retained.at(-1)?.sequence ??
      0;
    return {
      records,
      cursor,
      oldestCursor: oldest,
      gap,
      ...(this.persistenceError ? { error: this.persistenceError } : {}),
    };
  }

  subscribe(entryId: string, listener: (record: LogRecord) => void): () => void {
    const subscriber: Subscriber = {
      entryId,
      listener,
      queue: [],
      scheduled: false,
      gapped: false,
      closed: false,
    };
    const set = this.subscribers.get(entryId) ?? new Set<Subscriber>();
    set.add(subscriber);
    this.subscribers.set(entryId, set);
    return () => {
      subscriber.closed = true;
      set.delete(subscriber);
    };
  }

  setLimits(limits: LogLimits): void {
    this.limits = normalizeLimits(limits);
    for (const entryId of this.knownIds()) {
      this.evict(entryId);
    }
  }

  close(): void {
    this.closed = true;
    for (const set of this.subscribers.values()) {
      for (const subscriber of set) {
        subscriber.closed = true;
      }
    }
    this.subscribers.clear();
  }

  private persist(entryId: string, meta: EntryMeta, record: LogRecord): void {
    if (this.persistenceError && !this.directoryReady()) {
      return;
    }
    try {
      const dir = this.entryDir(entryId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const line = `${JSON.stringify(record)}\n`;
      const bytes = Buffer.byteLength(line);
      const cap = Math.max(1, Math.min(this.limits.perEntryBytes, SEGMENT_CAP));
      let segment = meta.segments.at(-1);
      if (!segment || segment.bytes + bytes > cap) {
        segment = {
          name: `${String(record.sequence).padStart(6, '0')}.jsonl`,
          bytes: 0,
          first: record.sequence,
          last: record.sequence,
          startedAt: record.timestamp,
        };
        meta.segments.push(segment);
      }
      appendFileSync(join(dir, segment.name), line, { mode: 0o600 });
      segment.bytes += bytes;
      segment.last = record.sequence;
      this.evict(entryId);
      this.writeMeta(entryId, meta);
    } catch (error) {
      this.persistenceError = persistenceMessage(error);
    }
  }

  private evict(entryId: string): void {
    const meta = this.meta(entryId);
    while (meta.segments.length > 0 && this.entryBytes(meta) > this.limits.perEntryBytes) {
      this.deleteSegment(entryId, meta, 0);
    }
    while (this.totalBytes() > this.limits.totalBytes) {
      const oldest = this.oldestSegment();
      if (!oldest) {
        break;
      }
      this.deleteSegment(oldest.entryId, this.meta(oldest.entryId), oldest.index);
    }
    this.writeMeta(entryId, meta);
  }

  private deleteSegment(entryId: string, meta: EntryMeta, index: number): void {
    const segment = meta.segments[index];
    if (!segment) {
      return;
    }
    meta.segments.splice(index, 1);
    try {
      rmSync(join(this.entryDir(entryId), segment.name), { force: true });
      this.writeMeta(entryId, meta);
    } catch (error) {
      this.persistenceError = persistenceMessage(error);
    }
  }

  private readRetained(entryId: string, meta: EntryMeta): LogRecord[] {
    const fromDisk: LogRecord[] = [];
    if (!this.persistenceError || this.directoryReady()) {
      try {
        for (const segment of meta.segments) {
          const text = readFileSync(join(this.entryDir(entryId), segment.name), 'utf8');
          for (const line of text.split('\n')) {
            if (!line) {
              continue;
            }
            try {
              fromDisk.push(JSON.parse(line) as LogRecord);
            } catch {
              continue;
            }
          }
        }
      } catch (error) {
        this.persistenceError = persistenceMessage(error);
      }
    }
    const seen = new Set(fromDisk.map((record) => record.sequence));
    const extra = this.persistenceError
      ? (this.live.get(entryId) ?? []).filter((record) => !seen.has(record.sequence))
      : [];
    return [...fromDisk, ...extra].sort((left, right) => left.sequence - right.sequence);
  }

  private remember(record: LogRecord): void {
    const current = this.live.get(record.entryId) ?? [];
    current.push(record);
    while (current.length > LIVE_RECORD_LIMIT) {
      current.shift();
    }
    this.live.set(record.entryId, current);
  }

  private notify(record: LogRecord): void {
    const set = this.subscribers.get(record.entryId);
    if (!set) {
      return;
    }
    for (const subscriber of set) {
      this.enqueue(subscriber, record);
    }
  }

  private enqueue(subscriber: Subscriber, record: LogRecord): void {
    if (subscriber.closed || subscriber.gapped) {
      return;
    }
    if (subscriber.queue.length >= QUEUE_LIMIT) {
      subscriber.queue.length = 0;
      subscriber.gapped = true;
      return;
    }
    subscriber.queue.push(record);
    this.pump(subscriber);
  }

  private pump(subscriber: Subscriber): void {
    if (subscriber.scheduled || subscriber.closed) {
      return;
    }
    subscriber.scheduled = true;
    setImmediate(() => {
      subscriber.scheduled = false;
      if (subscriber.closed) {
        return;
      }
      const gapped = subscriber.gapped;
      subscriber.gapped = false;
      const batch = subscriber.queue.splice(0);
      if (gapped) {
        this.emit(subscriber, this.gapRecord(subscriber.entryId));
      }
      for (const record of batch) {
        this.emit(subscriber, record);
      }
      if (!subscriber.closed && (subscriber.queue.length > 0 || subscriber.gapped)) {
        this.pump(subscriber);
      }
    });
  }

  private emit(subscriber: Subscriber, record: LogRecord): void {
    try {
      subscriber.listener(record);
    } catch {
      // A subscriber error must not stop output capture.
    }
  }

  private gapRecord(entryId: string): LogRecord {
    // Sequence 0 cannot collide with a later record. Callers reload history instead of storing this marker.
    return {
      entryId,
      runId: '',
      sequence: 0,
      timestamp: new Date().toISOString(),
      stream: 'gap',
      text: '',
    };
  }

  private meta(entryId: string): EntryMeta {
    const cached = this.metas.get(entryId);
    if (cached) {
      return cached;
    }
    const loaded = this.readMeta(entryId);
    this.metas.set(entryId, loaded);
    return loaded;
  }

  private readMeta(entryId: string): EntryMeta {
    try {
      const parsed = JSON.parse(
        readFileSync(join(this.entryDir(entryId), 'meta.json'), 'utf8'),
      ) as EntryMeta;
      if (!Array.isArray(parsed.segments) || typeof parsed.nextSequence !== 'number') {
        return { nextSequence: 1, segments: [] };
      }
      return parsed;
    } catch {
      return { nextSequence: 1, segments: [] };
    }
  }

  private writeMeta(entryId: string, meta: EntryMeta): void {
    const path = join(this.entryDir(entryId), 'meta.json');
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(meta), { mode: 0o600 });
    renameSync(temporary, path);
  }

  private entryDir(entryId: string): string {
    return join(this.root, encodeURIComponent(entryId));
  }

  private entryBytes(meta: EntryMeta): number {
    return meta.segments.reduce((sum, segment) => sum + segment.bytes, 0);
  }

  private totalBytes(): number {
    let total = 0;
    for (const entryId of this.knownIds()) {
      total += this.entryBytes(this.meta(entryId));
    }
    return total;
  }

  private knownIds(): string[] {
    const ids = new Set(this.metas.keys());
    try {
      for (const name of readdirSync(this.root)) {
        ids.add(decodeURIComponent(name));
      }
    } catch {
      // Missing log root means there is no retained data.
    }
    return [...ids];
  }

  private oldestSegment(): { entryId: string; index: number; startedAt: string } | null {
    let oldest: { entryId: string; index: number; startedAt: string } | null = null;
    for (const entryId of this.knownIds()) {
      const meta = this.meta(entryId);
      meta.segments.forEach((segment, index) => {
        if (!oldest || segment.startedAt < oldest.startedAt) {
          oldest = { entryId, index, startedAt: segment.startedAt };
        }
      });
    }
    return oldest;
  }

  private directoryReady(): boolean {
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      return true;
    } catch {
      return false;
    }
  }
}

function normalizeLimits(limits: LogLimits): LogLimits {
  return {
    perEntryBytes: Math.max(1, Math.floor(limits.perEntryBytes)),
    totalBytes: Math.max(1, Math.floor(limits.totalBytes)),
  };
}

function persistenceMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Log persistence failed. Live capture continues. ${detail}`;
}
