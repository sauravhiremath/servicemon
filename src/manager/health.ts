import { spawn, type ChildProcess } from 'node:child_process';
import { connect as connectTcp } from 'node:net';
import type { Check, Entry, Health } from '../shared/types.js';
import { captureStart, cleanEnv, signalAttached, signalOwnedGroup, waitUntilGone, type RunIdentity } from '../process/ownership.js';

interface Inflight {
  promise: Promise<boolean>;
  generation: number;
  abort: AbortController;
}

export class HealthMonitor {
  private environment: NodeJS.ProcessEnv;
  private readonly healthById = new Map<string, Health>();
  private readonly watched = new Set<string>();
  private readonly inflight = new Map<string, Inflight>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly generation = new Map<string, number>();
  private closed = false;

  constructor(environment: NodeJS.ProcessEnv, private readonly onChange: () => void) {
    this.environment = { ...cleanEnv(environment) };
  }

  health(id: string): Health {
    return this.healthById.get(id) ?? 'unknown';
  }

  check(entry: Entry): Promise<boolean> {
    const current = this.inflight.get(entry.id);
    if (current) return current.promise;
    const generation = this.generation.get(entry.id) ?? 0;
    const abort = new AbortController();
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const flight: Inflight = { promise, generation, abort };
    this.inflight.set(entry.id, flight);
    void this.execute(entry, generation, abort.signal).then((ok) => {
      if (this.inflight.get(entry.id) === flight) this.inflight.delete(entry.id);
      resolve(ok);
    });
    return promise;
  }

  watch(entry: Entry): void {
    if (this.closed) return;
    this.watched.add(entry.id);
    this.schedule(entry, 0);
  }

  unwatch(id: string): void {
    this.watched.delete(id);
    this.cancel(id);
  }

  updateEnvironment(environment: NodeJS.ProcessEnv): void {
    this.environment = { ...cleanEnv(environment) };
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const id of [...this.watched]) this.unwatch(id);
    await Promise.all([...this.inflight.values()].map((flight) => flight.promise));
  }

  private schedule(entry: Entry, delayMs: number): void {
    if (!this.watched.has(entry.id) || this.closed) return;
    clearTimeout(this.timers.get(entry.id));
    const timer = setTimeout(() => {
      this.timers.delete(entry.id);
      void this.check(entry).finally(() => {
        if (!this.watched.has(entry.id) || this.closed) return;
        const interval = Math.max(0, (entry.healthcheck?.interval_seconds ?? 2) * 1000);
        this.schedule(entry, interval);
      });
    }, delayMs);
    this.timers.set(entry.id, timer);
  }

  private cancel(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    this.inflight.get(id)?.abort.abort();
  }

  private async execute(entry: Entry, generation: number, signal: AbortSignal): Promise<boolean> {
    const check = entry.healthcheck;
    if (!check) {
      this.setHealth(entry.id, entry.kind === 'task' ? 'not-applicable' : 'no-check');
      return true;
    }
    if (!this.healthById.has(entry.id) || this.healthById.get(entry.id) === 'unknown') this.setHealth(entry.id, 'checking');
    const timeoutMs = Math.max(1, (check.timeout_seconds ?? 3) * 1000);
    let ok = false;
    try {
      if (check.type === 'http') ok = await httpCheck(check, timeoutMs, signal);
      else if (check.type === 'tcp') ok = await tcpCheck(check, timeoutMs, signal);
      else ok = await commandCheck(entry, check.command, this.environment, timeoutMs, signal);
    } catch {
      ok = false;
    }
    if ((this.generation.get(entry.id) ?? 0) !== generation) return false;
    this.setHealth(entry.id, ok ? 'healthy' : 'unhealthy');
    return ok;
  }

  private setHealth(id: string, health: Health): void {
    if (this.healthById.get(id) === health) return;
    this.healthById.set(id, health);
    this.onChange();
  }
}

async function httpCheck(check: Extract<Check, { type: 'http' }>, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(check.url, { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
  await response.body?.cancel().catch(() => undefined);
  return response.status === (check.expected_status ?? 200);
}

function tcpCheck(check: Extract<Check, { type: 'tcp' }>, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connectTcp({ host: check.host, port: check.port });
  let settled = false;
  const finish = (ok: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(ok);
  };
  const timer = setTimeout(() => finish(false), timeoutMs);
  signal.addEventListener('abort', () => finish(false), { once: true });
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  return promise;
}

async function commandCheck(entry: Entry, command: string, environment: NodeJS.ProcessEnv, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  const child = spawn('/bin/sh', ['-c', command], { cwd: entry.directory, env: cleanEnv(environment), detached: true, stdio: 'ignore' });
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<{ code: number | null }>();
  child.once('exit', (code) => resolveExit({ code }));
  child.once('error', () => resolveExit({ code: null }));
  const pid = child.pid;
  if (!pid) {
    await exited;
    return false;
  }
  const identity: RunIdentity = {
    entryId: entry.id,
    runId: 'health-check',
    pid,
    pgid: pid,
    startedAt: await captureStart(pid),
    command,
    cwd: entry.directory,
    kind: 'task',
    live: true,
  };
  const deadline = Date.now() + timeoutMs;
  const { promise: aborted, resolve: resolveAbort } = Promise.withResolvers<'abort'>();
  if (signal.aborted) resolveAbort('abort');
  else signal.addEventListener('abort', () => resolveAbort('abort'), { once: true });
  const { promise: timedOut, resolve: resolveTimeout } = Promise.withResolvers<'timeout'>();
  const timer = setTimeout(() => resolveTimeout('timeout'), Math.max(0, deadline - Date.now()));
  const outcome = await Promise.race([exited.then((result) => result), aborted, timedOut]);
  clearTimeout(timer);
  if (typeof outcome === 'object' && outcome.code === 0) {
    const gone = await waitUntilGone(identity, Math.max(0, deadline - Date.now()));
    if (gone) {
      await ensureCheckGroupDead(identity, child);
      return true;
    }
  }
  await ensureCheckGroupDead(identity, child);
  return false;
}

async function ensureCheckGroupDead(identity: RunIdentity, child: ChildProcess): Promise<void> {
  const attached = child.exitCode === null && child.signalCode === null;
  if (attached) signalAttached(identity.pid, 'SIGTERM');
  else await signalOwnedGroup(identity, 'SIGTERM');
  if (await waitUntilGone(identity, 200)) return;
  if (child.exitCode === null && child.signalCode === null) signalAttached(identity.pid, 'SIGKILL');
  else await signalOwnedGroup(identity, 'SIGKILL');
  await waitUntilGone(identity, 1000);
}
