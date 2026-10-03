import type {
  Action,
  Envelope,
  ErrorData,
  LogHistory,
  LogRecord,
  Operation,
  RuntimeEvent,
  Snapshot,
} from '../shared/types.js';

export class ApiError extends Error {
  readonly code: string;
  readonly error: ErrorData;
  constructor(error: ErrorData) {
    super(error.message);
    this.name = 'ApiError';
    this.code = error.code;
    this.error = error;
  }
}

export function isLogRecord(value: unknown): value is LogRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Partial<LogRecord>;
  return (
    typeof record.entryId === 'string' &&
    typeof record.runId === 'string' &&
    typeof record.sequence === 'number' &&
    typeof record.text === 'string' &&
    (record.stream === 'stdout' ||
      record.stream === 'stderr' ||
      record.stream === 'boundary' ||
      record.stream === 'gap')
  );
}

export function isOperation(value: unknown): value is Operation {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const operation = value as Partial<Operation>;
  return (
    typeof operation.id === 'string' &&
    typeof operation.action === 'string' &&
    typeof operation.state === 'string' &&
    !!operation.target
  );
}

async function readEnvelope<T>(response: Response): Promise<T> {
  let body: Envelope<T> | null = null;
  try {
    body = (await response.json()) as Envelope<T>;
  } catch {
    throw new ApiError({
      code: response.ok ? 'INVALID_RESPONSE' : 'MANAGER_UNAVAILABLE',
      message: response.ok
        ? 'The manager returned an unreadable response.'
        : `Manager request failed (${response.status}).`,
    });
  }
  if (!body || typeof body !== 'object' || !('ok' in body)) {
    throw new ApiError({
      code: 'INVALID_RESPONSE',
      message: 'The manager returned an incomplete response.',
    });
  }
  if (!body.ok) {
    throw new ApiError(body.error);
  }
  return body.data;
}

export async function getStatus(): Promise<Snapshot> {
  const response = await fetch('/api/status', { headers: { accept: 'application/json' } });
  return readEnvelope<Snapshot>(response);
}

export async function getConfigPath(): Promise<string> {
  const response = await fetch('/api/config/path', { headers: { accept: 'application/json' } });
  const data = await readEnvelope<{ path: string }>(response);
  return data.path;
}

export async function reloadConfig(): Promise<string> {
  const response = await fetch('/api/config/reload', {
    method: 'POST',
    headers: { accept: 'application/json' },
  });
  const data = await readEnvelope<{ operationId: string }>(response);
  if (!data?.operationId) {
    throw new ApiError({
      code: 'INVALID_RESPONSE',
      message: 'Reload did not return an operation ID.',
    });
  }
  return data.operationId;
}

export async function submitEntryAction(id: string, action: Action): Promise<string> {
  const response = await fetch(`/api/entries/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  });
  return operationId(await readEnvelope<unknown>(response));
}

export async function submitTargetAction(
  kind: 'projects' | 'compose-groups',
  id: string,
  action: Exclude<Action, 'run'>,
): Promise<string> {
  const response = await fetch(`/api/${kind}/${encodeURIComponent(id)}/actions`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  return operationId(await readEnvelope<unknown>(response));
}

export async function getOperation(id: string): Promise<Operation> {
  const response = await fetch(`/api/operations/${encodeURIComponent(id)}`, {
    headers: { accept: 'application/json' },
  });
  return readEnvelope<Operation>(response);
}

export async function getLogs(
  id: string,
  query: { after?: number; tail?: number },
): Promise<LogHistory> {
  const params = new URLSearchParams();
  if (query.after !== undefined) {
    params.set('after', String(query.after));
  }
  if (query.tail !== undefined) {
    params.set('tail', String(query.tail));
  }
  const suffix = params.size ? `?${params.toString()}` : '';
  const response = await fetch(`/api/entries/${encodeURIComponent(id)}/logs${suffix}`, {
    headers: { accept: 'application/json' },
  });
  return readEnvelope<LogHistory>(response);
}

function operationId(data: unknown): string {
  if (data && typeof data === 'object') {
    if ('operationId' in data && typeof data.operationId === 'string') {
      return data.operationId;
    }
    if ('id' in data && typeof data.id === 'string' && 'state' in data) {
      return data.id;
    }
  }
  throw new ApiError({
    code: 'INVALID_RESPONSE',
    message: 'The action did not return an operation ID.',
  });
}

export function parseEvent(raw: string): RuntimeEvent | Snapshot | null {
  try {
    return JSON.parse(raw) as RuntimeEvent | Snapshot;
  } catch {
    return null;
  }
}
