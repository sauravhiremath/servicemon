import { discoverGroups } from '../compose/discovery.js';
import { captureEnvironment } from '../manager/environment.js';
import { validateGraphs } from '../manager/graphs.js';
import type { Operations } from '../manager/operations.js';
import { AppError } from '../shared/errors.js';
import type { Adapter, CompiledConfig, Operation } from '../shared/types.js';
import { compileConfig, readConfigText } from './compile.js';

export interface Candidate {
  config: CompiledConfig;
  environment: NodeJS.ProcessEnv;
}
export async function loadCandidate(path: string, source?: string): Promise<Candidate> {
  const text = source ?? (await readConfigText(path));
  const initial = compileConfig(text, path);
  const environment = await captureEnvironment();
  const discoveries = await discoverGroups(initial.groups, environment);
  const config = compileConfig(text, path, discoveries);
  validateGraphs(config.entries);
  return { config, environment };
}
export async function applyCandidate(
  operations: Operations,
  candidate: Candidate,
  adapters: { process: Adapter; compose: Adapter },
  operation: Operation,
  commit?: () => Promise<void>,
): Promise<void> {
  const next = new Map(candidate.config.entries.map((entry) => [entry.id, entry]));
  const affected = operations.config.entries.filter((entry) => {
    const replacement = next.get(entry.id);
    return (
      !replacement ||
      JSON.stringify([
        entry.kind,
        entry.command,
        entry.directory,
        entry.composeGroupId,
        entry.composeService,
        entry.execution,
      ]) !==
        JSON.stringify([
          replacement.kind,
          replacement.command,
          replacement.directory,
          replacement.composeGroupId,
          replacement.composeService,
          replacement.execution,
        ])
    );
  });
  const results: { id: string; stopped: boolean; error?: string }[] = [];
  for (const entry of affected) {
    try {
      await adapters[entry.kind === 'compose' ? 'compose' : 'process'].stop(entry);
      results.push({ id: entry.id, stopped: true });
    } catch (error) {
      results.push({
        id: entry.id,
        stopped: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  operation.affected = affected.map((entry) => entry.id);
  operation.data = { stops: results };
  if (results.some((result) => !result.stopped)) {
    throw new AppError(
      'RELOAD_STOP_FAILED',
      'Config was not applied because one or more stops failed.',
      results,
    );
  }
  await commit?.();
  operations.applyConfig(candidate.config, candidate.environment);
}
