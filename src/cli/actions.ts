import { setTimeout as delay } from 'node:timers/promises';
import type { Command } from 'commander';
import { AppError } from '../shared/errors.js';
import type { EntryStatus, LogHistory, Snapshot, Target } from '../shared/types.js';
import { observeOperation, request } from './client.js';
import { printResult } from './output.js';

function selectedTarget(
  id: string | undefined,
  options: { project?: string; compose?: string },
): Target {
  if ([id, options.project, options.compose].filter(Boolean).length !== 1) {
    throw new AppError('INVALID_INPUT', 'Select one qualified entry ID, --project, or --compose.');
  }
  if (id && !/^[\w-]+\/[\w.-]+$/.test(id)) {
    throw new AppError('INVALID_TARGET', 'Use a qualified entry ID, such as project/service.');
  }
  return id
    ? { entry: id }
    : options.project
      ? { project: options.project }
      : { compose: options.compose };
}
function statusRows(entries: EntryStatus[]): string {
  return entries
    .map(
      (entry) =>
        `${entry.id}\t${entry.kind}\t${entry.state}\t${entry.health}${entry.exit ? `\texit=${entry.exit.code ?? entry.exit.signal}` : ''}${entry.error ? `\t${entry.error}` : ''}`,
    )
    .join('\n');
}
export function addRuntimeCommands(program: Command): void {
  for (const action of ['start', 'stop', 'restart', 'run'] as const) {
    const command = program
      .command(`${action} [target]`)
      .description(
        action === 'run'
          ? 'Run one qualified task'
          : `${action} a qualified entry, project, or Compose group`,
      )
      .option('--no-wait', 'Return the operation ID after acceptance');
    if (action !== 'run') {
      command.option('--project <id>', 'Project ID').option('--compose <id>', 'Compose group ID');
    }
    command.action(async (id, options, command) => {
      const target = selectedTarget(id, options);
      const route = target.entry
        ? `/api/entries/${encodeURIComponent(target.entry)}/${action}`
        : target.project
          ? `/api/projects/${encodeURIComponent(target.project)}/actions`
          : `/api/compose-groups/${encodeURIComponent(target.compose!)}/actions`;
      const accepted = await request<{ operationId: string }>(
        route,
        target.entry ? {} : { action },
      );
      const json = Boolean(command.optsWithGlobals().json);
      printResult(
        options.wait === false ? accepted : await observeOperation(accepted.operationId),
        json,
      );
    });
  }
  program
    .command('status [target]')
    .description('Show observed entry states')
    .option('--project <id>', 'Project ID')
    .option('--compose <id>', 'Compose group ID')
    .action(async (id, options, command) => {
      const snapshot = await request<Snapshot>('/api/status');
      const target =
        id || options.project || options.compose ? selectedTarget(id, options) : undefined;
      const entries = snapshot.entries.filter(
        (entry) =>
          !target ||
          (target.entry
            ? entry.id === target.entry
            : target.project
              ? entry.projectId === target.project
              : entry.composeGroupId === target.compose),
      );
      if (target && !entries.length) {
        throw new AppError('INVALID_TARGET', 'Target has no entries.');
      }
      printResult(
        command.optsWithGlobals().json ? { ...snapshot, entries } : statusRows(entries),
        Boolean(command.optsWithGlobals().json),
      );
    });
  program
    .command('operation <id>')
    .description('Show a requested operation and its result')
    .action(async (id, options, command) =>
      printResult(
        await request('/api/operations/' + encodeURIComponent(id)),
        Boolean(command.optsWithGlobals().json),
      ),
    );
  program
    .command('reload')
    .description('Validate and apply the config without autostart')
    .option('--no-wait', 'Return operation ID after acceptance')
    .action(async (options, command) => {
      const result = await request<{ operationId: string }>('/api/config/reload', {});
      printResult(
        options.wait === false ? result : await observeOperation(result.operationId),
        Boolean(command.optsWithGlobals().json),
      );
    });
  program
    .command('logs <id>')
    .description('Read retained output; --json writes one record per line')
    .option('--follow', 'Follow live output')
    .option('--tail <count>', 'Number of retained records', '100')
    .action(async (id, options, command) => {
      if (!/^\d+$/.test(options.tail) || !Number.isSafeInteger(Number(options.tail))) {
        throw new AppError('INVALID_INPUT', 'Tail must be a non-negative integer.');
      }
      const json = Boolean(command.optsWithGlobals().json);
      let cursor: number | undefined;
      let active = true;
      const stop = () => {
        active = false;
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        do {
          const history = await request<LogHistory>(
            `/api/entries/${encodeURIComponent(id)}/logs?${cursor === undefined ? 'tail=' + options.tail : 'after=' + cursor}`,
          );
          if (history.error) {
            throw new AppError('LOG_UNAVAILABLE', history.error, undefined, id);
          }
          if (history.gap) {
            const gap = {
              entryId: id,
              runId: '',
              sequence: history.oldestCursor,
              timestamp: new Date().toISOString(),
              stream: 'gap',
              text: 'Retained history gap',
            };
            console.log(json ? JSON.stringify(gap) : '[Retained history gap]');
          }
          for (const record of history.records) {
            if (cursor === undefined || record.sequence > cursor) {
              if (json) {
                console.log(JSON.stringify(record));
              } else {
                process.stdout.write(
                  `${record.timestamp} ${record.stream}${record.containerId ? ' ' + record.containerId : ''} ${record.text}${record.text.endsWith('\n') ? '' : '\n'}`,
                );
              }
            }
          }
          cursor = history.cursor;
          if (options.follow && active) {
            await delay(100);
          }
        } while (options.follow && active);
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
    });
}
