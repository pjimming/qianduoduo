'use strict';
const fs=require('node:fs'),path=require('node:path'),z=require('node:zlib'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'../../..'),dir=__dirname;
const r=require('./results.json');
const raw=JSON.parse(z.gunzipSync(fs.readFileSync(path.join(dir,'pool.json.gz'))));
const frozen=JSON.parse(z.gunzipSync(fs.readFileSync(path.join(dir,'evidence.json.gz'))));
const supplement=JSON.parse(z.gunzipSync(fs.readFileSync(path.join(dir,'supplement.json.gz'))));
const P=require(path.join(root,'lib/products')),Y=require(path.join(root,'lib/yield-policy'));
let checks=0;
const check=(ok,msg)=>{assert(ok,msg);checks++;};
const near=(a,b)=>Math.abs(a-b)<1e-7;
const csv=P.parseCsv(fs.readFileSync(path.join(dir,'products.csv'),'utf8').replace(/^\uFEFF/,''));
const headers=csv.shift(),rows=csv.map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]]))),byKey=new Map(rows.map(p=>[p.key,p]));
for(const rule of frozen.audit.rules) check(crypto.createHash('sha256').update(rule.text).digest('hex')===rule.sha256,'frozen rule digest');
for(const status of ['1','2']) {
 const reqs=raw.audit.requests.filter(q=>q.status===status),data=raw.raw.filter(p=>p.statusText===status);
 check(reqs.length===reqs[0].pages,'page count');check(data.length===reqs[0].total,'pool total');
 reqs.forEach((q,i)=>{check(q.page===i+1,'page sequence');check(q.total===reqs[0].total,'stable total');check(q.count===Math.min(50,q.total-i*50),'page size');});
}
const scope=raw.raw.filter(p=>['R2','PR2'].includes(p.risk)&&p.ccynbr==='10'&&p.pubPrv==='A');
check(scope.length===r.quality.shares,'scope');check(rows.length===scope.length,'csv scope');check(byKey.size===rows.length,'unique share identity');
for(const p of rows) {
 const bank=scope.find(x=>x.saacod+'/'+x.code===p.key);
 check(Boolean(bank),'bank identity');check(p.list_checked_at<=r.audit.information_cutoff,'information cutoff');
 if(p.quota_status_checked_at)check(p.quota_status_checked_at<=r.audit.information_cutoff,'quota cutoff');
 if(p.amount_checked_at)check(p.amount_checked_at<=r.audit.information_cutoff,'amount cutoff');
 if(p.reference!=='') {
  const x={term_days:Number(p.verified_term)};
  for(const w of ['1m','3m','6m','1y']) x['return_'+w]=p[w]===''?null:Number(p[w]);
  check(near(Y.calculateReferenceYield(x).value_pct,Number(p.reference)),'reference policy');
 }
 if(p.tier==='one_month') for(const g of r.groups)check(Number(p[g.name])===0,'one-month allocation');
}
for(const g of [...r.groups,...r.sensitivity]) {
 const cents=g.allocations.reduce((s,a)=>s+Math.round(a.amount*100),0);
 check(cents===Math.round(g.allocated*100),'allocation sum');check(cents+Math.round(g.unallocated*100)===10000000,'principal conservation');
 check(new Set(g.allocations.map(a=>a.key)).size===g.allocations.length,'quota used once');
 let weighted=0,principal=0,explicit=0;
 const registered={};
 for(const a of g.allocations) {
  const p=byKey.get(a.key);check(p.quota_status==='0','quota state');check(p.raw_status==='1','open');
  check(a.amount>=Math.max(5000,Number(p.minimum)),'minimum');check(a.amount<=30000,'single 30%');
  if(p.step!=='') check((Math.round(a.amount*100)-Math.round(Number(p.minimum)*100))%Math.round(Number(p.step)*100)===0,'increment');
  if(p.max_order!=='')check(a.amount<=Number(p.max_order),'known max order');
  if(p.amount_cny!=='') {check(a.amount<=Number(p.amount_cny),'known quota');explicit+=a.amount;}
  if(g.name.startsWith('V'))check(p.V_selected==='true','V independently selected');
  if(g.name.startsWith('O'))check(p.O_candidate==='true','O independently selected');
  if(p.tier==='six_month'||p.tier==='three_month')check(a.amount<=10000,'limited-history single');
  if(p.registration)registered[p.registration]=(registered[p.registration]||0)+a.amount;
  if(p.reference!==''){weighted+=a.amount*Number(p.reference);principal+=a.amount;}
 }
 check(Object.values(registered).every(v=>v<=50000),'same registered product cap');
 for(const b of g.buckets){check(near(g.allocations.filter(a=>a.bucket===b.key).reduce((s,a)=>s+a.amount,0),b.new_amount),'bucket sum');check(b.new_amount<=b.target_amount,'bucket ceiling');}
 for(const tier of ['six_month','three_month'])check((g.tiers[tier]||0)<=20000,'evidence aggregate');
 check(Object.values(g.families).every(v=>v<=50000),'proxy strategy cap');
 check(near(explicit,g.explicit),'explicit amount');check(near(g.explicit+g.assumed,g.allocated),'quota evidence conservation');
 check(near(principal,g.calculable_principal),'yield coverage');
 if(principal){check(near(weighted/principal,g.reference_yield),'weighted reference');check(near(weighted/100*90/365,g.static_90d),'90d static');}
 else {check(g.reference_yield===null,'empty yield');check(g.static_90d===null,'empty static');check(g.assumption_pct===null,'empty ratio');}
}
const os=r.groups.find(g=>g.name==='O-S'),vs=r.groups.find(g=>g.name==='V-S');
check(os.assumed===os.allocated&&vs.assumed===vs.allocated,'S fully assumption dependent');
check(r.groups.find(g=>g.name==='V-E').allocated===0,'V E');
const zero=byKey.get('D07/ZX040225');check(zero.amount_cny==='0.01','small known balance preserved');
check(supplement.records.length===39&&supplement.records.every(d=>d.pages?.length),'public prospectuses');
for(const [file,n] of [['allocations.csv',26],['rule-differences.csv',25]])check(P.parseCsv(fs.readFileSync(path.join(dir,file),'utf8').replace(/^\uFEFF/,'')).length-1===n,file+' count');
const report=fs.readFileSync(path.join(dir,'../r2-strategy-quant-comparison-result-2026-11-07.md'),'utf8');
check(!/29,\?|TODO|待填写|NaN|undefined/.test(report),'report unresolved placeholders');
for(const link of report.matchAll(/\]\(([^)]+)\)/g)) {
 if(/^https?:/.test(link[1]))continue;
 check(fs.existsSync(path.resolve(dir,'..',decodeURIComponent(link[1]))),'local report link '+link[1]);
}
const manifestFile=path.join(dir,'manifest.json');
if(fs.existsSync(manifestFile)) {
 const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
 for(const file of manifest.files){const buffer=fs.readFileSync(path.resolve(dir,file.path));check(buffer.length===file.bytes,'manifest size');check(crypto.createHash('sha256').update(buffer).digest('hex')===file.sha256,'manifest digest '+file.path);}
}
const output={ok:true,checks,scope:rows.length,groups:r.groups.map(g=>({name:g.name,allocated:g.allocated,unallocated:g.unallocated,liquidity_target_met:g.liquid_7_30>=30000})),safety_and_budget_constraints:'passed',unresolved:['dynamic share size and account limits','unparsed order clauses','underlying strategy proxy rather than look-through']};
fs.writeFileSync(path.join(dir,'verification.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output));
