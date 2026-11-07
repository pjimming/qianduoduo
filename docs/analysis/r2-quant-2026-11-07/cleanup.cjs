'use strict';
// Remove only this collector's exact outputs, after checking the archived source evidence.
// No recursive removal, glob deletion, or deletion of unrecognised files.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const base=fs.realpathSync(__dirname),temp=path.join(base,'pdf-temp');
const index=require('./supplement-index.json');
assert(fs.statSync(path.join(base,'prospectuses.zip')).size>0);
const allowed=new Set(index.records.map(r=>r.file));allowed.add('120040A-page-18.png');
const targets=[];
if(fs.existsSync(temp)){
 assert(fs.realpathSync(temp)===temp);
 for(const name of fs.readdirSync(temp)){
  assert(allowed.has(name),'Unrecognised temporary file; refusing deletion');
  const file=path.resolve(temp,name);assert(file.startsWith(temp+path.sep));
  const stat=fs.lstatSync(file);assert(stat.isFile()&&!stat.isSymbolicLink());
  const source=index.records.find(r=>r.file===name);
  if(source)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),source.sha256,'PDF must match retained archive index');
  targets.push(file);
 }
}
for(const name of ['checkpoint.json.gz','compute-output.tmp']){
 const file=path.join(base,name);
 if(fs.existsSync(file)){assert(fs.lstatSync(file).isFile());targets.push(file);}
}
// All paths and all PDF content have been checked before the first mutation.
for(const file of targets)fs.unlinkSync(file);
if(fs.existsSync(temp))fs.rmdirSync(temp);
console.log(JSON.stringify({removed_verified_temporary_files:targets.length,retained:'prospectuses.zip and evidence archives'}));
