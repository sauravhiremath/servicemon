import { expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';
import { fixtureManager, persistentCommand, shellCommand } from '../helpers/runtime.js';
const route=(id:string,action:string)=>`/api/entries/${encodeURIComponent(id)}/${action}`;
it('retains active config after invalid input and stops only execution-changed entries',async()=>{
  const manager=await fixtureManager({app:{services:{api:{command:persistentCommand},ui:{command:persistentCommand}}}});
  try{
    await manager.operation('/api/projects/app/actions',{action:'start'});
    const before=(await manager.snapshot()).entries;
    const source=await readFile(manager.config,'utf8');
    await writeFile(manager.config,'version: [invalid');
    expect((await manager.operation('/api/config/reload')).state).toBe('failed');
    const invalid=await manager.snapshot();expect(invalid.reloadError?.code).toBe('INVALID_CONFIG');
    expect(invalid.entries.map(e=>e.runId)).toEqual(before.map(e=>e.runId));
    const metadata=parse(source);metadata.projects.app.services.api.notes='changed metadata';
    await writeFile(manager.config,stringify(metadata));expect((await manager.operation('/api/config/reload')).state).toBe('succeeded');
    expect((await manager.snapshot()).entries.map(e=>e.runId)).toEqual(before.map(e=>e.runId));
    metadata.projects.app.services.api.command=shellCommand('console.log("new definition");setInterval(()=>{},1000)');
    metadata.projects.app.services.new={command:persistentCommand,autostart:true};
    await writeFile(manager.config,stringify(metadata));const applied=await manager.operation('/api/config/reload');expect(applied.state).toBe('succeeded');expect(applied.affected).toEqual(['app/api']);
    const after=(await manager.snapshot()).entries;
    expect(after.find(e=>e.id==='app/api')!.state).toBe('stopped');expect(after.find(e=>e.id==='app/ui')!.runId).toBe(before.find(e=>e.id==='app/ui')!.runId);expect(after.find(e=>e.id==='app/new')!.state).toBe('stopped');
  }finally{await manager.close();}
});
it('keeps compatible task success on metadata reload and clears it after prerequisite changes',async()=>{
  const manager=await fixtureManager({app:{tasks:{setup:{command:shellCommand('require("fs").appendFileSync("runs","x")'),depends_on:['db']}},services:{db:{command:persistentCommand},api:{command:persistentCommand,depends_on:['setup']}}}});
  try{
    await manager.operation(route('app/api','start'));
    const document=parse(await readFile(manager.config,'utf8'));document.projects.app.tasks.setup.notes='metadata';
    await writeFile(manager.config,stringify(document));await manager.operation('/api/config/reload');await manager.operation(route('app/api','restart'));expect(await readFile(manager.folder+'/runs','utf8')).toBe('x');
    document.projects.app.services.db.command=shellCommand('console.log("new db");setInterval(()=>{},1000)');
    await writeFile(manager.config,stringify(document));await manager.operation('/api/config/reload');await manager.operation(route('app/api','restart'));expect(await readFile(manager.folder+'/runs','utf8')).toBe('xx');
  }finally{await manager.close();}
});
