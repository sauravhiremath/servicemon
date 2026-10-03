import { AppError } from '../shared/errors.js';
import type { Entry } from '../shared/types.js';

export interface ValidatedGraphs {
  startup: Map<string, string[]>;
  restart: Map<string, string[]>;
}
export function validateGraphs(entries: Entry[]): ValidatedGraphs {
  const index = new Map(entries.map((entry) => [entry.id, entry]));
  if (index.size !== entries.length) {
    throw new AppError('INVALID_CONFIG', 'Duplicate entry ID.');
  }
  const startup = new Map<string, string[]>();
  const restart = new Map<string, string[]>();
  for (const entry of entries) {
    for (const dependency of entry.dependsOn) {
      if (!index.has(dependency)) {
        throw new AppError('INVALID_CONFIG', `Missing dependency ${dependency} for ${entry.id}.`);
      }
    }
    startup.set(entry.id, [...new Set(entry.dependsOn)]);
    restart.set(entry.id, []);
  }
  for (const entry of entries) {
    if (entry.kind === 'task') {
      continue;
    }
    const edges = restart.get(entry.id)!;
    if (entry.restartDependencies) {
      edges.push(...entry.dependsOn.filter((id) => index.get(id)!.kind !== 'task'));
    }
    if (entry.restartDependents) {
      edges.push(
        ...entries
          .filter((other) => other.kind !== 'task' && other.dependsOn.includes(entry.id))
          .map((other) => other.id),
      );
    }
  }
  for (const [name, graph] of [
    ['startup', startup],
    ['restart', restart],
  ] as const) {
    const complete = new Set<string>();
    const path: string[] = [];
    const visit = (id: string): void => {
      const cycle = path.indexOf(id);
      if (cycle >= 0) {
        throw new AppError(
          'INVALID_CONFIG',
          `${name} graph cycle: ${[...path.slice(cycle), id].join(' -> ')}`,
          { graph: name, cycle: [...path.slice(cycle), id] },
        );
      }
      if (complete.has(id)) {
        return;
      }
      path.push(id);
      for (const edge of graph.get(id) ?? []) {
        visit(edge);
      }
      path.pop();
      complete.add(id);
    };
    for (const id of graph.keys()) {
      visit(id);
    }
  }
  return { startup, restart };
}
export function topologicalOrder(ids: string[], startup: Map<string, string[]>): string[] {
  const selected = new Set(ids),
    visited = new Set<string>(),
    ordered: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    visited.add(id);
    for (const prerequisite of startup.get(id) ?? []) {
      if (selected.has(prerequisite)) {
        visit(prerequisite);
      }
    }
    ordered.push(id);
  };
  for (const id of ids) {
    visit(id);
  }
  return ordered;
}
