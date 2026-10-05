#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Command, CommanderError } from 'commander';
import { configPath, stateDirectory } from '../config/paths.js';
import { readInstance } from '../manager/instance.js';
import { enableStartup, disableStartup } from '../manager/launch-agent.js';
import { startManager } from '../manager/runtime.js';
import { assetRoot } from '../server/assets.js';
import { packageVersion } from '../shared/build-info.js';
import { AppError } from '../shared/errors.js';
import { addRuntimeCommands } from './actions.js';
import { startBackground } from './background.js';
import { addDefinitionCommands } from './definitions.js';
import {
  commandIsTerminal,
  createCommandClient,
  managerStatus,
  managerStop,
  restartManager,
} from './manager.js';
import { printError, printResult } from './output.js';

const client = createCommandClient({ terminal: commandIsTerminal() });
const program = new Command()
  .name('servicemon')
  .description('Control local development services')
  .version(packageVersion)
  .option('--json', 'Write machine-readable JSON')
  .option('--config <path>', 'Central YAML config file')
  .exitOverride();
program.configureOutput({ outputError: () => {} });
program
  .command('serve')
  .description('Start or reuse the single manager')
  .option('--background', 'Detach from this terminal')
  .option('--ui <file>', 'Serve a custom HTML or HTM file')
  .option('--port <number>', 'Loopback HTTP port')
  .action(async (options, command) => {
    const path = configPath(command.optsWithGlobals().config),
      state = stateDirectory();
    const port = options.port === undefined ? undefined : Number(options.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
      throw new AppError('INVALID_INPUT', 'Port must be an integer from 0 to 65535.');
    }
    await assetRoot(options.ui);
    const endpoint = options.background
      ? await startBackground({ config: path, state, port, ui: options.ui })
      : await startManager({ config: path, state, port, ui: options.ui });
    printResult(
      command.optsWithGlobals().json ? { endpoint } : endpoint,
      Boolean(command.optsWithGlobals().json),
    );
  });
program
  .command('dashboard')
  .description('Open the dashboard in your browser and print its URL')
  .action(async (options, command) => {
    await client.request('/api/status');
    const record = await readInstance(stateDirectory());
    if (!record) {
      throw new AppError('MANAGER_UNAVAILABLE', 'No manager is running.');
    }
    printResult(
      command.optsWithGlobals().json ? { url: record.endpoint } : record.endpoint,
      Boolean(command.optsWithGlobals().json),
    );
    try {
      await promisify(execFile)('/usr/bin/open', [record.endpoint], { timeout: 10000 });
    } catch {
      console.error('Could not open the browser. Open the printed URL manually.');
    }
  });
const manager = program
  .command('manager')
  .description('Inspect, restart, or stop the background manager');
manager.command('status').action(async (options, command) => {
  printResult(await managerStatus(), Boolean(command.optsWithGlobals().json));
});
manager
  .command('stop')
  .action(async (options, command) =>
    printResult(await managerStop(), Boolean(command.optsWithGlobals().json)),
  );
manager
  .command('restart')
  .description('Replace the running manager after one confirmation')
  .option('--yes', 'Restart without a prompt')
  .action(async (options, command) => {
    const global = command.optsWithGlobals();
    const outcome = await restartManager({
      yes: options.yes === true,
      terminal: commandIsTerminal(),
      explicitConfig: typeof global.config === 'string' ? global.config : undefined,
    });
    printResult(outcome.report, Boolean(global.json));
  });
const startup = program.command('startup').description('Manage optional macOS login startup');
startup
  .command('enable')
  .action(async (options, command) =>
    printResult(
      await enableStartup(configPath(command.optsWithGlobals().config), stateDirectory()),
      Boolean(command.optsWithGlobals().json),
    ),
  );
startup
  .command('disable')
  .action(async (options, command) =>
    printResult(await disableStartup(stateDirectory()), Boolean(command.optsWithGlobals().json)),
  );
addRuntimeCommands(program, client);
addDefinitionCommands(program, client);
try {
  if (Number(process.versions.node.split('.')[0]) < 24) {
    throw new AppError(
      'TOOL_UNAVAILABLE',
      `Servicemon requires Node.js 24 or later; current runtime is ${process.version}.`,
    );
  }
  await program.parseAsync();
} catch (error) {
  if (error instanceof CommanderError) {
    if (error.exitCode === 0 || error.code === 'commander.help') {
      process.exitCode = error.exitCode;
    } else {
      printError(new AppError('INVALID_INPUT', error.message), process.argv.includes('--json'));
    }
  } else {
    printError(error, process.argv.includes('--json'));
  }
}
