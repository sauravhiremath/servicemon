import { setTimeout as delay } from 'node:timers/promises';
import { stateDirectory } from '../config/paths.js';
import { readInstance } from '../manager/instance.js';
import type { InstanceRecord } from '../manager/instance.js';
import { AppError } from '../shared/errors.js';
import type { Envelope, Operation } from '../shared/types.js';
import type { Inspection } from './manager.js';

const REQUEST_TIMEOUT_MS = 10_000;

type Admission = 'application' | 'observe';

export interface ManagerClient {
  request<T>(path: string, body?: unknown, admission?: Admission): Promise<T>;
  observeOperation(id: string): Promise<Operation>;
}

export async function readRunningInstance(): Promise<InstanceRecord> {
  const record = await readInstance(stateDirectory());
  if (!record?.endpoint) {
    throw new AppError('MANAGER_UNAVAILABLE', 'No manager is running.');
  }
  return record;
}

export async function managementCall<T>(
  record: InstanceRecord,
  path: string,
  body?: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(record.endpoint + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined ? {} : { Origin: record.endpoint, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new AppError(
      'MANAGER_UNAVAILABLE',
      'Cannot connect to the manager.',
      error instanceof Error ? error.message : String(error),
    );
  }
  let result: Envelope<T>;
  try {
    result = (await response.json()) as Envelope<T>;
  } catch {
    throw new AppError(
      'MANAGER_UNAVAILABLE',
      'The manager returned an invalid management response.',
    );
  }
  if (!result || typeof result !== 'object' || !('ok' in result)) {
    throw new AppError(
      'MANAGER_UNAVAILABLE',
      'The manager returned an invalid management response.',
    );
  }
  if (!result.ok) {
    throw new AppError(
      result.error.code,
      result.error.message,
      result.error.details,
      result.error.entryId,
      result.error.operationId,
    );
  }
  return result.data;
}

function sameIdentity(record: InstanceRecord, inspection: Inspection): boolean {
  return (
    record.pid === inspection.record.pid &&
    record.startedAt === inspection.record.startedAt &&
    record.endpoint === inspection.record.endpoint &&
    record.token === inspection.record.token &&
    record.configPath === inspection.record.configPath
  );
}

export function createManagerClient(deps: {
  inspect: (record: InstanceRecord) => Promise<Inspection>;
  admitApplication: (inspection: Inspection) => Promise<Inspection>;
  admitObserved: (inspection: Inspection) => Inspection;
}): ManagerClient {
  let bound: Inspection | undefined;
  let admitting = false;

  const bind = async (admission: Admission): Promise<Inspection> => {
    if (bound) {
      return bound;
    }
    if (admitting) {
      throw new AppError(
        'MANAGER_CONFLICT',
        'Manager admission cannot run again during this command.',
      );
    }
    admitting = true;
    try {
      const inspection = await deps.inspect(await readRunningInstance());
      bound =
        admission === 'observe'
          ? deps.admitObserved(inspection)
          : await deps.admitApplication(inspection);
      return bound;
    } finally {
      admitting = false;
    }
  };

  const request = async <T>(
    path: string,
    body?: unknown,
    admission: Admission = 'application',
  ): Promise<T> => {
    const inspection = await bind(admission);
    const record = await readInstance(stateDirectory());
    if (!record?.endpoint || !sameIdentity(record, inspection)) {
      throw new AppError('MANAGER_CONFLICT', 'The selected manager changed during this command.', {
        expected: { pid: inspection.record.pid, startedAt: inspection.record.startedAt },
        observed: record
          ? { pid: record.pid, startedAt: record.startedAt }
          : { pid: null, startedAt: null },
      });
    }
    return managementCall<T>(record, path, body);
  };

  return {
    request,
    async observeOperation(id: string): Promise<Operation> {
      while (true) {
        let operation: Operation;
        try {
          operation = await request<Operation>('/api/operations/' + encodeURIComponent(id));
        } catch (error) {
          if (
            error instanceof AppError &&
            error.code === 'MANAGER_CONFLICT' &&
            !error.operationId
          ) {
            throw new AppError(error.code, error.message, error.details, error.entryId, id);
          }
          throw error;
        }
        if (!['pending', 'running'].includes(operation.state)) {
          if (operation.state === 'failed') {
            const error = operation.error!;
            throw new AppError(
              error.code,
              error.message,
              error.details,
              error.entryId,
              operation.id,
            );
          }
          return operation;
        }
        await delay(100);
      }
    },
  };
}
