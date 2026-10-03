import { createHash, randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import type {
  ComposeGroup,
  Entry,
  EntryState,
  EntryStatus,
  ExitDetails,
  Health,
  LogHistory,
  Adapter,
} from '../shared/types.js';
import { dockerCompose, mapComposeFailure, runDocker, sameEnv } from './command.js';
import { composeArgs, readGroupConfig, replicaCount, serviceHasHealthcheck } from './discovery.js';

export interface ComposeContainer {
  id: string;
  name: string;
  service: string;
  state: string;
  health: string;
  exitCode: number;
  number: number;
}
interface Observed {
  state: EntryState;
  health: Health;
  containers?: ComposeContainer[];
  runId?: string;
  exit?: ExitDetails;
  stopping?: boolean;
}
interface PsRow {
  ID?: string;
  Name?: string;
  Service?: string;
  State?: string;
  Health?: string;
  ExitCode?: number;
  Labels?: string;
  Project?: string;
}
export interface ComposeHistoryLine {
  timestamp: string;
  stream: 'stdout' | 'stderr';
  text: string;
  containerId: string;
}
export interface ComposeHistoryCursor {
  offset: number;
  count: number;
  digest: string;
}

const OBSERVE_MS = 1000;

export class ComposeAdapter implements Adapter {
  private entries: Entry[];
  private groups: ComposeGroup[];
  private environment: NodeJS.ProcessEnv;
  private observed = new Map<string, Observed>();
  private discoveries = new Map<string, Record<string, unknown>>();
  private groupErrors = new Map<string, AppError>();
  private entryErrors = new Map<string, string>();
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private pending: Promise<void> = Promise.resolve();
  private pendingStart = new Set<string>();
  private historyCursors = new Map<string, ComposeHistoryCursor>();

  constructor(
    entries: Entry[],
    groups: ComposeGroup[],
    environment: NodeJS.ProcessEnv,
    private onChange: () => void,
  ) {
    this.entries = entries.filter((entry) => entry.kind === 'compose');
    this.groups = groups;
    this.environment = environment;
    this.timer = setInterval(() => {
      void this.refresh();
    }, OBSERVE_MS);
    this.timer.unref?.();
    void this.refresh();
  }

  status(id: string): EntryStatus {
    const entry = this.entries.find((item) => item.id === id);
    const observed = this.observed.get(id);
    if (!entry) {
      return {
        id,
        projectId: '',
        key: '',
        name: id,
        kind: 'compose',
        directory: '',
        links: [],
        dependsOn: [],
        autostart: false,
        restartDependencies: false,
        restartDependents: false,
        stopSeconds: 10,
        readinessSeconds: 60,
        state: 'stopped',
        health: 'unknown',
        error: 'Unknown Compose entry.',
      };
    }
    const groupError = entry.composeGroupId
      ? this.groupErrors.get(entry.composeGroupId)
      : undefined;
    const error = groupError?.message ?? this.entryErrors.get(id);
    return {
      ...entry,
      state: observed?.state ?? 'stopped',
      health: groupError || this.entryErrors.has(id) ? 'unknown' : (observed?.health ?? 'unknown'),
      ...(observed?.runId ? { runId: observed.runId } : {}),
      ...(observed?.exit ? { exit: observed.exit } : {}),
      ...(error ? { error } : {}),
      ...(observed?.containers ? { containers: observed.containers } : {}),
    };
  }

  async history(id: string, options: { after?: number; tail?: number } = {}): Promise<LogHistory> {
    const entry = this.requireEntry(id);
    const group = this.requireGroup(entry);
    const service = this.requireService(entry);
    const containers = await this.serviceContainers(group, service);
    const lines: ComposeHistoryLine[] = [];
    const ids: string[] = [];
    for (const container of containers) {
      const result = await runDocker(['logs', '--timestamps', container.id], {
        cwd: group.directory,
        env: this.environment,
        timeoutMs: 20000,
      });
      if (result.code !== 0) {
        const current = await this.serviceContainers(group, service);
        if (!current.some((item) => item.id === container.id)) {
          continue;
        }
        throw mapComposeFailure(result, `Docker logs failed for ${container.id}.`);
      }
      ids.push(container.id);
      lines.push(...dockerLogLines(result.stdout, result.stderr, container.id));
    }
    lines.sort(
      (left, right) =>
        left.timestamp.localeCompare(right.timestamp) ||
        left.containerId.localeCompare(right.containerId) ||
        left.stream.localeCompare(right.stream) ||
        left.text.localeCompare(right.text),
    );
    const paged = pageComposeHistory(lines, this.historyCursors.get(id), options, {
      entryId: id,
      runId: this.observed.get(id)?.runId ?? ids[0] ?? id,
    });
    this.historyCursors.set(id, paged.cursor);
    return paged.page;
  }

  async start(entry: Entry, environment: NodeJS.ProcessEnv): Promise<void> {
    if (this.closed) {
      throw new AppError('MANAGER_STOPPING', 'Compose adapter is shut down.');
    }
    this.useEnvironment(environment);
    const group = this.requireGroup(entry);
    const service = this.requireService(entry);
    const timeoutMs = Math.max(entry.readinessSeconds, 60) * 1000 + 15000;
    const current = this.observed.get(entry.id) ?? {
      state: 'starting' as const,
      health: 'unknown' as const,
    };
    current.stopping = false;
    current.state = 'starting';
    this.observed.set(entry.id, current);
    this.pendingStart.add(entry.id);
    this.onChange();
    try {
      await dockerCompose(composeArgs(group, ['create', '--pull', 'never', '-y', service]), {
        cwd: group.directory,
        env: environment,
        timeoutMs,
      });
      await dockerCompose(composeArgs(group, ['start', service]), {
        cwd: group.directory,
        env: environment,
        timeoutMs,
      });
    } finally {
      this.pendingStart.delete(entry.id);
      await this.refresh();
    }
  }

  async stop(entry: Entry): Promise<void> {
    if (this.closed) {
      throw new AppError('MANAGER_STOPPING', 'Compose adapter is shut down.');
    }
    const group = this.requireGroup(entry);
    const service = this.requireService(entry);
    this.pendingStart.delete(entry.id);
    const current = this.observed.get(entry.id) ?? {
      state: 'stopped' as const,
      health: 'unknown' as const,
    };
    current.stopping = true;
    current.state = 'stopping';
    this.observed.set(entry.id, current);
    this.onChange();
    const stopSeconds = Math.max(1, Math.ceil(entry.stopSeconds));
    try {
      await dockerCompose(composeArgs(group, ['stop', '-t', String(stopSeconds), service]), {
        cwd: group.directory,
        env: this.environment,
        timeoutMs: (stopSeconds + 15) * 1000,
      });
    } catch (error) {
      const observed = this.observed.get(entry.id);
      if (observed) {
        observed.stopping = false;
      }
      throw error;
    } finally {
      await this.refresh();
    }
  }

  async ready(entry: Entry): Promise<boolean> {
    await this.refresh();
    const group = this.requireGroup(entry);
    const failure = this.groupErrors.get(group.id);
    if (failure) {
      throw new AppError(failure.code, failure.message, failure.details, entry.id);
    }
    const entryError = this.entryErrors.get(entry.id);
    if (entryError) {
      throw new AppError('INVALID_CONFIG', entryError, undefined, entry.id);
    }
    const discovery = this.discoveries.get(group.id);
    const containers = this.observed.get(entry.id)?.containers ?? [];
    const expected =
      discovery && entry.composeService
        ? replicaCount(discovery, entry.composeService)
        : Math.max(containers.length, 1);
    if (containers.length < expected) {
      return false;
    }
    if (!containers.every((container) => container.state === 'running')) {
      return false;
    }
    if (
      discovery &&
      entry.composeService &&
      serviceHasHealthcheck(discovery, entry.composeService)
    ) {
      return containers.every((container) => container.health === 'healthy');
    }
    return true;
  }

  update(entries: Entry[]): void {
    if (this.closed) {
      return;
    }
    this.entries = entries.filter((entry) => entry.kind === 'compose');
    for (const id of this.historyCursors.keys()) {
      if (!this.entries.some((entry) => entry.id === id)) {
        this.historyCursors.delete(id);
      }
    }
    for (const id of this.observed.keys()) {
      if (!this.entries.some((entry) => entry.id === id)) {
        this.observed.delete(id);
      }
    }
    for (const id of this.entryErrors.keys()) {
      if (!this.entries.some((entry) => entry.id === id)) {
        this.entryErrors.delete(id);
      }
    }
    this.onChange();
  }

  updateGroups(groups: ComposeGroup[], environment: NodeJS.ProcessEnv): void {
    if (this.closed) {
      return;
    }
    this.groups = groups;
    this.discoveries.clear();
    for (const id of this.groupErrors.keys()) {
      if (!groups.some((group) => group.id === id)) {
        this.groupErrors.delete(id);
      }
    }
    this.useEnvironment(environment);
    void this.refresh();
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending;
  }

  async refresh(): Promise<void> {
    if (this.closed) {
      return;
    }
    const run = this.pending.then(() => this.refreshOnce());
    this.pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private useEnvironment(environment: NodeJS.ProcessEnv): void {
    if (!sameEnv(this.environment, environment)) {
      this.discoveries.clear();
    }
    this.environment = environment;
  }

  private async refreshOnce(): Promise<void> {
    if (this.closed) {
      return;
    }
    for (const group of this.groups) {
      if (this.closed) {
        return;
      }
      try {
        let discovery = this.discoveries.get(group.id);
        if (!discovery) {
          discovery = await readGroupConfig(group, this.environment);
          if (this.closed) {
            return;
          }
          this.discoveries.set(group.id, discovery);
        }
        const rows = await this.ps(group);
        if (this.closed) {
          return;
        }
        this.applyRows(group, rows, discovery);
        this.groupErrors.delete(group.id);
      } catch (error) {
        const failure =
          error instanceof AppError
            ? error
            : new AppError(
                'COMPOSE_FAILED',
                error instanceof Error ? error.message : String(error),
              );
        this.groupErrors.set(group.id, failure);
      }
    }
    if (this.closed) {
      return;
    }
    this.onChange();
  }

  private applyRows(group: ComposeGroup, rows: PsRow[], discovery: Record<string, unknown>): void {
    const byService = new Map<string, ComposeContainer[]>();
    for (const row of rows) {
      if (!row.ID || !row.Service || (row.Project && row.Project !== group.projectName)) {
        continue;
      }
      if (/com\.docker\.compose\.oneoff=True/i.test(row.Labels ?? '')) {
        continue;
      }
      const number = Number(
        /com\.docker\.compose\.container-number=(\d+)/.exec(row.Labels ?? '')?.[1] ?? 1,
      );
      const list = byService.get(row.Service) ?? [];
      list.push({
        id: row.ID,
        name: row.Name ?? row.ID,
        service: row.Service,
        state: (row.State ?? '').toLowerCase(),
        health: row.Health ?? '',
        exitCode: row.ExitCode ?? 0,
        number,
      });
      byService.set(row.Service, list);
    }
    for (const entry of this.entries.filter(
      (item) => item.composeGroupId === group.id && item.composeService,
    )) {
      try {
        const containers = (byService.get(entry.composeService!) ?? []).sort(
          (left, right) => left.number - right.number || left.id.localeCompare(right.id),
        );
        const expected = replicaCount(discovery, entry.composeService!);
        const previous = this.observed.get(entry.id);
        const ids = containers.map((container) => container.id).join(',');
        const previousIds = previous?.containers?.map((container) => container.id).join(',') ?? '';
        const runId =
          ids && ids === previousIds
            ? (previous?.runId ?? randomUUID())
            : ids
              ? randomUUID()
              : undefined;
        const stopping =
          Boolean(previous?.stopping) &&
          containers.some(
            (container) =>
              container.state === 'running' ||
              container.state === 'restarting' ||
              container.state === 'paused',
          );
        const state = aggregateComposeState(
          containers,
          expected,
          stopping,
          this.pendingStart.has(entry.id),
        );
        const health = aggregateHealth(
          containers,
          expected,
          serviceHasHealthcheck(discovery, entry.composeService!),
        );
        const code =
          containers.find((container) => container.exitCode !== 0)?.exitCode ??
          containers[0]?.exitCode ??
          null;
        const exit =
          state === 'exited'
            ? previous?.exit && ids === previousIds && previous.exit.code === code
              ? previous.exit
              : { code, signal: null, at: new Date().toISOString() }
            : undefined;
        this.entryErrors.delete(entry.id);
        this.observed.set(entry.id, {
          state,
          health,
          containers,
          ...(runId ? { runId } : {}),
          ...(exit ? { exit } : {}),
          stopping,
        });
      } catch (error) {
        this.entryErrors.set(entry.id, error instanceof Error ? error.message : String(error));
        const previous = this.observed.get(entry.id);
        if (previous) {
          this.observed.set(entry.id, { ...previous, health: 'unknown' });
        }
      }
    }
  }

  private async ps(group: ComposeGroup): Promise<PsRow[]> {
    const result = await dockerCompose(composeArgs(group, ['ps', '-a', '--format', 'json']), {
      cwd: group.directory,
      env: this.environment,
      timeoutMs: 20000,
    });
    const rows: PsRow[] = [];
    for (const item of parseJsonLines(result.stdout)) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const row: PsRow = {};
      if ('ID' in item && typeof item.ID === 'string') {
        row.ID = item.ID;
      }
      if ('Name' in item && typeof item.Name === 'string') {
        row.Name = item.Name;
      }
      if ('Service' in item && typeof item.Service === 'string') {
        row.Service = item.Service;
      }
      if ('State' in item && typeof item.State === 'string') {
        row.State = item.State;
      }
      if ('Health' in item && typeof item.Health === 'string') {
        row.Health = item.Health;
      }
      if ('ExitCode' in item && typeof item.ExitCode === 'number') {
        row.ExitCode = item.ExitCode;
      }
      if ('Labels' in item && typeof item.Labels === 'string') {
        row.Labels = item.Labels;
      }
      if ('Project' in item && typeof item.Project === 'string') {
        row.Project = item.Project;
      }
      rows.push(row);
    }
    return rows;
  }

  private async serviceContainers(
    group: ComposeGroup,
    service: string,
  ): Promise<ComposeContainer[]> {
    const rows = await this.ps(group);
    return rows
      .filter(
        (row) =>
          row.Service === service &&
          row.ID &&
          !(row.Project && row.Project !== group.projectName) &&
          !/oneoff=True/i.test(row.Labels ?? ''),
      )
      .map((row) => ({
        id: row.ID!,
        name: row.Name ?? row.ID!,
        service,
        state: (row.State ?? '').toLowerCase(),
        health: row.Health ?? '',
        exitCode: row.ExitCode ?? 0,
        number: Number(/container-number=(\d+)/.exec(row.Labels ?? '')?.[1] ?? 1),
      }));
  }

  private requireEntry(id: string): Entry {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) {
      throw new AppError('UNKNOWN_ENTRY', `Unknown Compose entry ${id}.`, undefined, id);
    }
    return entry;
  }

  private requireGroup(entry: Entry): ComposeGroup {
    const group = this.groups.find((item) => item.id === entry.composeGroupId);
    if (!group) {
      throw new AppError(
        'INVALID_CONFIG',
        `Compose group ${entry.composeGroupId ?? 'missing'} is not loaded.`,
        undefined,
        entry.id,
      );
    }
    return group;
  }

  private requireService(entry: Entry): string {
    if (!entry.composeService) {
      throw new AppError(
        'INVALID_CONFIG',
        `Compose entry ${entry.id} has no service name.`,
        undefined,
        entry.id,
      );
    }
    return entry.composeService;
  }
}

export function aggregateComposeState(
  containers: ComposeContainer[],
  expected: number,
  stopping: boolean,
  starting: boolean,
): EntryState {
  if (
    stopping &&
    containers.some(
      (container) =>
        container.state === 'running' ||
        container.state === 'paused' ||
        container.state === 'restarting',
    )
  ) {
    return 'stopping';
  }
  if (containers.length === 0) {
    return 'stopped';
  }
  if (starting || containers.some((container) => container.state === 'restarting')) {
    return 'starting';
  }
  const up = containers.filter(
    (container) => container.state === 'running' || container.state === 'paused',
  ).length;
  const exited = containers.filter(
    (container) => container.state === 'exited' || container.state === 'dead',
  ).length;
  const unstarted = containers.filter(
    (container) => container.state === 'created' || container.state === 'removing',
  ).length;
  if (up >= expected && exited === 0 && unstarted === 0) {
    return 'running';
  }
  if (exited === containers.length) {
    return 'exited';
  }
  if (up > 0 && (exited > 0 || unstarted > 0)) {
    return 'exited';
  }
  if (up > 0) {
    return 'running';
  }
  return 'stopped';
}

function aggregateHealth(
  containers: ComposeContainer[],
  expected: number,
  hasCheck: boolean,
): Health {
  if (!hasCheck) {
    return 'no-check';
  }
  if (containers.length < expected) {
    return 'unknown';
  }
  if (containers.some((container) => container.health === 'unhealthy')) {
    return 'unhealthy';
  }
  if (
    containers.length >= expected &&
    containers.every((container) => container.health === 'healthy')
  ) {
    return 'healthy';
  }
  return 'checking';
}

function parseJsonLines(stdout: string): unknown[] {
  const text = stdout.trim();
  if (!text) {
    return [];
  }
  if (text.startsWith('[')) {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

function dockerLogLines(stdout: string, stderr: string, containerId: string): ComposeHistoryLine[] {
  const lines: ComposeHistoryLine[] = [];
  for (const stream of ['stdout', 'stderr'] as const) {
    for (const line of (stream === 'stdout' ? stdout : stderr).split(/\r?\n/)) {
      if (!line) {
        continue;
      }
      const match = /^(\d{4}-\d{2}-\d{2}T\S+)\s([\s\S]*)$/.exec(line);
      const trimmed = match?.[1].replace(/(\.\d{3})\d+Z$/, '$1Z');
      const parsed = trimmed ? new Date(trimmed) : undefined;
      lines.push({
        timestamp: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : '',
        stream,
        text: match ? match[2] : line,
        containerId,
      });
    }
  }
  return lines;
}

function digestLines(lines: readonly ComposeHistoryLine[]): string {
  const hash = createHash('sha256');
  for (const line of lines) {
    hash
      .update(line.containerId)
      .update('\0')
      .update(line.stream)
      .update('\0')
      .update(line.timestamp)
      .update('\0')
      .update(line.text)
      .update('\n');
  }
  return hash.digest('hex');
}

export function pageComposeHistory(
  lines: readonly ComposeHistoryLine[],
  previous: ComposeHistoryCursor | undefined,
  options: { after?: number; tail?: number },
  meta: { entryId: string; runId: string },
): { page: LogHistory; cursor: ComposeHistoryCursor } {
  const digest = digestLines(lines);
  const extended =
    previous !== undefined &&
    lines.length >= previous.count &&
    digestLines(lines.slice(0, previous.count)) === previous.digest;
  const replaced = previous !== undefined && !extended;
  const offset =
    previous === undefined ? 0 : replaced ? previous.offset + previous.count : previous.offset;
  const numbered = lines.map((line, index) => ({
    entryId: meta.entryId,
    runId: meta.runId,
    sequence: offset + index + 1,
    timestamp: line.timestamp,
    stream: line.stream,
    text: line.text,
    containerId: line.containerId,
  }));
  const after = options.after ?? 0;
  let visible = numbered.filter((record) => record.sequence > after);
  const gap =
    after > 0 &&
    (replaced ||
      after < offset ||
      after > offset + lines.length ||
      (visible.length > 0 && visible[0]?.sequence !== after + 1));
  if (options.tail === 0) {
    visible = [];
  } else if (options.tail !== undefined && visible.length > options.tail) {
    visible =
      after > 0 ? visible.slice(0, options.tail) : visible.slice(visible.length - options.tail);
  }
  const latest = numbered.at(-1)?.sequence ?? offset;
  const cursor = options.tail === 0 ? latest : (visible.at(-1)?.sequence ?? after);
  return {
    page: { records: visible, cursor, oldestCursor: visible[0]?.sequence ?? cursor, gap },
    cursor: { offset, count: lines.length, digest },
  };
}
