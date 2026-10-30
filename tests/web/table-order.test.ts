import { describe, expect, it } from 'vitest';
import type { EntryStatus, Operation } from '../../src/shared/types.js';
import { orderServiceRows } from '../../src/web/table/order.js';
import type { ServiceRow } from '../../src/web/table/service-table.js';

function row(id: string, overrides: Partial<EntryStatus> = {}): ServiceRow {
  const [projectId, name] = id.split('/') as [string, string];
  return {
    projectName: projectId,
    commandLabel: '',
    entry: {
      id,
      projectId,
      name,
      key: name,
      kind: 'service',
      directory: '.',
      links: [],
      dependsOn: [],
      autostart: false,
      restartDependencies: false,
      restartDependents: false,
      stopSeconds: 10,
      readinessSeconds: 60,
      state: 'stopped',
      health: 'no-check',
      ...overrides,
    },
  };
}

function operation(entry: string, seconds: number, overrides: Partial<Operation> = {}): Operation {
  return {
    id: `${entry}:${seconds}`,
    action: 'start',
    target: { entry },
    state: 'succeeded',
    scope: [entry],
    affected: [entry],
    startedAt: new Date(seconds * 1000).toISOString(),
    ...overrides,
  };
}

function ids(rows: readonly ServiceRow[], operations: Operation[] = [], grouped = false) {
  return orderServiceRows(rows, operations, grouped).map(({ entry }) => entry.id);
}

describe('dashboard default order', () => {
  it('puts running and starting entries before more recently stopped entries', () => {
    const rows = [
      row('app/a'),
      row('app/b', { state: 'running' }),
      row('app/c', { state: 'starting' }),
    ];
    expect(
      ids(rows, [operation('app/a', 30), operation('app/b', 10), operation('app/c', 20)]),
    ).toEqual(['app/c', 'app/b', 'app/a']);
  });

  it.each(['run', 'start', 'restart', 'stop'])(
    'counts the latest %s trigger, not completion time',
    (action) => {
      expect(
        ids(
          [row('app/a'), row('app/b')],
          [
            operation('app/a', 10, { finishedAt: new Date(30000).toISOString() }),
            operation('app/b', 20, { action }),
            operation('app/b', 5),
          ],
        ),
      ).toEqual(['app/b', 'app/a']);
    },
  );

  it('counts failed direct targets and affected dependencies but not reserved-only entries', () => {
    const rows = [row('app/a'), row('app/b'), row('app/c')];
    expect(
      ids(rows, [
        operation('app/c', 10, {
          state: 'failed',
          scope: ['app/a', 'app/b', 'app/c'],
          affected: ['app/b'],
        }),
      ]),
    ).toEqual(['app/b', 'app/c', 'app/a']);
  });

  it('counts project and Compose targets without touching unrelated entries', () => {
    const rows = [
      row('other/a'),
      row('app/b'),
      row('other/c', { kind: 'compose', composeGroupId: 'other/infra' }),
    ];
    expect(
      ids(rows, [
        operation('', 10, { target: { project: 'app' }, affected: [] }),
        operation('', 20, { target: { compose: 'other/infra' }, affected: [] }),
      ]),
    ).toEqual(['other/c', 'app/b', 'other/a']);
  });

  it('ignores reloads, config edits, and invalid action times', () => {
    expect(
      ids(
        [row('app/b'), row('app/a')],
        [
          operation('app/b', 10, { action: 'reload', scope: null }),
          operation('app/b', 20, { action: 'config-edit' }),
          operation('app/b', 30, { startedAt: 'invalid' }),
        ],
      ),
    ).toEqual(['app/a', 'app/b']);
  });

  it('uses numeric name order and IDs for ties without changing its inputs', () => {
    const rows = Object.freeze([row('z/svc-10'), row('z/svc-2'), row('b/api'), row('a/api')]);
    const before = structuredClone(rows);
    expect(ids(rows)).toEqual(['a/api', 'b/api', 'z/svc-2', 'z/svc-10']);
    expect(rows).toEqual(before);
  });

  it('keeps projects together and ranks active projects before recent inactive projects', () => {
    const rows = [row('a/a'), row('a/b'), row('z/c', { state: 'running' }), row('z/d'), row('b/e')];
    expect(
      ids(rows, [operation('b/e', 30), operation('z/d', 20), operation('a/b', 10)], true),
    ).toEqual(['z/c', 'z/d', 'b/e', 'a/b', 'a/a']);
  });

  it('orders active projects by their latest trigger and breaks project-name ties by ID', () => {
    const rows = [row('a/a', { state: 'running' }), row('z/b', { state: 'running' })];
    expect(ids(rows, [operation('z/b', 10)], true)).toEqual(['z/b', 'a/a']);
    const sameName = rows.map((item) => ({ ...item, projectName: 'Same name' })).reverse();
    expect(ids(sameName, [], true)).toEqual(['a/a', 'z/b']);
  });

  it('keeps Compose blocks together while ranking blocks and members by activity and time', () => {
    const rows = [
      row('app/a'),
      row('app/b', { kind: 'compose', composeGroupId: 'app/infra' }),
      row('app/c', { kind: 'compose', composeGroupId: 'app/infra', state: 'running' }),
      row('app/d', { state: 'running' }),
      row('app/e', { kind: 'compose', composeGroupId: 'app/other' }),
    ];
    const actions = [operation('app/d', 10), operation('app/b', 20), operation('app/e', 30)];
    expect(ids(rows, actions, true)).toEqual(['app/c', 'app/b', 'app/d', 'app/e', 'app/a']);
    expect(ids(rows, actions)).toEqual(['app/d', 'app/c', 'app/e', 'app/b', 'app/a']);
  });

  it('handles an empty snapshot', () => {
    expect(ids([], [], true)).toEqual([]);
    expect(ids([])).toEqual([]);
  });
});
