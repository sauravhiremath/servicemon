import type { Operation } from '../../shared/types.js';
import type { ServiceRow } from './service-table.js';

type Priority = { active: boolean; triggeredAt: number; name: string; id: string };
const names = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compare(left: Priority, right: Priority): number {
  return (
    Number(right.active) - Number(left.active) ||
    right.triggeredAt - left.triggeredAt ||
    names.compare(left.name, right.name) ||
    left.id.localeCompare(right.id)
  );
}

function remember(times: Map<string, number>, id: string | undefined, time: number): void {
  if (id) {
    times.set(id, Math.max(times.get(id) ?? 0, time));
  }
}

function collect(rows: readonly ServiceRow[], key: (row: ServiceRow) => string): ServiceRow[][] {
  const groups = new Map<string, ServiceRow[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) {
      group.push(row);
    } else {
      groups.set(id, [row]);
    }
  }
  return [...groups.values()];
}

export function orderServiceRows(
  rows: readonly ServiceRow[],
  operations: readonly Operation[],
  grouped: boolean,
): ServiceRow[] {
  const entries = new Map<string, number>();
  const projects = new Map<string, number>();
  const compose = new Map<string, number>();
  for (const operation of operations) {
    if (!['start', 'run', 'restart', 'stop'].includes(operation.action)) {
      continue;
    }
    const time = Date.parse(operation.startedAt);
    if (!Number.isFinite(time)) {
      continue;
    }
    remember(entries, operation.target.entry, time);
    remember(projects, operation.target.project, time);
    remember(compose, operation.target.compose, time);
    for (const id of operation.affected) {
      remember(entries, id, time);
    }
  }
  const priorities = new Map<string, Priority>();
  for (const { entry } of rows) {
    priorities.set(entry.id, {
      active: entry.state === 'running' || entry.state === 'starting',
      triggeredAt: Math.max(
        entries.get(entry.id) ?? 0,
        projects.get(entry.projectId) ?? 0,
        compose.get(entry.composeGroupId ?? '') ?? 0,
      ),
      name: entry.name,
      id: entry.id,
    });
  }
  const compareRows = (left: ServiceRow, right: ServiceRow) =>
    compare(priorities.get(left.entry.id)!, priorities.get(right.entry.id)!);
  if (!grouped) {
    return [...rows].sort(compareRows);
  }

  function groupPriority(members: ServiceRow[], name: string, id: string): Priority {
    return members.reduce<Priority>(
      (result, row) => {
        const priority = priorities.get(row.entry.id)!;
        return {
          ...result,
          active: result.active || priority.active,
          triggeredAt: Math.max(result.triggeredAt, priority.triggeredAt),
        };
      },
      { active: false, triggeredAt: 0, name, id },
    );
  }

  return collect(rows, (row) => row.entry.projectId)
    .map((members) => ({
      members,
      priority: groupPriority(members, members[0]!.projectName, members[0]!.entry.projectId),
    }))
    .sort((left, right) => compare(left.priority, right.priority))
    .flatMap(({ members }) =>
      collect(members, (row) =>
        row.entry.composeGroupId ? `compose:${row.entry.composeGroupId}` : `entry:${row.entry.id}`,
      )
        .map((block) => ({
          members: block,
          priority: groupPriority(
            block,
            block[0]!.entry.composeGroupId ?? block[0]!.entry.name,
            block[0]!.entry.composeGroupId ?? block[0]!.entry.id,
          ),
        }))
        .sort((left, right) => compare(left.priority, right.priority))
        .flatMap((block) => block.members.sort(compareRows)),
    );
}
