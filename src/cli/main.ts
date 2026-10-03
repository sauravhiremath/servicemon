#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readInstance } from '../manager/instance.js';
import { enableStartup, disableStartup } from '../manager/launch-agent.js';
import { configPath, stateDirectory } from '../config/paths.js';
import { startManager } from '../manager/runtime.js';
import { assetRoot } from '../server/assets.js';
import { AppError } from '../shared/errors.js';
import { addRuntimeCommands } from './actions.js';
import { addDefinitionCommands } from './definitions.js';
import { startBackground } from './background.js';
import { request } from './client.js';
import { printError, printResult } from './output.js';
const version=JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version as string;
const program=new Command().name('servicemon').description('Control local development services').version(version).option('--json','Write machine-readable JSON').option('--config <path>','Central YAML config file').exitOverride();
program.configureOutput({writeErr:()=>{}});
program.command('serve').description('Start or reuse the single manager').option('--background','Detach from this terminal').option('--ui <file>','Serve a custom HTML or HTM file').option('--port <number>','Loopback HTTP port').action(async(options,command)=>{
  const path=configPath(command.optsWithGlobals().config),state=stateDirectory();
  const port=options.port===undefined?undefined:Number(options.port);
  if(port!==undefined&&(!Number.isInteger(port)||port<0||port>65535))throw new AppError('INVALID_INPUT','Port must be an integer from 0 to 65535.');
  await assetRoot(options.ui);
  const endpoint=options.background?await startBackground({config:path,state,port,ui:options.ui}):await startManager({config:path,state,port,ui:options.ui});
  printResult(command.optsWithGlobals().json?{endpoint}:endpoint,Boolean(command.optsWithGlobals().json));
});
program.command('dashboard').description('Open the dashboard in your browser and print its URL').action(async(options,command)=>{
  await request('/api/status');
  const record=await readInstance(stateDirectory());
  if(!record)throw new AppError('MANAGER_UNAVAILABLE','No manager is running.');
  printResult(command.optsWithGlobals().json?{url:record.endpoint}:record.endpoint,Boolean(command.optsWithGlobals().json));
  try{await promisify(execFile)('/usr/bin/open',[record.endpoint],{timeout:10000});}
  catch{console.error('Could not open the browser. Open the printed URL manually.');}
});
const manager=program.command('manager').description('Inspect or stop the background manager');
manager.command('status').action(async(options,command)=>{
  await request('/api/status');const record=await readInstance(stateDirectory());
  printResult({running:true,endpoint:record!.endpoint,configPath:record!.configPath,pid:record!.pid},Boolean(command.optsWithGlobals().json));
});
manager.command('stop').action(async(options,command)=>printResult(await request('/api/manager/stop',{}),Boolean(command.optsWithGlobals().json)));
const startup=program.command('startup').description('Manage optional macOS login startup');
startup.command('enable').action(async(options,command)=>printResult(await enableStartup(configPath(command.optsWithGlobals().config),stateDirectory()),Boolean(command.optsWithGlobals().json)));
startup.command('disable').action(async(options,command)=>printResult(await disableStartup(stateDirectory()),Boolean(command.optsWithGlobals().json)));
addRuntimeCommands(program);addDefinitionCommands(program);
try{
  if(Number(process.versions.node.split('.')[0])<24)throw new AppError('TOOL_UNAVAILABLE',`Servicemon requires Node.js 24 or later; current runtime is ${process.version}.`);
  await program.parseAsync();
}
catch(error){
  if(error instanceof CommanderError){if(error.exitCode===0)process.exitCode=0;else printError(new AppError('INVALID_INPUT',error.message),process.argv.includes('--json'));}
  else printError(error,process.argv.includes('--json'));
}
