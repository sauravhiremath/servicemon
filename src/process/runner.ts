import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Entry, EntryStatus, ExitDetails } from '../shared/types.js';
import { AppError } from '../shared/errors.js';
import type { LogStore } from '../logs/store.js';
import { StreamDecoder } from '../logs/decoder.js';
import { captureStart, cleanEnv, inspectIdentity, readIdentity, signalAttached, signalOwnedGroup, waitUntilGone, writeIdentity, type RunIdentity } from './ownership.js';

const CHUNK_BYTES = 16 * 1024;

interface ActiveRun {
  entry: Entry;
  identity: RunIdentity;
  child?: ChildProcess;
  state: EntryStatus['state'];
  attached: boolean;
  conflict: boolean;
  finalized: boolean;
  requestedStop: boolean;
  shellExit?: { code: number | null; signal: NodeJS.Signals | null };
  exit?: ExitDetails;
  error?: string;
  stopped?: Promise<void>;
}

export class ProcessAdapter {
  private entries = new Map<string, Entry>();
  private readonly runs = new Map<string, ActiveRun>();
  private readonly stopping = new Set<string>();
  private readonly waiters = new Map<string, Array<(status: EntryStatus) => void>>();

  constructor(
    entries: Entry[],
    _environment: NodeJS.ProcessEnv,
    private readonly logStore: LogStore,
    private readonly stateDir: string,
    private readonly onChange: () => void,
  ) {
    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
  }

  update(entries: Entry[]): void {
    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
    for (const [id, run] of this.runs) {
      const next = this.entries.get(id);
      if (next) run.entry = next;
    }
    this.onChange();
  }

  status(id: string): EntryStatus {
    const run = this.runs.get(id);
    const entry = this.entries.get(id) ?? run?.entry;
    if (!entry) throw new AppError('UNKNOWN_ENTRY', `Unknown entry ${id}.`, undefined, id);
    return {
      ...entry,
      state: run?.state ?? (entry.kind === 'task' ? 'idle' : 'stopped'),
      health: entry.kind === 'task' ? 'not-applicable' : entry.healthcheck ? 'unknown' : 'no-check',
      ...(run?.identity.runId ? { runId: run.identity.runId } : {}),
      ...(run?.identity.pid ? { pid: run.identity.pid } : {}),
      ...(run?.exit ? { exit: run.exit } : {}),
      ...(run?.error ? { error: run.error } : {}),
    };
  }

  async start(entry: Entry, environment: NodeJS.ProcessEnv): Promise<void> {
    if (entry.kind === 'compose' || !entry.command) throw new AppError('INVALID_TARGET', 'This entry has no command to run.', undefined, entry.id);
    const existing = this.runs.get(entry.id);
    if (existing?.conflict) {
      throw new AppError('OWNERSHIP_CONFLICT', existing.error ?? 'Ownership conflict. The recorded process was not signaled.', { pid: existing.identity.pid, runId: existing.identity.runId, startedAt: existing.identity.startedAt }, entry.id);
    }
    if (existing && !existing.finalized) throw new AppError('OPERATION_BUSY', 'Entry already has an active run.', { runId: existing.identity.runId }, entry.id);
    const runId = randomUUID();
    const run: ActiveRun = {
      entry,
      identity: { entryId: entry.id, runId, pid: 0, pgid: 0, startedAt: null, command: entry.command, cwd: entry.directory, kind: entry.kind === 'task' ? 'task' : 'service', live: true },
      state: 'starting',
      attached: true,
      conflict: false,
      finalized: false,
      requestedStop: false,
    };
    this.runs.set(entry.id, run);
    this.onChange();
    const child = spawn('/bin/sh', ['-c', entry.command], {
      cwd: entry.directory,
      env: cleanEnv(environment, runId),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    run.child = child;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    child.once('spawn', () => resolve());
    child.once('error', (error) => reject(error));
    try {
      await promise;
    } catch (error) {
      this.failSpawn(run, error);
      throw new AppError('INVALID_INPUT', error instanceof Error ? error.message : 'Command failed to start.', undefined, entry.id);
    }
    if (!child.pid || !this.isCurrent(run)) {
      this.failSpawn(run, new Error('Process did not receive a PID.'));
      throw new AppError('INVALID_INPUT', 'Process did not receive a PID.', undefined, entry.id);
    }
    run.identity.pid = child.pid;
    run.identity.pgid = child.pid;
    child.once('exit', (code, signal) => {
      if (!this.isCurrent(run)) return;
      run.shellExit = { code, signal };
      if (this.stopping.has(entry.id)) return;
      void this.observe(run);
    });
    this.pipe(run, 'stdout', child.stdout);
    this.pipe(run, 'stderr', child.stderr);
    this.logStore.append(entry.id, runId, 'boundary', 'run started');
    run.identity.startedAt = await captureStart(child.pid);
    if (!this.isCurrent(run) || run.finalized) return;
    if (run.shellExit && await inspectIdentity({ ...run.identity, live: true }) !== 'alive') return;
    writeIdentity(this.stateDir, run.identity);
    run.state = 'running';
    this.onChange();
  }

  async stop(entry: Entry): Promise<void> {
    const run = this.runs.get(entry.id);
    if (!run) return;
    if (run.conflict) throw new AppError('OWNERSHIP_CONFLICT', run.error ?? 'Process ownership is uncertain. The process was not signaled.', { pid: run.identity.pid, runId: run.identity.runId }, entry.id);
    if (run.finalized || !run.attached) return;
    if (run.stopped) {
      await run.stopped;
      return;
    }
    this.stopping.add(entry.id);
    run.requestedStop = true;
    run.state = 'stopping';
    this.onChange();
    const stopped = this.terminate(run).finally(() => { this.stopping.delete(entry.id); run.stopped = undefined; });
    run.stopped = stopped;
    await stopped;
  }

  async ready(entry: Entry): Promise<boolean> {
    const run = this.runs.get(entry.id);
    if (!run || !run.attached || run.conflict || run.finalized) return false;
    if (run.state !== 'running' && run.state !== 'starting') return false;
    return (await inspectIdentity({ ...run.identity, live: true })) === 'alive';
  }

  async shutdown(): Promise<void> {
    const active = [...this.runs.values()].filter((run) => run.attached && !run.conflict && !run.finalized);
    const results = await Promise.allSettled(active.map((run) => this.stop(run.entry)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  waitTask(id: string): Promise<EntryStatus> {
    const entry = this.entries.get(id) ?? this.runs.get(id)?.entry;
    if (!entry || entry.kind !== 'task') throw new AppError('INVALID_TARGET', 'Wait requires a task.', undefined, id);
    const run = this.runs.get(id);
    if (run?.conflict) return Promise.reject(new AppError('OWNERSHIP_CONFLICT', run.error ?? 'Ownership conflict.', { pid: run.identity.pid, runId: run.identity.runId }, id));
    if (!run || run.finalized) return Promise.resolve(this.status(id));
    const { promise, resolve } = Promise.withResolvers<EntryStatus>();
    const current = this.waiters.get(id) ?? [];
    current.push(resolve);
    this.waiters.set(id, current);
    return promise;
  }

  async recover(): Promise<void> {
    for (const entry of this.entries.values()) {
      if (entry.kind === 'compose' || !entry.command) continue;
      const identity = readIdentity(this.stateDir, entry.id);
      if (!identity?.live) continue;
      const state = await inspectIdentity(identity);
      if (state === 'dead') {
        writeIdentity(this.stateDir, { ...identity, live: false });
        const run: ActiveRun = {
          entry,
          identity: { ...identity, live: false },
          state: entry.kind === 'task' ? 'failed' : 'exited',
          attached: false,
          conflict: false,
          finalized: true,
          requestedStop: false,
          exit: { code: null, signal: null, at: new Date().toISOString() },
        };
        this.runs.set(entry.id, run);
        continue;
      }
      const error = state === 'uncertain'
        ? `Ownership could not be verified for process ${identity.pid} run ${identity.runId}. It was not signaled.`
        : `Ownership conflict. Process ${identity.pid} run ${identity.runId} is still alive. It was not signaled.`;
      this.runs.set(entry.id, {
        entry,
        identity,
        state: entry.kind === 'task' ? 'failed' : 'exited',
        attached: false,
        conflict: true,
        finalized: true,
        requestedStop: false,
        error,
      });
    }
    this.onChange();
  }

  private async observe(run: ActiveRun): Promise<void> {
    while (this.isCurrent(run) && !run.finalized && !this.stopping.has(run.entry.id)) {
      const state = await inspectIdentity({ ...run.identity, live: true });
      if (!this.isCurrent(run) || run.finalized || this.stopping.has(run.entry.id)) return;
      if (state === 'dead') {
        this.finalize(run);
        return;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 40);
      await promise;
    }
  }

  private async terminate(run: ActiveRun): Promise<void> {
    const first = await this.signal(run, 'SIGTERM');
    if (!this.isCurrent(run) || run.finalized) return;
    if (first === 'uncertain') {
      run.error = 'Ownership is uncertain. The process was not signaled.';
      run.state = 'running';
      this.onChange();
      throw new AppError('OWNERSHIP_CONFLICT', run.error, { pid: run.identity.pid, runId: run.identity.runId }, run.entry.id);
    }
    let gone = first === 'gone' || await waitUntilGone(run.identity, Math.max(0, run.entry.stopSeconds) * 1000);
    if (!this.isCurrent(run) || run.finalized) return;
    if (!gone) {
      const second = await this.signal(run, 'SIGKILL');
      if (second === 'uncertain') {
        run.error = 'Ownership is uncertain. The process was not signaled.';
        run.state = 'running';
        this.onChange();
        throw new AppError('OWNERSHIP_CONFLICT', run.error, { pid: run.identity.pid, runId: run.identity.runId }, run.entry.id);
      }
      gone = await waitUntilGone(run.identity, 2000);
    }
    if (!this.isCurrent(run) || run.finalized) return;
    if (!gone) {
      run.error = 'Stop deadline expired. The owned group is still present after SIGKILL.';
      run.state = 'running';
      this.onChange();
      throw new AppError('STOP_TIMEOUT', run.error, { pid: run.identity.pid, runId: run.identity.runId }, run.entry.id);
    }
    this.finalize(run);
  }

  private async signal(run: ActiveRun, signal: NodeJS.Signals): Promise<'signaled' | 'gone' | 'uncertain'> {
    const child = run.child;
    if (child && child.exitCode === null && child.signalCode === null && child.pid === run.identity.pid && child.pid) {
      return signalAttached(child.pid, signal);
    }
    return signalOwnedGroup(run.identity, signal);
  }

  private finalize(run: ActiveRun): void {
    if (run.finalized || !this.isCurrent(run)) return;
    run.finalized = true;
    run.identity.live = false;
    const exit = run.shellExit;
    run.exit = { code: exit?.code ?? null, signal: exit?.signal ?? null, at: new Date().toISOString() };
    if (run.entry.kind === 'task') run.state = run.requestedStop ? 'stopped' : run.exit.code === 0 ? 'succeeded' : 'failed';
    else run.state = run.requestedStop ? 'stopped' : 'exited';
    try {
      writeIdentity(this.stateDir, run.identity);
    } catch {
      run.error = run.error ?? 'Run identity could not be saved.';
    }
    try {
      this.logStore.append(run.entry.id, run.identity.runId, 'boundary', 'run exited');
    } catch {
      run.error = run.error ?? 'Exit boundary could not be logged.';
    }
    const pending = this.waiters.get(run.entry.id) ?? [];
    this.waiters.delete(run.entry.id);
    const status = this.status(run.entry.id);
    for (const resolve of pending) resolve(status);
    this.onChange();
  }

  private failSpawn(run: ActiveRun, error: unknown): void {
    if (!this.isCurrent(run) || run.finalized) return;
    run.shellExit = { code: null, signal: null };
    run.error = error instanceof Error ? error.message : 'Command failed to start.';
    run.requestedStop = false;
    this.finalize(run);
    if (run.entry.kind === 'task') run.state = 'failed';
    else run.state = 'exited';
  }

  private pipe(run: ActiveRun, stream: 'stdout' | 'stderr', readable: NodeJS.ReadableStream | null): void {
    if (!readable) return;
    const decoder = new StreamDecoder(CHUNK_BYTES);
    readable.on('data', (chunk: Buffer) => {
      if (!this.isCurrent(run)) return;
      for (const text of decoder.push(chunk)) this.logStore.append(run.entry.id, run.identity.runId, stream, text);
    });
    readable.on('end', () => {
      if (!this.isCurrent(run)) return;
      for (const text of decoder.flush()) this.logStore.append(run.entry.id, run.identity.runId, stream, text);
    });
  }

  private isCurrent(run: ActiveRun): boolean {
    return this.runs.get(run.entry.id) === run;
  }
}

