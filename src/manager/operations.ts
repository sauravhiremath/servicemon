import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError, errorData } from '../shared/errors.js';
import type {
  Action,
  Adapter,
  CompiledConfig,
  Entry,
  EntryStatus,
  ErrorData,
  ManagerImpact,
  Operation,
  ShutdownExpectation,
  StartupState,
  Target,
} from '../shared/types.js';
import { topologicalOrder, validateGraphs } from './graphs.js';
import type { ValidatedGraphs } from './graphs.js';
import type { HealthMonitor } from './health.js';

interface ActionPlan {
  scope: string[];
  stops: Entry[];
  starts: { entry: Entry; forceTask: boolean }[];
}

export class Operations {
  readonly records = new Map<string, Operation>();
  private active = new Map<string, { operation: Operation; completion: Promise<Operation> }>();
  private entries: Map<string, Entry>;
  private graphs: ValidatedGraphs;
  private stopping = false;
  private completedTasks = new Set<string>();
  private startupState: StartupState = { state: 'running' };
  private admitted?: ShutdownExpectation | 'open';
  private shutdownTask?: Promise<void>;
  constructor(
    public config: CompiledConfig,
    public environment: NodeJS.ProcessEnv,
    private adapters: {
      process: Adapter & { waitTask(id: string): Promise<EntryStatus> };
      compose: Adapter;
    },
    private health: HealthMonitor,
    private changed: (operation?: Operation) => void,
    private identity?: { pid: number; startedAt: string },
  ) {
    this.entries = new Map(config.entries.map((entry) => [entry.id, entry]));
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
  private plan(action: Action, target: Target): ActionPlan {
    const selected = this.select(target);
    if (action === 'run' && (selected.length !== 1 || selected[0].kind !== 'task')) {
      throw new AppError('INVALID_TARGET', 'Run requires one task ID.');
    }
    if (action === 'restart' && target.entry && selected[0].kind === 'task') {
      throw new AppError('INVALID_TARGET', 'Use Run for a task.');
    }
    const scope = new Set(selected.map((entry) => entry.id));
    const starts: ActionPlan['starts'] = [];
    const planned = new Set<string>();
    const start = (entry: Entry, forceTask = false): void => {
      if (planned.has(entry.id)) {
        return;
      }
      planned.add(entry.id);
      scope.add(entry.id);
      for (const id of entry.dependsOn) {
        start(this.entries.get(id)!);
      }
      starts.push({ entry, forceTask });
    };
    let stops: Entry[] = [];
    if (action === 'stop') {
      stops = topologicalOrder([...scope], this.graphs.startup)
        .reverse()
        .map((id) => this.entries.get(id)!);
    } else if (action === 'restart') {
      const roots = target.entry
        ? selected
        : selected.filter(
            (entry) =>
              entry.kind !== 'task' &&
              ['running', 'starting'].includes(this.adapter(entry).status(entry.id).state),
          );
      const included = new Set<string>();
      const include = (id: string): void => {
        if (included.has(id)) {
          return;
        }
        included.add(id);
        scope.add(id);
        for (const next of this.graphs.restart.get(id) ?? []) {
          include(next);
        }
      };
      for (const entry of roots) {
        include(entry.id);
      }
      const order = topologicalOrder([...included], this.graphs.startup).map((id) =>
        this.entries.get(id)!,
      );
      stops = order.filter((entry) =>
        ['running', 'starting'].includes(this.adapter(entry).status(entry.id).state),
      );
      for (const entry of order) {
        if (stops.includes(entry) || roots.includes(entry)) {
          start(entry);
        }
      }
      stops.reverse();
    } else {
      for (const entry of selected) {
        start(entry, entry.kind === 'task' && (action === 'run' || Boolean(target.project)));
      }
    }
    // Compose create can also create native prerequisites in the same group.
    const groups = new Set<string>();
    for (const id of scope) {
      const group = this.entries.get(id)!.composeGroupId;
      if (group) {
        groups.add(group);
      }
    }
    for (const entry of this.config.entries) {
      if (entry.composeGroupId && groups.has(entry.composeGroupId)) {
        scope.add(entry.id);
      }
    }
    return { scope: [...scope].sort(), stops, starts };
  }
  submit(action: Action, target: Target): Operation {
    const plan = this.plan(action, target);
    return this.admit(action, target, plan.scope, async (operation) => {
      for (const entry of plan.stops) {
        operation.affected.push(entry.id);
        this.health.unwatch(entry.id);
        await this.adapter(entry).stop(entry);
        if (entry.kind === 'task') {
          this.completedTasks.delete(entry.id);
        }
      }
      for (const { entry, forceTask } of plan.starts) {
        await this.start(entry, forceTask, operation);
      }
    });
  }
  private async start(entry: Entry, forceTask: boolean, operation: Operation): Promise<void> {
    if (this.stopping) {
      throw new AppError('MANAGER_STOPPING', 'Manager is stopping.');
    }
    if (entry.kind === 'task' && this.completedTasks.has(entry.id) && !forceTask) {
      return;
    }
    if (!operation.affected.includes(entry.id)) {
      operation.affected.push(entry.id);
    }
    const adapter = this.adapter(entry);
    const previous = adapter.status(entry.id);
    if (entry.kind === 'task') {
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
    } else {
      if (!['running', 'starting'].includes(previous.state)) {
        await adapter.start(entry, this.environment);
      }
      if (this.stopping) {
        throw new AppError('MANAGER_STOPPING', 'Manager is stopping.');
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
    this.changed(operation);
  }
  exclusive(
    action: 'reload' | 'config-edit',
    execute: (operation: Operation) => Promise<void>,
  ): Operation {
    return this.admit(action, {}, null, execute);
  }
  private admit(
    action: string,
    target: Target,
    scope: string[] | null,
    execute: (operation: Operation) => Promise<void>,
  ): Operation {
    if (this.stopping) {
      throw new AppError('MANAGER_STOPPING', 'Manager is stopping.');
    }
    for (const { operation } of this.active.values()) {
      const entryIds =
        scope === null
          ? (operation.scope ?? [])
          : operation.scope === null
            ? scope
            : scope.filter((id) => operation.scope!.includes(id));
      if (scope === null || operation.scope === null || entryIds.length > 0) {
        throw new AppError('OPERATION_BUSY', 'Another operation reserves this scope.', {
          operationId: operation.id,
          entryIds,
        });
      }
    }
    const operation: Operation = {
      id: randomUUID(),
      action,
      target,
      state: 'pending',
      scope,
      affected: [],
      startedAt: new Date().toISOString(),
    };
    const completion = Promise.withResolvers<Operation>();
    this.records.set(operation.id, operation);
    this.active.set(operation.id, { operation, completion: completion.promise });
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
        this.active.delete(operation.id);
        completion.resolve(operation);
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
    return this.active.get(id)?.completion ?? operation;
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
    this.entries = new Map(config.entries.map((entry) => [entry.id, entry]));
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
  async autostart(): Promise<void> {
    this.startupState = { state: 'running' };
    let failure: ErrorData | undefined;
    try {
      const entries = this.config.entries.filter((e) => e.autostart);
      for (const entry of entries) {
        if (entry.kind === 'task' && this.completedTasks.has(entry.id)) {
          continue;
        }
        const operation = this.submit(entry.kind === 'task' ? 'run' : 'start', { entry: entry.id });
        const result = await this.wait(operation.id);
        if (result.state === 'failed' && result.error && !failure) {
          failure = result.error;
        }
      }
      this.startupState = failure ? { state: 'failed', error: failure } : { state: 'succeeded' };
    } catch (error) {
      this.startupState = { state: 'failed', error: errorData(error) };
      throw error;
    }
  }
  startupStatus(): StartupState {
    return this.startupState.error
      ? { state: this.startupState.state, error: this.startupState.error }
      : { state: this.startupState.state };
  }
  shutdownStatus(): { state: 'idle' | 'stopping' } {
    return { state: this.stopping ? 'stopping' : 'idle' };
  }
  impact(): ManagerImpact {
    const processEntryIds: string[] = [];
    const taskIds: string[] = [];
    for (const entry of this.config.entries) {
      if (entry.kind === 'compose') {
        continue;
      }
      const state = this.adapters.process.status(entry.id).state;
      if (!['starting', 'running', 'stopping'].includes(state)) {
        continue;
      }
      if (entry.kind === 'task') {
        taskIds.push(entry.id);
      } else {
        processEntryIds.push(entry.id);
      }
    }
    processEntryIds.sort();
    taskIds.sort();
    const operations = [...this.active.values()]
      .map(({ operation }) => ({ id: operation.id, action: operation.action }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const impactKey = createHash('sha256')
      .update(
        JSON.stringify({
          processEntryIds,
          taskIds,
          operations,
          configPath: this.config.path,
          configSource: this.config.source,
        }),
      )
      .digest('hex');
    return { processEntryIds, taskIds, operations, impactKey };
  }
  admitShutdown(expected?: ShutdownExpectation): void {
    if (this.stopping) {
      if (
        !expected ||
        (this.admitted &&
          this.admitted !== 'open' &&
          this.admitted.pid === expected.pid &&
          this.admitted.startedAt === expected.startedAt &&
          this.admitted.impactKey === expected.impactKey)
      ) {
        return;
      }
      throw new AppError('MANAGER_CONFLICT', 'Shutdown is already in progress.');
    }
    if (expected) {
      if (
        !this.identity ||
        expected.pid !== this.identity.pid ||
        expected.startedAt !== this.identity.startedAt
      ) {
        throw new AppError(
          'MANAGER_CONFLICT',
          'Manager identity changed. No process was signalled.',
        );
      }
      if (expected.impactKey !== this.impact().impactKey) {
        throw new AppError('MANAGER_CONFLICT', 'Restart impact changed. No process was signalled.');
      }
    }
    this.stopping = true;
    this.admitted = expected ?? 'open';
  }
  async shutdown(): Promise<void> {
    this.admitShutdown();
    this.shutdownTask ??= this.stopOwned();
    await this.shutdownTask;
  }
  private async stopOwned(): Promise<void> {
    await this.health.shutdown();
    try {
      await this.adapters.process.shutdown();
      await Promise.all([...this.active.values()].map(({ completion }) => completion));
    } finally {
      await this.adapters.compose.shutdown();
    }
  }
}
