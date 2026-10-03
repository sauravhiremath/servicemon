import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, errorData } from '../shared/errors.js';
import type {
  Action,
  Adapter,
  CompiledConfig,
  Entry,
  EntryStatus,
  Operation,
  Target,
} from '../shared/types.js';
import { topologicalOrder, validateGraphs } from './graphs.js';
import type { ValidatedGraphs } from './graphs.js';
import type { HealthMonitor } from './health.js';

export class Operations {
  readonly records = new Map<string, Operation>();
  private active?: Operation;
  private graphs: ValidatedGraphs;
  private stopping = false;
  private completedTasks = new Set<string>();
  constructor(
    public config: CompiledConfig,
    public environment: NodeJS.ProcessEnv,
    private adapters: {
      process: Adapter & { waitTask(id: string): Promise<EntryStatus> };
      compose: Adapter;
    },
    private health: HealthMonitor,
    private changed: (operation?: Operation) => void,
  ) {
    this.graphs = validateGraphs(config.entries);
  }
  status(entry: Entry): EntryStatus {
    const status = this.adapter(entry).status(entry.id);
    return entry.kind === 'service' && entry.healthcheck
      ? { ...status, health: this.health.health(entry.id) }
      : status;
  }
  private adapter(entry: Entry): Adapter {
    return this.adapters[entry.kind === 'compose' ? 'compose' : 'process'];
  }
  private select(target: Target): Entry[] {
    if (Object.values(target).filter(Boolean).length !== 1) {
      throw new AppError('INVALID_TARGET', 'Select one entry, project, or Compose group.');
    }
    const selected = this.config.entries.filter((entry) =>
      target.entry
        ? entry.id === target.entry
        : target.project
          ? entry.projectId === target.project
          : entry.composeGroupId === target.compose,
    );
    const exists = target.entry
      ? selected.length > 0
      : target.project
        ? this.config.projects.some((p) => p.id === target.project)
        : this.config.groups.some((g) => g.id === target.compose);
    if (!exists) {
      throw new AppError('INVALID_TARGET', 'Target does not exist.', target);
    }
    return selected;
  }
  submit(action: Action, target: Target): Operation {
    const selected = this.select(target);
    if (action === 'run' && (selected.length !== 1 || selected[0].kind !== 'task')) {
      throw new AppError('INVALID_TARGET', 'Run requires one task ID.');
    }
    if (action === 'restart' && target.entry && selected[0].kind === 'task') {
      throw new AppError('INVALID_TARGET', 'Use Run for a task.');
    }
    return this.enqueue(action, target, async (operation) => {
      const done = new Set<string>();
      const affected = (id: string) => {
        if (!operation.affected.includes(id)) {
          operation.affected.push(id);
        }
      };
      const start = async (entry: Entry, forceTask = false): Promise<void> => {
        if (this.stopping) {
          throw new AppError('MANAGER_STOPPING', 'Manager is stopping.');
        }
        if (done.has(entry.id)) {
          return;
        }
        for (const id of entry.dependsOn) {
          await start(this.config.entries.find((item) => item.id === id)!);
        }
        if (entry.kind === 'task' && this.completedTasks.has(entry.id) && !forceTask) {
          done.add(entry.id);
          return;
        }
        affected(entry.id);
        const adapter = this.adapter(entry);
        const previous = adapter.status(entry.id);
        if (entry.kind === 'task') {
          if (forceTask || !this.completedTasks.has(entry.id)) {
            this.completedTasks.delete(entry.id);
            if (previous.state !== 'running') {
              await adapter.start(entry, this.environment);
            }
            const result = await this.adapters.process.waitTask(entry.id);
            if (result.state !== 'succeeded') {
              throw new AppError(
                'TASK_FAILED',
                `Task ${entry.id} did not succeed.`,
                result.exit,
                entry.id,
              );
            }
            this.completedTasks.add(entry.id);
          }
        } else {
          if (!['running', 'starting'].includes(previous.state)) {
            await adapter.start(entry, this.environment);
          }
          if (entry.kind === 'service' && entry.healthcheck) {
            this.health.watch(entry);
          }
          const deadline = Date.now() + entry.readinessSeconds * 1000;
          while (true) {
            if (this.stopping) {
              throw new AppError('MANAGER_STOPPING', 'Manager is stopping.');
            }
            const current = adapter.status(entry.id);
            if (!['starting', 'running'].includes(current.state)) {
              throw new AppError(
                'PROCESS_EXITED',
                `Prerequisite ${entry.id} is not running.`,
                current.exit,
                entry.id,
              );
            }
            const ready =
              entry.kind === 'service' && entry.healthcheck
                ? await this.health.check(entry)
                : await adapter.ready(entry);
            if (ready) {
              break;
            }
            if (Date.now() >= deadline) {
              throw new AppError(
                'READINESS_TIMEOUT',
                `Readiness timed out for ${entry.id}.`,
                undefined,
                entry.id,
              );
            }
            await delay(Math.min(100, Math.max(1, deadline - Date.now())));
          }
        }
        done.add(entry.id);
        this.changed(operation);
      };
      if (action === 'stop') {
        for (const id of topologicalOrder(
          selected.map((e) => e.id),
          this.graphs.startup,
        ).reverse()) {
          const entry = this.config.entries.find((e) => e.id === id)!;
          affected(id);
          this.health.unwatch(id);
          await this.adapter(entry).stop(entry);
          if (entry.kind === 'task') {
            this.completedTasks.delete(id);
          }
        }
      } else if (action === 'restart') {
        const roots = target.entry
          ? selected
          : selected.filter(
              (e) =>
                e.kind !== 'task' &&
                ['running', 'starting'].includes(this.adapter(e).status(e.id).state),
            );
        const included = new Set<string>();
        const include = (id: string): void => {
          if (included.has(id)) {
            return;
          }
          included.add(id);
          for (const next of this.graphs.restart.get(id) ?? []) {
            include(next);
          }
        };
        for (const entry of roots) {
          include(entry.id);
        }
        const active = new Set(
          [...included].filter((id) =>
            ['running', 'starting'].includes(
              this.adapter(this.config.entries.find((e) => e.id === id)!).status(id).state,
            ),
          ),
        );
        const order = topologicalOrder([...included], this.graphs.startup);
        for (const id of order.slice().reverse()) {
          if (active.has(id)) {
            const entry = this.config.entries.find((e) => e.id === id)!;
            affected(id);
            this.health.unwatch(id);
            await this.adapter(entry).stop(entry);
          }
        }
        for (const id of order) {
          if (active.has(id) || roots.some((e) => e.id === id)) {
            await start(this.config.entries.find((e) => e.id === id)!);
          }
        }
      } else {
        for (const entry of selected) {
          await start(
            entry,
            entry.kind === 'task' && (action === 'run' || Boolean(target.project)),
          );
        }
      }
    });
  }
  enqueue(
    action: string,
    target: Target,
    execute: (operation: Operation) => Promise<void>,
  ): Operation {
    if (this.stopping) {
      throw new AppError('MANAGER_STOPPING', 'Manager is stopping.');
    }
    if (this.active) {
      throw new AppError('OPERATION_BUSY', 'Another operation is active.', {
        operationId: this.active.id,
      });
    }
    const operation: Operation = {
      id: randomUUID(),
      action,
      target,
      state: 'pending',
      affected: [],
      startedAt: new Date().toISOString(),
    };
    this.records.set(operation.id, operation);
    this.active = operation;
    this.changed(operation);
    void (async () => {
      operation.state = 'running';
      this.changed(operation);
      try {
        await execute(operation);
        operation.state = 'succeeded';
      } catch (error) {
        operation.state = 'failed';
        operation.error = { ...errorData(error), operationId: operation.id };
      } finally {
        operation.finishedAt = new Date().toISOString();
        this.active = undefined;
        this.changed(operation);
      }
    })();
    return operation;
  }
  async wait(id: string): Promise<Operation> {
    const operation = this.records.get(id);
    if (!operation) {
      throw new AppError('INVALID_INPUT', 'Unknown operation ID.');
    }
    while (['pending', 'running'].includes(operation.state)) {
      await delay(25);
    }
    return operation;
  }
  async autostart(): Promise<void> {
    const entries = this.config.entries.filter((e) => e.autostart);
    if (!entries.length) {
      return;
    }
    for (const entry of entries) {
      if (entry.kind === 'task' && this.completedTasks.has(entry.id)) {
        continue;
      }
      const operation = this.submit(entry.kind === 'task' ? 'run' : 'start', { entry: entry.id });
      await this.wait(operation.id);
    }
  }
  applyConfig(config: CompiledConfig, environment: NodeJS.ProcessEnv): void {
    const old = new Map(this.config.entries.map((e) => [e.id, e]));
    const invalid = new Set<string>();
    for (const entry of config.entries) {
      const previous = old.get(entry.id);
      if (
        !previous ||
        JSON.stringify([
          previous.kind,
          previous.command,
          previous.directory,
          previous.dependsOn,
          previous.composeGroupId,
          previous.composeService,
          previous.execution,
          previous.healthcheck,
        ]) !==
          JSON.stringify([
            entry.kind,
            entry.command,
            entry.directory,
            entry.dependsOn,
            entry.composeGroupId,
            entry.composeService,
            entry.execution,
            entry.healthcheck,
          ])
      ) {
        invalid.add(entry.id);
      }
    }
    for (const entry of this.config.entries) {
      if (!config.entries.some((e) => e.id === entry.id)) {
        invalid.add(entry.id);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of config.entries) {
        if (entry.dependsOn.some((id) => invalid.has(id)) && !invalid.has(entry.id)) {
          invalid.add(entry.id);
          changed = true;
        }
      }
    }
    for (const id of invalid) {
      this.completedTasks.delete(id);
    }
    for (const entry of this.config.entries) {
      const next = config.entries.find((item) => item.id === entry.id);
      if (
        !next ||
        JSON.stringify([entry.command, entry.directory, entry.execution, entry.healthcheck]) !==
          JSON.stringify([next.command, next.directory, next.execution, next.healthcheck])
      ) {
        this.health.unwatch(entry.id);
      }
    }
    this.config = config;
    this.environment = environment;
    this.graphs = validateGraphs(config.entries);
    this.adapters.process.update?.(config.entries.filter((e) => e.kind !== 'compose'));
    this.adapters.compose.update?.(config.entries.filter((e) => e.kind === 'compose'));
    this.health.updateEnvironment(environment);
    for (const entry of config.entries) {
      if (
        entry.kind === 'service' &&
        entry.healthcheck &&
        this.adapter(entry).status(entry.id).state === 'running'
      ) {
        this.health.watch(entry);
      }
    }
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.health.shutdown();
    try {
      await this.adapters.process.shutdown();
      if (this.active) {
        await this.wait(this.active.id);
      }
    } finally {
      await this.adapters.compose.shutdown();
    }
  }
}
