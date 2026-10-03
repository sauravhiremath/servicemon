import { Command } from 'commander';
import { configPath, stateDirectory } from '../config/paths.js';
import { compileConfig, readConfigText } from '../config/compile.js';
import { editConfig } from '../config/document.js';
import { discoverGroups } from '../compose/discovery.js';
import { validateGraphs } from '../manager/graphs.js';
import { readInstance } from '../manager/instance.js';
import { AppError } from '../shared/errors.js';
import { observeOperation, request } from './client.js';
import { printResult } from './output.js';
export async function validateDefinitions(source:string,path:string) {
  const initial=compileConfig(source,path);
  const discovery=await discoverGroups(initial.groups,process.env);
  const config=compileConfig(source,path,discovery);validateGraphs(config.entries);return config;
}
const number=(value:string|undefined):number|undefined=>{if(value===undefined)return;if(!Number.isFinite(Number(value))||Number(value)<=0)throw new AppError('INVALID_INPUT','Timeouts must be positive numbers.');return Number(value);};
function flags(kind:string,options:Record<string,any>):Record<string,unknown> {
  const fields:Record<string,unknown>={};
  for(const key of ['name','directory','notes','command','file'])if(options[key]!==undefined)fields[key]=options[key];
  if(options.projectName!==undefined)fields.project_name=options.projectName;
  for(const key of ['autostart','restartDependencies','restartDependents'])if(options[key]!==undefined)fields[key.replace(/[A-Z]/g,char=>'_'+char.toLowerCase())]=options[key];
  if(options.dependsOn)fields.depends_on=options.dependsOn;
  if(options.link)fields.links=options.link;
  if(options.stopSeconds!==undefined)fields.stop_seconds=number(options.stopSeconds);
  if(options.readinessSeconds!==undefined)fields.readiness_seconds=number(options.readinessSeconds);
  if(options.services!==undefined){try{fields.services=JSON.parse(options.services);}catch{throw new AppError('INVALID_INPUT','Services overrides must be a JSON object.');}}
  const checks=[options.healthHttp,options.healthTcp,options.healthCommand].filter(Boolean);
  if(checks.length>1)throw new AppError('INVALID_INPUT','Select one health check type.');
  if(checks.length){
    const check:Record<string,unknown>=options.healthHttp?{type:'http',url:options.healthHttp}:options.healthCommand?{type:'command',command:options.healthCommand}: (()=>{const match=/^(.*):(\d+)$/.exec(options.healthTcp);if(!match)throw new AppError('INVALID_INPUT','TCP check must use host:port.');return {type:'tcp',host:match[1],port:Number(match[2])};})();
    if(options.healthInterval!==undefined)check.interval_seconds=number(options.healthInterval);
    if(options.healthTimeout!==undefined)check.timeout_seconds=number(options.healthTimeout);
    if(options.expectedStatus!==undefined)check.expected_status=Number(options.expectedStatus);
    fields.healthcheck=check;
  }else if(options.healthInterval||options.healthTimeout||options.expectedStatus)throw new AppError('INVALID_INPUT','A health check is required for check settings.');
  return fields;
}
export function addDefinitionCommands(program:Command):void {
  const configuration=program.command('config').description('Inspect and validate central YAML');
  configuration.command('path').action((options,command)=>printResult({path:configPath(command.optsWithGlobals().config)},Boolean(command.optsWithGlobals().json)));
  configuration.command('validate').action(async(options,command)=>{const path=configPath(command.optsWithGlobals().config);const config=await validateDefinitions(await readConfigText(path),path);printResult({path,valid:true,projects:config.projects.length,entries:config.entries.length},Boolean(command.optsWithGlobals().json));});
  for(const kind of ['project','service','task','compose'] as const){
    const group=program.command(kind).description(`List, add, and remove ${kind} definitions`);
    group.command('list').action(async(options,command)=>{
      const global=command.optsWithGlobals(),path=configPath(global.config);
      const config=await validateDefinitions(await readConfigText(path),path);
      const rows=kind==='project'?config.projects:kind==='compose'?config.groups:config.entries.filter(entry=>entry.kind===kind);
      printResult(rows,Boolean(global.json));
    });
    const add=group.command('add <id>').description(kind==='project'?'Add a project ID':'Add a qualified ID: project/name').option('--name <name>','Display name').option('--notes <text>','Notes');
    if(kind==='project')add.requiredOption('--directory <path>','Project working folder');
    else add.option('--directory <path>','Working folder').option('--autostart','Start only at manager startup');
    if(kind==='service'||kind==='task'){
      add.requiredOption('--command <command>','Foreground shell command').option('--depends-on <ids...>','Local or qualified prerequisites').option('--link <url>','Entry link; repeat as needed',(value:string,previous:string[])=>[...previous,value],[]).option('--stop-seconds <seconds>','Owned group stop deadline');
      if(kind==='service')add.option('--restart-dependencies','Include service prerequisites in Restart').option('--restart-dependents','Include service dependents in Restart').option('--readiness-seconds <seconds>','Readiness deadline').option('--health-http <url>','HTTP health URL').option('--health-tcp <host:port>','TCP health endpoint').option('--health-command <command>','Command health check').option('--expected-status <code>','HTTP expected status').option('--health-interval <seconds>','Check interval').option('--health-timeout <seconds>','Check timeout');
    }
    if(kind==='compose')add.requiredOption('--file <path>','Compose file').option('--project-name <name>','Docker Compose project identity').option('--services <json>','Discovered service overrides as a JSON object');
    add.addHelpText('after',kind==='project'?'\nExample: servicemon project add demo --directory ~/work/demo':'\nExample: servicemon '+kind+' add demo/'+(kind==='compose'?'infra --file compose.yaml':'api --command "npm run dev"'));
    for(const action of ['add','remove'] as const){
      const command=action==='add'?add:group.command('remove <id>').description('Remove a definition; referenced entries must be removed from dependencies first');
      command.action(async(id:string,options,command)=>{
        const global=command.optsWithGlobals(),path=configPath(global.config);
        const match=kind==='project'?/^([\w-]+)$/.exec(id):/^([\w-]+)\/([\w-]+)$/.exec(id);
        if(!match)throw new AppError('INVALID_INPUT',kind==='project'?'Use a project ID.':'Use a qualified ID: project/name.');
        const edit={kind,action,key:kind==='project'?match[1]:match[2],projectId:kind==='project'?undefined:match[1],fields:action==='add'?flags(kind,options):undefined};
        const instance=await readInstance(stateDirectory());
        if(instance){if(instance.configPath!==path)throw new AppError('MANAGER_CONFLICT','The manager uses a different config file.',{active:instance.configPath,requested:path});const accepted=await request<{operationId:string}>('/api/config/edit',edit);printResult(await observeOperation(accepted.operationId),Boolean(global.json));}
        else{const result=await editConfig(path,edit,source=>validateDefinitions(source,path));printResult({path,kind,action,id,entries:result.entries.length},Boolean(global.json));}
      });
    }
  }
}
