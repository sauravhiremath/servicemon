import type { ErrorData } from './types.js';

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
    public entryId?: string,
    public operationId?: string,
  ) {
    super(message);
  }
}
export function errorData(error: unknown): ErrorData {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
      ...(error.entryId ? { entryId: error.entryId } : {}),
      ...(error.operationId ? { operationId: error.operationId } : {}),
    };
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}
export function exitCode(code: string): number {
  if (code === 'READINESS_TIMEOUT') {
    return 4;
  }
  if (
    [
      'OPERATION_BUSY',
      'MANAGER_CONFLICT',
      'OWNERSHIP_CONFLICT',
      'STALE_CONFIG',
      'CONFIG_BUSY',
    ].includes(code)
  ) {
    return 5;
  }
  if (['MANAGER_UNAVAILABLE', 'DOCKER_UNAVAILABLE', 'TOOL_UNAVAILABLE'].includes(code)) {
    return 3;
  }
  if (
    [
      'INVALID_CONFIG',
      'INVALID_INPUT',
      'INVALID_TARGET',
      'UNKNOWN_ENTRY',
      'CONFIG_NOT_FOUND',
    ].includes(code)
  ) {
    return 2;
  }
  return 1;
}
