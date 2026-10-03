import { errorData, exitCode } from '../shared/errors.js';
export function printResult(data:unknown,json:boolean):void {
  if(json)console.log(JSON.stringify({ok:true,data,error:null}));
  else if(typeof data==='string')console.log(data);
  else console.log(JSON.stringify(data,null,2));
}
export function printError(error:unknown,json:boolean):void {
  const data=errorData(error);process.exitCode=exitCode(data.code);
  if(json)console.log(JSON.stringify({ok:false,data:null,error:data}));
  else console.error(`${data.code}: ${data.message}${data.operationId?' (operation '+data.operationId+')':''}`);
}
