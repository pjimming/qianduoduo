'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const r=require('./full-investment-results.json'),{parseCsv}=require('../../../lib/products'),Y=require('../../../lib/yield-policy');
const dir=__dirname,cent=n=>Math.round(n*100),eq=(a,b)=>Math.abs(a-b)<1e-7;
let checks=0;const check=(pass,msg)=>{assert(pass,msg);checks++;};
const csv=parseCsv(fs.readFileSync(path.join(dir,'products.csv'),'utf8').replace(/^\uFEFF/,'')),head=csv.shift();
const source=new Map(csv.map(row=>{const p=Object.fromEntries(head.map((h,i)=>[h,row[i]]));return [p.key,p];}));
check(r.rules.cash_target===0&&r.rules.required_allocation_pct===100,'full investment is a hard rule');
const output=[];
for(const g of r.groups){
 check(g.allocated===100000&&g.unallocated===0,'all groups fully invested');
 check(g.allocations.reduce((s,p)=>s+cent(p.amount),0)===10000000,'money reconciles to cents');
 check(new Set(g.allocations.map(p=>p.key)).size===g.allocations.length,'unique sales share');
 const families={},registrations={},tiers={},buckets={short:0,medium:0,long:0};
 let weighted=0,monthly=0,explicit=0;
 for(const p of g.allocations){
  const row=source.get(p.key);check(Boolean(row),'source identity');check(row.raw_status==='1','open source pool');
  check(row.quota_status==='0'&&p.quota_status===0,'public buyable state');
  check(p.quota_checked_at===row.quota_status_checked_at&&p.quota_checked_at<=r.information_cutoff,'source time preserved');
  check(p.amount>0&&p.amount<=30000,'single position cap');
  check(p.amount>=Math.max(5000,p.minimum),'new position floor');check(p.increment>0,'verified numeric increment');
  check((cent(p.amount)-cent(p.minimum))%cent(p.increment)===0,'final amount increment');
  check(p.amount_assumption===(row.amount_cny===''),'unknown amount is not known zero');
  if(!p.amount_assumption){check(p.amount<=Number(row.amount_cny),'explicit quota respected cumulatively');explicit+=p.amount;}
  if(p.max_order!==null)check(p.amount<=p.max_order,'known maximum order');
  if(p.tier!=='full_1y')check(['six_month','three_month'].includes(p.tier)&&p.amount<=10000,'short-history single cap');
  check(Number(row.verified_term)===p.days,'verified holding period');
  if(g.name.startsWith('V')){check(row.V_state==='eligible','V hard gates, not watch/rejected/pending');check(p.return_1m>=2.15&&p.days<=190,'V yield and term');check(p.metrics.drawdown.pct<1,'V drawdown');}
  else check(row.O_candidate==='true','O native qualification');
  const product={term_days:p.days};for(const w of ['1m','3m','6m','1y'])product['return_'+w]=row[w]===''?null:Number(row[w]);
  check(eq(Y.calculateReferenceYield(product).value_pct,p.reference),'reference kernel');
  families[p.family]=(families[p.family]||0)+p.amount;tiers[p.tier]=(tiers[p.tier]||0)+p.amount;
  if(p.registration)registrations[p.registration]=(registrations[p.registration]||0)+p.amount;
  buckets[p.bucket]+=p.amount;weighted+=p.amount*p.reference;monthly+=p.amount*p.return_1m;
 }
 check(Object.values(families).every(n=>n<=50000),'proxy strategy cap');check(Object.values(registrations).every(n=>n<=50000),'registration cap');
 for(const t of ['six_month','three_month'])check((tiers[t]||0)<=20000,'evidence aggregate cap');
 for(const [b,n]of Object.entries(buckets)){check(n===g.buckets[b].amount,'bucket sums');check(n-g.buckets[b].target===g.buckets[b].deviation,'bucket deviations exposed');}
 check(eq(weighted/100000,g.reference_yield),'weighted reference');check(eq(monthly/100000,g.return_1m),'weighted 1M');
 check(eq(weighted/100*90/365,g.static_90d),'static reference arithmetic');check(explicit===g.explicit&&100000-explicit===g.assumed,'quota evidence split');
 const totals={};for(const t of g.trace){const before=totals[t.key]||0;check(eq(before+t.added,t.total),'cumulative additions');check(t.added>0,'positive additions');totals[t.key]=t.total;}
 for(const p of g.allocations)check(totals[p.key]===p.amount,'trace and final amounts agree');
 check(!g.allocations.some(p=>p.key==='D07/ZX040225'||p.key==='D07/113354A'),'tiny known balances not spent as default quotas');
 output.push({name:g.name,allocated:g.allocated,unallocated:g.unallocated,reference:g.reference_yield,explicit:g.explicit,assumed:g.assumed,buckets,liquidity_target_met:g.liquidity_target_met});
}
const ve=r.groups.find(g=>g.name==='V-E');
check(r.rules.explicit_amount_priority===false,'explicit disclosure must not change priority');
check(r.rules.blank_amount_rule.lower_bound_cny===50000000&&r.rules.blank_amount_rule.affects_ranking===false,'blank amount uses user rule without ranking penalty');
check(ve.allocations.some(p=>p.key==='D07/120019K'&&p.amount===10000),'7-day candidate participates in strategy order');
check(!ve.allocations.some(p=>p.key==='D07/PA040218'),'explicit amount is not preferred over strategy order');
check(!r.groups.some(g=>g.trace.some(t=>t.phase.startsWith('explicit_priority'))),'no explicit-first allocation phase');
for(const strategy of ['O','V']){const s=r.groups.find(g=>g.name===strategy+'-S'),e=r.groups.find(g=>g.name===strategy+'-E');check(JSON.stringify(s.allocations)===JSON.stringify(e.allocations),'S and E compatibility aliases have identical allocations');check(JSON.stringify(s.trace)===JSON.stringify(e.trace),'S and E use identical allocation sequence');}
check(ve.allocations.some(p=>p.key==='D07/JX040218'&&p.amount>10000),'eligible backup is topped up');
check(r.groups.filter(g=>g.name.startsWith('V')).every(g=>g.allocations.some(p=>!p.v_native_shortlisted)),'research list no longer truncates execution pool');
const fullCsv=parseCsv(fs.readFileSync(path.join(dir,'full-investment-products.csv'),'utf8').replace(/^\uFEFF/,''));
const fullHead=fullCsv.shift();check(fullCsv.length===4330,'full scope retained');check(new Set(fullHead).size===fullHead.length,'unambiguous current and legacy columns');
for(const g of r.groups){const ix=fullHead.indexOf(g.name);check(fullCsv.reduce((s,row)=>s+cent(Number(row[ix])),0)===10000000,'CSV full investment');}
const report=fs.readFileSync(path.join(dir,'../r2-strategy-quant-comparison-result-2026-11-07.md'),'utf8');
for(const g of r.groups)check(report.includes(g.reference_yield.toLocaleString('en-US',{minimumFractionDigits:4,maximumFractionDigits:4})+'%'),'report numerical consistency');
check(!report.includes('10%/45%/45%')&&report.includes('20%/45%/35%'),'current bucket conflict accurately disclosed');
check(!/29,\?|TODO|待填写|NaN|undefined/.test(report),'no placeholders');
for(const m of report.matchAll(/\]\(([^)]+)\)/g))if(!/^https?:/.test(m[1])&&!m[1].endsWith('full-investment-verification.json'))check(fs.existsSync(path.resolve(dir,'..',m[1])),'report local link '+m[1]);
const result={ok:true,checks,version:r.version,fully_invested:true,risk_caps_preserved:true,orders:'known minimum, increment and maximum verified; absent maximum remains disclosed',groups:output};
fs.writeFileSync(path.join(dir,'full-investment-verification.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
