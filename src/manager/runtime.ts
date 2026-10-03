import { readFile } from 'node:fs/promises';
import { acquireInstance, writeInstance } from './instance.js';
import { loadCandidate, applyCandidate } from '../config/reload.js';
import { proposedEdit, commitConfig } from '../config/document.js';
import { ProcessAdapter } from '../process/runner.js';
import { ComposeAdapter } from '../compose/adapter.js';
import { LogStore } from '../logs/store.js';
import { HealthMonitor } from './health.js';
import { Operations } from './operations.js';
import { EventHub } from '../server/events.js';
import { startServer } from '../server/server.js';
import type { ControlServer } from '../server/server.js';
import type { ErrorData, Operation, Snapshot } from '../shared/types.js';
import { errorData } from '../shared/errors.js';
export interface ManagerOptions { config:string; state:string; port?:number; ui?:string }
export async function startManager(options:ManagerOptions):Promise<string> {
  const lock=await acquireInstance(options.state,options.config);
  if(!lock.owned)return lock.record.endpoint;
  const events=new EventHub();
  let operations:Operations|undefined,server:ControlServer|undefined,logs:LogStore|undefined;
  let processAdapter:ProcessAdapter|undefined,compose:ComposeAdapter|undefined,health:HealthMonitor|undefined;
  let reloadError:ErrorData|undefined,shutdownPromise:Promise<void>|undefined;
  const subscriptions=new Map<string,()=>void>();
  const snapshot=():Snapshot=>({projects:operations!.config.projects,entries:operations!.config.entries.map(entry=>operations!.status(entry)),groups:operations!.config.groups,operations:[...operations!.records.values()],configPath:operations!.config.path,reloadError,cursor:events.cursor});
  let scheduled=false;
  const changed=(operation?:Operation):void=>{
    if(operation)events.publish('operation',operation);
    if(scheduled||!operations)return;
    scheduled=true;
    queueMicrotask(()=>{scheduled=false;if(operations)events.publish('state',snapshot());});
  };
  const subscribeLogs=():void=>{
    const ids=new Set(operations!.config.entries.filter(entry=>entry.kind!=='compose').map(entry=>entry.id));
    for(const [id,unsubscribe] of subscriptions)if(!ids.has(id)){unsubscribe();subscriptions.delete(id);}
    for(const id of ids)if(!subscriptions.has(id))subscriptions.set(id,logs!.subscribe(id,record=>events.publish('log',record)));
  };
  const shutdown=():Promise<void>=>shutdownPromise??=(async()=>{
    process.removeListener('SIGTERM',signal);process.removeListener('SIGINT',signal);
    try{if(operations)await operations.shutdown();else{await health?.shutdown();await processAdapter?.shutdown();await compose?.shutdown();}}
    finally{for(const unsubscribe of subscriptions.values())unsubscribe();logs?.close();try{await server?.close();}finally{await lock.release();}}
  })();
  const signal=():void=>{void shutdown().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});};
  try{
    const candidate=await loadCandidate(options.config);
    logs=new LogStore(options.state,candidate.config.logs);
    health=new HealthMonitor(candidate.environment,changed);
    processAdapter=new ProcessAdapter(candidate.config.entries.filter(entry=>entry.kind!=='compose'),candidate.environment,logs,options.state,changed);
    compose=new ComposeAdapter(candidate.config.entries.filter(entry=>entry.kind==='compose'),candidate.config.groups,candidate.environment,changed);
    operations=new Operations(candidate.config,candidate.environment,{process:processAdapter,compose},health,changed);
    await processAdapter.recover();await compose.refresh();subscribeLogs();
    const reload=(edit?:unknown):Operation=>operations!.enqueue(edit===undefined?'reload':'config-edit',{},async operation=>{
      try{
        const source=edit===undefined?undefined:await readFile(options.config,'utf8');
        const proposed=edit===undefined?undefined:proposedEdit(source!,edit);
        const next=await loadCandidate(options.config,proposed);
        await applyCandidate(operations!,next,{process:processAdapter!,compose:compose!},operation,proposed===undefined?undefined:()=>commitConfig(options.config,source!,proposed));
        compose!.updateGroups(next.config.groups,next.environment);logs!.setLimits(next.config.logs);subscribeLogs();reloadError=undefined;changed();
      }catch(error){reloadError=errorData(error);changed();throw error;}
    });
    server=await startServer({operations,history:async(id,query)=>operations!.config.entries.find(entry=>entry.id===id)?.kind==='compose'?compose!.history(id,query):logs!.history(id,query),events,port:options.port??candidate.config.port,ui:options.ui,reload:()=>reload(),edit:reload,shutdown,reloadError:()=>reloadError});
    await writeInstance(options.state,{...lock.record,endpoint:server.endpoint});
    process.on('SIGTERM',signal);process.on('SIGINT',signal);
    void operations.autostart().catch(error=>console.error(error instanceof Error?error.message:String(error)));
    return server.endpoint;
  }catch(error){await shutdown();throw error;}
}
