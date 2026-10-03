import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const {values}=parseArgs({options:{ref:{type:'string'},output:{type:'string',default:'release-artifacts'}}});
assert(values.ref && /^(?:[a-f0-9]{40}|v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?)$/.test(values.ref),'Use --ref with a reviewed full commit SHA or version tag.');
const commit=execFileSync('git',['rev-parse',`${values.ref}^{commit}`],{encoding:'utf8'}).trim();
const pkg=JSON.parse(execFileSync('git',['show',`${commit}:package.json`],{encoding:'utf8'}));
if(values.ref.startsWith('v')) assert.equal(values.ref,`v${pkg.version}`,'Tag and package version differ.');
// Only reviewed source/build inputs enter the archive. Plans and local work records do not.
const top={'package.json':true,'package-lock.json':true,'README.md':true,'CHANGELOG.md':true,'LICENSE':true,'CONTRIBUTING.md':true,'tsconfig.json':true,'tsconfig.build.json':true,'vite.config.ts':true,'vitest.config.ts':true,'vitest.compose.config.ts':true,'playwright.config.ts':true};
const files=execFileSync('git',['ls-tree','-r','--name-only',commit],{encoding:'utf8'}).trim().split('\n').filter(file=>Object.hasOwn(top,file)||/^(src|tests|scripts|examples)\//.test(file)||/^docs\/(config|cli|operations|acceptance|releasing)\.md$/.test(file)||/^\.github\/workflows\//.test(file));
for(const required of ['LICENSE','package-lock.json','scripts/release-check.mjs']) assert(files.includes(required),`Reviewed commit lacks ${required}`);
const output=path.resolve(values.output),name=`servicemon-${pkg.version}-source.tar.gz`;
mkdirSync(output,{recursive:true,mode:0o700});chmodSync(output,0o700);
assert(!existsSync(path.join(output,name)), 'Source archive already exists. Use a different output directory; never overwrite a published version.');
const temporary=mkdtempSync(path.join(tmpdir(),'servicemon-release-'));
try {
  const archive=path.join(temporary,name);
  execFileSync('git',['archive','--format=tar.gz',`--prefix=servicemon-${pkg.version}/`,'--output',archive,commit,'--',...files]);
  execFileSync('tar',['-xzf',archive,'-C',temporary]);
  const root=path.join(temporary,`servicemon-${pkg.version}`);
  for(const args of [['ci','--ignore-scripts','--no-audit','--no-fund'],['run','build'],['run','smoke']]) execFileSync('npm',args,{cwd:root,stdio:'inherit'});
  execFileSync(process.execPath,['scripts/release-check.mjs','--tag',`v${pkg.version}`],{cwd:root,stdio:'inherit'});
  execFileSync('npm',['prune','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:root,stdio:'inherit'});
  execFileSync(process.execPath,['scripts/release-check.mjs','--runtime'],{cwd:root,stdio:'inherit'});
  chmodSync(path.join(root,pkg.bin.servicemon),0o755);
  execFileSync(process.execPath,['scripts/smoke-installed.mjs',pkg.bin.servicemon],{cwd:root,stdio:'inherit'});
  const sha256=createHash('sha256').update(readFileSync(archive)).digest('hex');
  copyFileSync(archive,path.join(output,name),constants.COPYFILE_EXCL);
  writeFileSync(path.join(output,`${name}.sha256`),`${sha256}  ${name}\n`,{flag:'wx',mode:0o600});
  writeFileSync(path.join(output,'manifest.json'),JSON.stringify({version:pkg.version,commit,archive:name,sha256,node:process.version,platform:process.platform,arch:process.arch},null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(`Source archive: ${path.join(output,name)}\nSHA-256: ${sha256}`);
} finally {rmSync(temporary,{recursive:true,force:true});}
