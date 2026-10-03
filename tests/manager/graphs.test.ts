import { describe, expect, it } from 'vitest';
import { validateGraphs, topologicalOrder } from '../../src/manager/graphs.js';
import type { Entry } from '../../src/shared/types.js';

const entry = (id: string, dependsOn: string[] = [], extra: Partial<Entry> = {}): Entry => ({
  id,
  projectId: id.split('/')[0],
  key: id.split('/')[1],
  name: id,
  kind: 'service',
  directory: '/tmp',
  links: [],
  dependsOn,
  autostart: false,
  restartDependencies: false,
  restartDependents: false,
  stopSeconds: 1,
  readinessSeconds: 1,
  ...extra,
});
describe('validated dependency and restart graphs', () => {
  it('orders shared cross-project prerequisites once', () => {
    const { startup } = validateGraphs([
      entry('db/pg'),
      entry('app/setup', ['db/pg'], { kind: 'task' }),
      entry('app/api', ['app/setup']),
      entry('app/ui', ['app/api']),
    ]);
    expect(topologicalOrder(['app/ui', 'app/api', 'db/pg', 'app/setup'], startup)).toEqual([
      'db/pg',
      'app/setup',
      'app/api',
      'app/ui',
    ]);
  });
  it('reports the complete startup cycle', () => {
    expect(() => validateGraphs([entry('a/api', ['b/db']), entry('b/db', ['a/api'])])).toThrow(
      'startup graph cycle: a/api -> b/db -> a/api',
    );
  });
  it('rejects mutual restart selection even with valid startup order', () => {
    expect(() =>
      validateGraphs([
        entry('a/db', [], { restartDependents: true }),
        entry('a/api', ['a/db'], { restartDependencies: true }),
      ]),
    ).toThrow('restart graph cycle: a/db -> a/api -> a/db');
  });
  it('does not select tasks as restart targets', () => {
    const { restart } = validateGraphs([
      entry('a/setup', [], { kind: 'task' }),
      entry('a/api', ['a/setup'], { restartDependencies: true }),
    ]);
    expect(restart.get('a/api')).toEqual([]);
  });
  it('rejects missing dependencies and duplicate IDs', () => {
    expect(() => validateGraphs([entry('a/api', ['b/missing'])])).toThrow('Missing dependency');
    expect(() => validateGraphs([entry('a/api'), entry('a/api')])).toThrow('Duplicate entry ID');
  });
});
