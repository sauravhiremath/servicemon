import { Command } from 'commander';
import { expect, it } from 'vitest';
import { addRuntimeCommands } from '../../src/cli/actions.js';
import type { ManagerClient } from '../../src/cli/client.js';

function runtimeProgram(): Command {
  const command = new Command()
    .name('servicemon')
    .exitOverride()
    .configureOutput({ writeErr() {} });
  addRuntimeCommands(command, unusedClient());
  return command;
}
function unusedClient(): ManagerClient {
  return {
    async request() {
      throw new Error('manager request');
    },
    async observeOperation() {
      throw new Error('manager request');
    },
  };
}

it('rejects a project target on run before any manager call', async () => {
  const run = runtimeProgram();
  await expect(
    run.parseAsync(['run', 'demo/task', '--project', 'demo'], { from: 'user' }),
  ).rejects.toMatchObject({ code: 'commander.unknownOption' });
  await expect(
    run.parseAsync(['run', 'demo/task', '--compose', 'demo/infra'], { from: 'user' }),
  ).rejects.toMatchObject({ code: 'commander.unknownOption' });
});

it('does not accept yes on an application command', async () => {
  const run = runtimeProgram();
  await expect(
    run.parseAsync(['start', 'demo/api', '--yes'], { from: 'user' }),
  ).rejects.toMatchObject({
    code: 'commander.unknownOption',
  });
});
