import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec=promisify(execFile);
const source=process.cwd();
const root=await mkdtemp(path.join(tmpdir(),'servicemon-runtime-'));
try {
  for(const file of ['package.json','package-lock.json','tsconfig.json','tsconfig.build.json','vite.config.ts','src','scripts']) await cp(path.join(source,file),path.join(root,file),{recursive:true});
  await exec('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,timeout:120000});
  await mkdir(path.join(root,'dist'));
  await writeFile(path.join(root,'dist','removed.js'),'stale build output');
  await exec('npm',['run','build'],{cwd:root,timeout:120000});
  await assert.rejects(stat(path.join(root,'dist','removed.js')), {code:'ENOENT'});
  await exec('npm',['prune','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,timeout:120000});
  const report=JSON.parse((await exec(process.execPath,[path.join(source,'scripts/release-check.mjs'),'--root',root,'--runtime'],{cwd:root})).stdout);
  await mkdir(path.join(root,'bin'));
  await chmod(path.join(root,'dist/cli/main.js'),0o755);
  const cli=path.join(root,'bin/servicemon');
  await symlink('../dist/cli/main.js',cli);
  const smoke=await exec(process.execPath,[path.join(source,'scripts/smoke-installed.mjs'),cli],{cwd:root,timeout:60000});
  process.stdout.write(smoke.stdout);
  assert.equal((await exec(cli,['--version'])).stdout.trim(),JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version);
  console.log(`PASS clean pruned runtime (${report.dependencies.length} locked dependencies); ${process.version} ${process.platform}/${process.arch}`);
} finally { await rm(root,{recursive:true,force:true}); }
