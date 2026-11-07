'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const r=require('./results.json');
const currentFile=path.join(__dirname,'full-investment-results.json');
const current=fs.existsSync(currentFile)?JSON.parse(fs.readFileSync(currentFile,'utf8')):null;
const names=fs.readdirSync(__dirname).filter(f=>f!=='manifest.json'&&f!=='verification.json'&&fs.statSync(path.join(__dirname,f)).isFile()).sort();
names.push('../r2-strategy-quant-comparison-plan-2026-11-07.md','../r2-strategy-quant-comparison-result-2026-11-07.md');
const files=names.map(name=>{const b=fs.readFileSync(path.join(__dirname,name));return {path:name,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')};});
fs.writeFileSync(path.join(__dirname,'manifest.json'),JSON.stringify({information_cutoff:r.audit.information_cutoff,
  current_result:current?'full-investment-results.json':'results.json',current_version:current?.version??'legacy',
  excludes:['manifest.json (self)','verification.json (verification output)'],
  validation:{skill_unit_tests:27,js_python_golden_cases:33,legacy_deterministic_result_files:5,full_investment_checks:current?JSON.parse(fs.readFileSync(path.join(__dirname,'full-investment-verification.json'),'utf8')).checks:null,full_investment_deterministic_result_files:current?2:null,pdf_raw_hashes:39,visual_pdf_check:'D07/120040A page 18: share-specific purchase ceiling and dynamic size condition'},
  files},null,2)+'\n');
console.log(JSON.stringify({files:files.length,bytes:files.reduce((s,f)=>s+f.bytes,0)}));
