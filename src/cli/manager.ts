import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { configPath, stateDirectory } from '../config/paths.js';
import { processIdentity } from '../config/process-identity.js';
import { loadCandidate } from '../config/reload.js';
import { readInstance } from '../manager/instance.js';
import type { InstanceRecord } from '../manager/instance.js';
import {
  inspectStartupRegistration,
  programArguments,
  renewAndStartRegistration,
} from '../manager/launch-agent.js';
import { assetRoot } from '../server/assets.js';
import { applicationProtocol, packageVersion } from '../shared/build-info.js';
import { AppError, errorData } from '../shared/errors.js';
import { startBackground } from './background.js';
import { createManagerClient, managementCall, readRunningInstance } from './client.js';
import type { ManagerClient } from './client.js';

const RESTART_WAIT_MS = 60_000;
const READY_WAIT_MS = 60_000;

const errorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  entryId: z.string().optional(),
  operationId: z.string().optional(),
});
const launchSettingsSchema = z.object({
  ui: z.string().nullable(),
  port: z.number().int().min(0).max(65535),
});
const managerInfoSchema = z.object({
  managementVersion: z.literal(1),
  version: z.string().min(1),
  applicationProtocol: z.number().int().nonnegative(),
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
  configPath: z.string().min(1),
  endpoint: z.string().min(1),
  launchSettings: launchSettingsSchema,
  startup: z.object({
    state: z.enum(['running', 'succeeded', 'failed']),
    error: errorSchema.optional(),
  }),
  shutdown: z.object({ state: z.enum(['idle', 'stopping']) }),
  impact: z.object({
    processEntryIds: z.array(z.string()),
    taskIds: z.array(z.string()),
    operation: z.union([
      z.null(),
      z.object({ id: z.string().min(1), action: z.string().optional() }),
    ]),
    impactKey: z.string().min(1),
  }),
});

type ManagerInfo = z.infer<typeof managerInfoSchema>;
export interface Inspection {
  record: InstanceRecord;
  info: ManagerInfo;
}
interface RestartReport {
  previous: { pid: number; startedAt: string; version: string };
  current: { pid: number; startedAt: string; version: string; endpoint: string };
  endpoint: string;
  configPath: string;
  port: number;
  ui: string | null;
  startupRegistration: { registered: boolean; label?: string };
  applicationProtocol: number;
}
export interface RestartOutcome {
  report: RestartReport;
  inspection: Inspection;
}
export interface RestartOptions {
  yes?: boolean;
  terminal: boolean;
  explicitConfig?: string;
  confirm?: (prompt: string) => Promise<boolean>;
  waitMs?: number;
  readyMs?: number;
  bound?: Inspection;
}
interface RegistrationSnapshot {
  registered: boolean;
  loaded: boolean;
  label?: string;
  plistPath?: string;
  registrationKey: string;
}
interface PreservedSettings {
  configPath: string;
  port: number;
  ui: string | null;
  environmentCapture?: { loginShell?: string; timeoutMs?: number };
}
interface PreparedRestart {
  source: string;
  impactKey: string;
  pid: number;
  startedAt: string;
  settings: PreservedSettings;
  registration: RegistrationSnapshot;
}
interface ObservedManager {
  running: boolean;
  pid?: number;
  endpoint?: string;
  startedAt?: string;
}

export function commandIsTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY) && !process.argv.includes('--json');
}

function versionMismatch(info: ManagerInfo): AppError {
  const command = 'servicemon manager restart';
  return new AppError(
    'MANAGER_VERSION_MISMATCH',
    `Manager ${info.version} (application protocol ${info.applicationProtocol}) is not compatible with CLI ${packageVersion} (application protocol ${applicationProtocol}). Run ${command}.`,
    {
      cliVersion: packageVersion,
      managerVersion: info.version,
      cliProtocol: applicationProtocol,
      applicationProtocol: info.applicationProtocol,
      command,
    },
  );
}

function explicitConfigArg(): string | undefined {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--config=')) {
      return arg.slice('--config='.length);
    }
  }
  const index = process.argv.indexOf('--config');
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }
  return undefined;
}

function sameCapture(
  left: PreservedSettings['environmentCapture'],
  right: PreservedSettings['environmentCapture'],
): boolean {
  return left?.loginShell === right?.loginShell && left?.timeoutMs === right?.timeoutMs;
}

function restartFailed(
  phase: 'registration' | 'startup' | 'autostart',
  cause: unknown,
  observed: ObservedManager,
): AppError {
  const command = observed.running ? 'servicemon manager status' : 'servicemon serve --background';
  const parsedCause = errorSchema.safeParse(cause);
  const causeData = parsedCause.success ? parsedCause.data : errorData(cause);
  return new AppError(
    'MANAGER_RESTART_FAILED',
    `Restart failed during ${phase}. ${observed.running ? 'A manager is running.' : 'No manager is running.'} Next command: ${command}`,
    {
      phase,
      cause: causeData,
      running: observed.running,
      endpoint: observed.endpoint,
      pid: observed.pid,
      command,
    },
  );
}

async function observedManager(): Promise<ObservedManager> {
  let record: InstanceRecord | undefined;
  try {
    record = await readInstance(stateDirectory());
  } catch (error) {
    if (error instanceof AppError && error.code === 'OWNERSHIP_CONFLICT') {
      return { running: true };
    }
    throw error;
  }
  if (!record?.endpoint) {
    return { running: false };
  }
  const identity = await processIdentity(record.pid);
  const running = identity.state === 'alive' && identity.startedAt === record.startedAt;
  if (identity.state === 'uncertain') {
    return {
      running: true,
      pid: record.pid,
      endpoint: record.endpoint,
      startedAt: record.startedAt,
    };
  }
  return {
    running,
    pid: record.pid,
    endpoint: record.endpoint,
    startedAt: record.startedAt,
  };
}

async function inspectRecord(record: InstanceRecord): Promise<Inspection> {
  const data = await managementCall<unknown>(record, '/api/manager/info');
  const parsed = managerInfoSchema.safeParse(data);
  if (!parsed.success) {
    throw new AppError(
      'MANAGER_UNAVAILABLE',
      'The manager returned an invalid management response.',
    );
  }
  const info = parsed.data;
  if (
    info.pid !== record.pid ||
    info.startedAt !== record.startedAt ||
    info.endpoint !== record.endpoint ||
    resolve(info.configPath) !== resolve(record.configPath)
  ) {
    throw new AppError(
      'MANAGER_CONFLICT',
      'The manager identity does not match its instance record.',
      {
        record: { pid: record.pid, startedAt: record.startedAt, endpoint: record.endpoint },
        manager: { pid: info.pid, startedAt: info.startedAt, endpoint: info.endpoint },
      },
    );
  }
  return { record, info };
}

function admitObserved(inspection: Inspection): Inspection {
  if (inspection.info.applicationProtocol !== applicationProtocol) {
    throw versionMismatch(inspection.info);
  }
  return inspection;
}

async function askConsent(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  let settled = false;
  const onSigint = (): void => {
    finish('');
  };
  const finish = (value: string): void => {
    if (settled) {
      return;
    }
    settled = true;
    process.removeListener('SIGINT', onSigint);
    resolveAnswer(value);
  };
  let resolveAnswer: (value: string) => void = () => {};
  try {
    const answer = await new Promise<string>((resolve) => {
      resolveAnswer = resolve;
      process.once('SIGINT', onSigint);
      rl.once('close', () => finish(''));
      rl.question(prompt, (value) => finish(value));
    });
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    process.removeListener('SIGINT', onSigint);
    rl.close();
  }
}

function restartPrompt(info: ManagerInfo): string {
  const operation = info.impact.operation;
  const dashboard = info.launchSettings.ui ?? 'built-in';
  return [
    'Restart the running manager?',
    `Running version: ${info.version}`,
    `Installed version: ${packageVersion}`,
    `Config: ${info.configPath}`,
    `Dashboard: ${dashboard}`,
    `Owned processes: ${info.impact.processEntryIds.join(', ') || 'none'}`,
    `Active tasks: ${info.impact.taskIds.join(', ') || 'none'}`,
    `Active operation: ${operation ? `${operation.id}${operation.action ? ` (${operation.action})` : ''}` : 'none'}`,
    'Compose containers stay running.',
    'Only normal autostart runs after replacement.',
    'Task output and operation IDs do not make tasks safe to replay.',
    'Restart this manager? [y/N] ',
  ].join('\n');
}

async function registrationSnapshot(
  configPath: string,
  stateDir: string,
): Promise<RegistrationSnapshot> {
  const inspection = await inspectStartupRegistration(configPath, stateDir);
  if (typeof inspection.registrationKey !== 'string' || inspection.registrationKey.length === 0) {
    throw new AppError(
      'MANAGER_UNAVAILABLE',
      'The manager returned an invalid management response.',
    );
  }
  return inspection;
}

async function prepareRestart(
  inspection: Inspection,
  explicitConfig: string | undefined,
): Promise<PreparedRestart> {
  if (explicitConfig !== undefined) {
    const requested = configPath(explicitConfig);
    if (resolve(requested) !== resolve(inspection.info.configPath)) {
      throw new AppError(
        'MANAGER_CONFLICT',
        'The requested config does not match the running manager.',
        {
          active: inspection.info.configPath,
          requested,
        },
      );
    }
  }
  let source: string;
  try {
    source = await readFile(inspection.info.configPath, 'utf8');
  } catch (error) {
    throw new AppError('CONFIG_NOT_FOUND', 'The manager config file is not readable.', {
      path: inspection.info.configPath,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  await loadCandidate(inspection.info.configPath, source);
  try {
    await assetRoot(inspection.info.launchSettings.ui ?? undefined);
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError('INVALID_INPUT', 'The dashboard file is not available.', {
      ui: inspection.info.launchSettings.ui,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const registration = await registrationSnapshot(inspection.info.configPath, stateDirectory());
  if (typeof registration?.registered !== 'boolean' || typeof registration.loaded !== 'boolean') {
    throw new AppError(
      'MANAGER_UNAVAILABLE',
      'The manager returned an invalid management response.',
    );
  }
  if (registration.registered) {
    programArguments(inspection.info.launchSettings);
  }
  return {
    source,
    impactKey: inspection.info.impact.impactKey,
    pid: inspection.record.pid,
    startedAt: inspection.record.startedAt,
    settings: {
      configPath: inspection.info.configPath,
      port: inspection.info.launchSettings.port,
      ui: inspection.info.launchSettings.ui,
      ...(inspection.record.metadata.launchSettings.environmentCapture
        ? {
            environmentCapture: inspection.record.metadata.launchSettings.environmentCapture,
          }
        : {}),
    },
    registration,
  };
}

async function recheckRestart(
  prepared: PreparedRestart,
): Promise<{ inspection: Inspection; registration: RegistrationSnapshot }> {
  const inspection = await inspectRecord(await readRunningInstance());
  const changes: string[] = [];
  if (
    inspection.record.pid !== prepared.pid ||
    inspection.record.startedAt !== prepared.startedAt
  ) {
    changes.push('identity');
  }
  if (inspection.info.impact.impactKey !== prepared.impactKey) {
    changes.push('impact');
  }
  let source = '';
  try {
    source = await readFile(inspection.info.configPath, 'utf8');
  } catch {
    changes.push('config');
  }
  if (source !== prepared.source && !changes.includes('config')) {
    changes.push('config');
  }
  const launch = inspection.info.launchSettings;
  const recorded = inspection.record.metadata.launchSettings;
  if (
    launch.port !== prepared.settings.port ||
    recorded.port !== prepared.settings.port ||
    launch.ui !== prepared.settings.ui ||
    recorded.ui !== prepared.settings.ui ||
    !sameCapture(recorded.environmentCapture, prepared.settings.environmentCapture)
  ) {
    changes.push('launch settings');
  }
  const registration = await registrationSnapshot(inspection.info.configPath, stateDirectory());
  if (registration.registrationKey !== prepared.registration.registrationKey) {
    changes.push('registration');
  }
  if (changes.length > 0) {
    throw new AppError(
      'MANAGER_CONFLICT',
      `Restart cancelled because ${changes.join(', ')} changed.`,
      { changes },
    );
  }
  return { inspection, registration };
}

async function shutdownState(record: InstanceRecord): Promise<string> {
  try {
    const info = await inspectRecord(record);
    return info.info.shutdown.state;
  } catch {
    return 'unavailable';
  }
}

async function waitForExit(record: InstanceRecord, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const identity = await processIdentity(record.pid);
    if (identity.state === 'uncertain') {
      throw new AppError(
        'OWNERSHIP_CONFLICT',
        'Manager process identity is uncertain. No further signal was sent.',
        { pid: record.pid, startedAt: record.startedAt },
      );
    }
    const gone = identity.state === 'dead' || identity.startedAt !== record.startedAt;
    let current: InstanceRecord | undefined;
    try {
      current = await readInstance(stateDirectory());
    } catch (error) {
      if (!(error instanceof AppError && error.code === 'OWNERSHIP_CONFLICT')) {
        throw error;
      }
      current = record;
    }
    const owns = current?.pid === record.pid && current.startedAt === record.startedAt;
    if (gone && !owns) {
      return;
    }
    await delay(100);
  }
  const observed = await observedManager();
  const shutdown = await shutdownState(record);
  const command = observed.running ? 'servicemon manager status' : 'servicemon serve --background';
  throw new AppError(
    'MANAGER_RESTART_TIMEOUT',
    `Restart timed out during shutdown. ${observed.running ? 'The manager process is still running.' : 'The manager process is not running.'} Shutdown state: ${shutdown}. No replacement was started. Next command: ${command}`,
    {
      phase: 'shutdown',
      pid: record.pid,
      startedAt: record.startedAt,
      shutdown,
      running: observed.running,
      endpoint: observed.endpoint,
      command,
    },
  );
}

function replacementDifferences(inspection: Inspection, settings: PreservedSettings): string[] {
  const differences: string[] = [];
  if (resolve(inspection.info.configPath) !== resolve(settings.configPath)) {
    differences.push('config');
  }
  let port: number | undefined;
  try {
    const parsed = new URL(inspection.info.endpoint).port;
    port = parsed ? Number(parsed) : undefined;
  } catch {
    port = undefined;
  }
  if (
    inspection.info.launchSettings.port !== settings.port ||
    inspection.record.metadata.launchSettings.port !== settings.port ||
    port !== settings.port
  ) {
    differences.push('port');
  }
  if (
    inspection.info.launchSettings.ui !== settings.ui ||
    inspection.record.metadata.launchSettings.ui !== settings.ui
  ) {
    differences.push('dashboard');
  }
  if (
    !sameCapture(
      inspection.record.metadata.launchSettings.environmentCapture,
      settings.environmentCapture,
    )
  ) {
    differences.push('environment capture');
  }
  if (inspection.info.version !== packageVersion) {
    differences.push('version');
  }
  if (inspection.info.applicationProtocol !== applicationProtocol) {
    differences.push('protocol');
  }
  return differences;
}

async function waitForReady(
  previous: { pid: number; startedAt: string },
  settings: PreservedSettings,
  readyMs: number,
): Promise<Inspection> {
  const deadline = Date.now() + readyMs;
  let phase: 'startup' | 'autostart' = 'startup';
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const record = await readInstance(stateDirectory());
      if (
        record?.endpoint &&
        (record.pid !== previous.pid || record.startedAt !== previous.startedAt)
      ) {
        const inspection = await inspectRecord(record);
        const differences = replacementDifferences(inspection, settings);
        if (differences.length > 0) {
          throw restartFailed(
            'startup',
            `Replacement does not match the preserved settings: ${differences.join(', ')}.`,
            { running: true, pid: record.pid, endpoint: record.endpoint },
          );
        }
        if (inspection.info.startup.state === 'failed') {
          throw restartFailed('autostart', inspection.info.startup.error, {
            running: true,
            pid: record.pid,
            endpoint: record.endpoint,
          });
        }
        if (inspection.info.startup.state === 'succeeded') {
          return inspection;
        }
        phase = 'autostart';
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'MANAGER_RESTART_FAILED') {
        throw error;
      }
      lastError = error;
    }
    await delay(100);
  }
  throw restartFailed(
    phase,
    lastError ?? 'Replacement did not become ready.',
    await observedManager(),
  );
}

async function launchReplacement(previous: Inspection, prepared: PreparedRestart): Promise<void> {
  const state = stateDirectory();
  if (prepared.registration.registered) {
    try {
      await renewAndStartRegistration({
        configPath: prepared.settings.configPath,
        stateDir: state,
        port: prepared.settings.port,
        ui: prepared.settings.ui,
        ...(prepared.settings.environmentCapture
          ? { environmentCapture: prepared.settings.environmentCapture }
          : {}),
      });
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'MANAGER_CONFLICT' || error.code === 'OWNERSHIP_CONFLICT')
      ) {
        throw error;
      }
      throw restartFailed('registration', error, await observedManager());
    }
    return;
  }
  try {
    await startBackground({
      config: prepared.settings.configPath,
      state,
      port: prepared.settings.port,
      ...(prepared.settings.ui ? { ui: prepared.settings.ui } : {}),
      environmentCapture: prepared.settings.environmentCapture ?? {},
      replace: { pid: previous.record.pid, startedAt: previous.record.startedAt },
    });
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === 'MANAGER_CONFLICT' || error.code === 'OWNERSHIP_CONFLICT')
    ) {
      throw error;
    }
    throw restartFailed('startup', error, await observedManager());
  }
}

export async function restartManager(options: RestartOptions): Promise<RestartOutcome> {
  let phase = 'preflight';
  try {
    const record = await readRunningInstance();
    if (
      options.bound &&
      (record.pid !== options.bound.record.pid ||
        record.startedAt !== options.bound.record.startedAt ||
        record.endpoint !== options.bound.record.endpoint ||
        record.token !== options.bound.record.token)
    ) {
      throw new AppError('MANAGER_CONFLICT', 'The selected manager changed during this command.', {
        expected: { pid: options.bound.record.pid, startedAt: options.bound.record.startedAt },
        observed: { pid: record.pid, startedAt: record.startedAt },
      });
    }
    if (!options.terminal && options.yes !== true) {
      throw new AppError(
        'INVALID_INPUT',
        'Restart stops owned processes and active tasks. Compose containers stay running, and only normal autostart runs again. Re-run with: servicemon manager restart --yes',
      );
    }
    const initial = await inspectRecord(record);
    const explicit = options.explicitConfig ?? explicitConfigArg();
    const prepared = await prepareRestart(initial, explicit);
    phase = 'confirmation';
    if (options.yes !== true) {
      const confirm = options.confirm ?? askConsent;
      const consented = await confirm(restartPrompt(initial.info));
      if (!consented) {
        throw new AppError(
          'MANAGER_RESTART_CANCELLED',
          'Restart was not confirmed. The manager is still running.',
        );
      }
    }
    phase = 'recheck';
    const checked = await recheckRestart(prepared);
    const stopBody = {
      expected: {
        pid: checked.inspection.record.pid,
        startedAt: checked.inspection.record.startedAt,
        impactKey: checked.inspection.info.impact.impactKey,
      },
    };
    phase = 'shutdown';
    const stopped = await managementCall<{ stopping?: boolean }>(
      checked.inspection.record,
      '/api/manager/stop',
      stopBody,
    );
    if (stopped?.stopping !== true) {
      throw new AppError(
        'MANAGER_UNAVAILABLE',
        'The manager returned an invalid management response.',
      );
    }
    await waitForExit(checked.inspection.record, options.waitMs ?? RESTART_WAIT_MS);
    phase = prepared.registration.registered ? 'registration' : 'startup';
    await launchReplacement(checked.inspection, prepared);
    phase = 'startup';
    const ready = await waitForReady(
      { pid: checked.inspection.record.pid, startedAt: checked.inspection.record.startedAt },
      prepared.settings,
      options.readyMs ?? READY_WAIT_MS,
    );
    const label = prepared.registration.label;
    return {
      inspection: ready,
      report: {
        previous: {
          pid: initial.record.pid,
          startedAt: initial.record.startedAt,
          version: initial.info.version,
        },
        current: {
          pid: ready.record.pid,
          startedAt: ready.record.startedAt,
          version: ready.info.version,
          endpoint: ready.record.endpoint,
        },
        endpoint: ready.record.endpoint,
        configPath: ready.info.configPath,
        port: ready.info.launchSettings.port,
        ui: ready.info.launchSettings.ui,
        startupRegistration: {
          registered: prepared.registration.registered,
          ...(label ? { label } : {}),
        },
        applicationProtocol: ready.info.applicationProtocol,
      },
    };
  } catch (error) {
    const cause = errorData(error);
    const details = cause.details && typeof cause.details === 'object' ? cause.details : {};
    if ('phase' in details) {
      throw error;
    }
    const observed = await observedManager();
    const command = observed.running
      ? 'servicemon manager status'
      : 'servicemon serve --background';
    throw new AppError(
      cause.code,
      `${cause.message} Restart phase: ${phase}. ${observed.running ? 'A manager is running.' : 'No manager is running.'} Next command: ${command}`,
      {
        ...details,
        phase,
        running: observed.running,
        pid: observed.pid,
        endpoint: observed.endpoint,
        command,
      },
      cause.entryId,
      cause.operationId,
    );
  }
}

async function admitApplication(
  inspection: Inspection,
  options: RestartOptions,
): Promise<Inspection> {
  const info = inspection.info;
  const sameProtocol = info.applicationProtocol === applicationProtocol;
  const sameVersion = info.version === packageVersion;
  if (sameProtocol && sameVersion) {
    return inspection;
  }
  if (sameProtocol) {
    if (!options.terminal) {
      console.error(
        `Manager ${info.version} is running. This CLI is ${packageVersion}. Protocols match, so this command continues.`,
      );
      return inspection;
    }
    try {
      const restarted = await restartManager({
        ...options,
        yes: false,
        terminal: true,
        bound: inspection,
      });
      return restarted.inspection;
    } catch (error) {
      if (error instanceof AppError && error.code === 'MANAGER_RESTART_CANCELLED') {
        return inspection;
      }
      throw error;
    }
  }
  if (!options.terminal) {
    throw versionMismatch(info);
  }
  try {
    const restarted = await restartManager({
      ...options,
      yes: false,
      terminal: true,
      bound: inspection,
    });
    return restarted.inspection;
  } catch (error) {
    if (error instanceof AppError && error.code === 'MANAGER_RESTART_CANCELLED') {
      throw versionMismatch(info);
    }
    throw error;
  }
}

export function createCommandClient(options: RestartOptions): ManagerClient {
  return createManagerClient({
    inspect: inspectRecord,
    admitObserved,
    admitApplication: (inspection) => admitApplication(inspection, options),
  });
}

export async function managerStatus(): Promise<{
  running: true;
  endpoint: string;
  configPath: string;
  pid: number;
  cliVersion: string;
  managerVersion: string;
  applicationProtocol: number;
  compatible: boolean;
  restartRequired: boolean;
}> {
  const inspection = await inspectRecord(await readRunningInstance());
  const compatible = inspection.info.applicationProtocol === applicationProtocol;
  return {
    running: true,
    endpoint: inspection.record.endpoint,
    configPath: inspection.record.configPath,
    pid: inspection.record.pid,
    cliVersion: packageVersion,
    managerVersion: inspection.info.version,
    applicationProtocol: inspection.info.applicationProtocol,
    compatible,
    restartRequired: !compatible,
  };
}

export async function managerStop(): Promise<{ stopping: true }> {
  const record = await readRunningInstance();
  const stopped = await managementCall<{ stopping?: boolean }>(record, '/api/manager/stop', {});
  if (stopped?.stopping !== true) {
    throw new AppError(
      'MANAGER_UNAVAILABLE',
      'The manager returned an invalid management response.',
    );
  }
  return { stopping: true };
}
