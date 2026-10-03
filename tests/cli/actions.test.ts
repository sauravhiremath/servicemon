import { expect, it } from 'vitest';
import type { Operation } from '../../src/shared/types.js';
import { fixtureManager, persistentCommand } from '../helpers/runtime.js';

it('writes clean JSON with operation IDs and distinguishes acceptance from timeout', async () => {
  const manager = await fixtureManager({
    app: {
      services: {
        api: {
          command: persistentCommand,
          readiness_seconds: 0.2,
          healthcheck: {
            type: 'command',
            command: 'exit 1',
            interval_seconds: 0.05,
            timeout_seconds: 0.05,
          },
        },
      },
    },
  });
  try {
    const accepted = await manager.cli('start', 'app/api', '--no-wait', '--json');
    expect(accepted.code).toBe(0);
    const result = JSON.parse(accepted.stdout);
    expect(result.ok).toBe(true);
    expect(result.data.operationId).toMatch(/^[0-9a-f-]+$/);
    const deadline = Date.now() + 5000;
    let operation: Operation;
    do {
      const response = await manager.api<Operation>('/api/operations/' + result.data.operationId);
      if (!response.ok) {
        throw new Error(response.error.message);
      }
      operation = response.data;
    } while (['pending', 'running'].includes(operation.state) && Date.now() < deadline);
    expect(operation.error?.code).toBe('READINESS_TIMEOUT');
    const timedOut = await manager.cli('start', 'app/api', '--json');
    expect(timedOut.code).toBe(4);
    const error = JSON.parse(timedOut.stdout).error;
    expect(error.code).toBe('READINESS_TIMEOUT');
    expect(error.operationId).toBeTruthy();
    const logs = await manager.cli('logs', 'app/api', '--tail', '10', '--json');
    expect(logs.code).toBe(0);
    const records = logs.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      records.some((record) => record.stream === 'stdout' && record.text.includes('started')),
    ).toBe(true);
  } finally {
    await manager.close();
  }
});
it('reports invalid target syntax and a failed task with stable exit codes', async () => {
  const manager = await fixtureManager({ app: { tasks: { fail: { command: 'exit 7' } } } });
  try {
    const invalid = await manager.cli('start', 'ambiguous', '--json');
    expect(invalid.code).toBe(2);
    expect(JSON.parse(invalid.stdout).error.code).toBe('INVALID_TARGET');
    const failed = await manager.cli('run', 'app/fail', '--json');
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout).error.code).toBe('TASK_FAILED');
  } finally {
    await manager.close();
  }
});
