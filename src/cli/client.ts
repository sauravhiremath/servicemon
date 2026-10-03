import { setTimeout as delay } from 'node:timers/promises';
import { readInstance } from '../manager/instance.js';
import { stateDirectory } from '../config/paths.js';
import { AppError } from '../shared/errors.js';
import type { Envelope, Operation } from '../shared/types.js';
export async function request<T>(path:string,body?:unknown):Promise<T> {
  const record=await readInstance(stateDirectory());
  if(!record)throw new AppError('MANAGER_UNAVAILABLE','No manager is running.');
  let response:Response;
  try{response=await fetch(record.endpoint+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{Origin:record.endpoint,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});}
  catch(error){throw new AppError('MANAGER_UNAVAILABLE','Cannot connect to the manager.',error instanceof Error?error.message:String(error));}
  const result=await response.json() as Envelope<T>;
  if(!result.ok)throw new AppError(result.error.code,result.error.message,result.error.details,result.error.entryId,result.error.operationId);
  return result.data;
}
export async function observeOperation(id:string):Promise<Operation> {
  while(true){const operation=await request<Operation>('/api/operations/'+encodeURIComponent(id));if(!['pending','running'].includes(operation.state)){
    if(operation.state==='failed'){const error=operation.error!;throw new AppError(error.code,error.message,error.details,error.entryId,operation.id);}
    return operation;
  }await delay(100);}
}
