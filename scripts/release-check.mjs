import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const {values} = parseArgs({options:{root:{type:'string',default:'.'},runtime:{type:'boolean',default:false},tag:{type:'string'}}});
const root = path.resolve(values.root);
const pkg = JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));
const lock = JSON.parse(readFileSync(path.join(root,'package-lock.json'),'utf8'));
assert.equal(pkg.version, lock.version, 'Package and lockfile versions differ.');
assert.equal(pkg.version, lock.packages[''].version, 'Root lockfile version differs.');
assert.equal(pkg.license, 'MIT');
if(values.tag) assert.equal(values.tag, `v${pkg.version}`, 'Tag and package versions differ.');
if (!values.runtime) {
  assert(statSync(path.join(root,'LICENSE'),{throwIfNoEntry:false})?.isFile(),'Missing MIT LICENSE.');
  const license = readFileSync(path.join(root,'LICENSE'),'utf8');
  assert.match(license,/Copyright \(c\) \d{4} \S/,'A copyright holder is required.');
  assert.match(license,/Permission is hereby granted, free of charge/);
  assert.match(license,/THE SOFTWARE IS PROVIDED "AS IS"/);
  for(const file of ['CONTRIBUTING.md','docs/releasing.md','examples/services.yaml']) assert(statSync(path.join(root,file)).isFile(),file);
  const packed=JSON.parse(execFileSync('npm',['pack','--dry-run','--ignore-scripts','--json'],{cwd:root,encoding:'utf8'}))[0];
  assert.equal(packed.version,pkg.version);
  const paths=new Set(packed.files.map(file=>file.path));
  for(const required of [pkg.bin.servicemon,'dist/web/index.html','dist/web/favicon.svg','LICENSE','CONTRIBUTING.md','docs/releasing.md','examples/services.yaml']) assert(paths.has(required),`Packed archive lacks ${required}`);
  for(const file of paths) assert(!/^(?:docs\/plans|\.orca|node_modules|test-results|release-artifacts)\//.test(file),`Private or local archive input: ${file}`);
}
const cli=path.join(root,pkg.bin.servicemon);
assert.equal(execFileSync(process.execPath,[cli,'--version'],{encoding:'utf8'}).trim(),pkg.version);
const html=readFileSync(path.join(root,'dist/web/index.html'),'utf8');
const script=html.match(/src="([^"]+\.js)"/)[1];
assert(statSync(path.join(root,'dist/web',script.replace(/^\//,''))).isFile());
execFileSync('npm',['ls','--omit=dev','--all'],{cwd:root,stdio:'pipe'});
const installed=[];
function walk(directory) {
  for(const entry of readdirSync(directory,{withFileTypes:true})) {
    if(entry.name.startsWith('.')) continue;
    const absolute=path.join(directory,entry.name);
    if(entry.name.startsWith('@')) { walk(absolute); continue; }
    if(!entry.isDirectory()) continue;
    const metadata=JSON.parse(readFileSync(path.join(absolute,'package.json'),'utf8'));
    const key=path.relative(root,absolute).split(path.sep).join('/');
    const expected=lock.packages[key];
    assert(expected,`Unlocked dependency: ${key}`);
    assert.equal(metadata.version,expected.version,`Wrong installed dependency: ${key}`);
    if(values.runtime) assert(!expected.dev,`Development dependency in runtime tree: ${key}`);
    installed.push([key,metadata.version,expected.integrity]);
    if(statSync(path.join(absolute,'node_modules'),{throwIfNoEntry:false})?.isDirectory()) walk(path.join(absolute,'node_modules'));
  }
}
walk(path.join(root,'node_modules'));
console.log(JSON.stringify({version:pkg.version,node:process.version,platform:process.platform,arch:process.arch,mode:values.runtime?'runtime-only':'release',dependencies:installed.sort((a,b)=>a[0].localeCompare(b[0]))},null,2));
