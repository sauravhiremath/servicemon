import { Command } from 'commander';
import { expect, it } from 'vitest';
import { addRuntimeCommands } from '../../src/cli/actions.js';

function runtimeProgram(): Command {
  const command = new Command().name('servicemon').exitOverride().configureOutput({ writeErr() {} });
  addRuntimeCommands(command);
  return command;
}

it('rejects a project target on run before any manager call', async () => {
  const run = runtimeProgram();
  await expect(run.parseAsync(['run', 'demo/task', '--project', 'demo'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.unknownOption' });
  await expect(run.parseAsync(['run', 'demo/task', '--compose', 'demo/infra'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.unknownOption' });
});
