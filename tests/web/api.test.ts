import { describe, expect, it } from 'vitest';
import { isOperation } from '../../src/web/api.js';

describe('operation event reservations', () => {
  const operation = {
    id: 'operation-1',
    action: 'start',
    state: 'running',
    target: { entry: 'app/api' },
  };

  it('requires an entry ID array or exclusive scope', () => {
    expect(isOperation(operation)).toBe(false);
    for (const scope of [undefined, 'app/api', [null], [1], {}]) {
      expect(isOperation({ ...operation, scope })).toBe(false);
    }
    expect(isOperation({ ...operation, scope: ['app/setup', 'app/api'] })).toBe(true);
    expect(isOperation({ ...operation, scope: [] })).toBe(true);
    expect(isOperation({ ...operation, scope: null })).toBe(true);
  });
});
