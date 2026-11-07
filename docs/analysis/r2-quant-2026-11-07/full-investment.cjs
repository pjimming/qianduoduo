'use strict';
// Full-investment correction. All bank inputs remain the frozen common information set.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),z=require('node:zlib'),assert=require('node:assert/strict'),{createRequire}=require('node:module');
const dir=__dirname;
const previousFile=path.join(dir,'previous-comparison.json.gz');
if(!fs.existsSync(previousFile)){
 const files=['results.json','verification.json','manifest.json','compute.cjs','write-report.cjs','../r2-strategy-quant-comparison-plan-2026-11-07.md','../r2-strategy-quant-comparison-result-2026-11-07.md'];
 fs.writeFileSync(previousFile,z.gzipSync(JSON.stringify({reason:'Superseded: user requires 100% allocation; explicit-amount-only E was a diagnostic, not a valid full-investment comparison.',files:Object.fromEntries(files.map(name=>[name,fs.readFileSync(path.join(dir,name),'utf8')]))})));
}
const prepared={module:{exports:{}},require:createRequire(path.join(dir,'compute.cjs')),__dirname:dir,console};
const source=fs.readFileSync(path.join(dir,'compute.cjs'),'utf8').split("const groups = ['S','E']")[0];
vm.runInNewContext(source+'\nmodule.exports={shares,oSorted,P,Y,audit,supplement};',prepared);
const {shares,oSorted,P,audit,supplement}=prepared.module.exports;
const originalOrder=new Map(oSorted.map((p,i)=>[p.key,i]));
const money=n=>Math.round(n*100);
const nsum=(rows,fn)=>rows.reduce((s,p)=>s+fn(p),0);
const targets={short:3000000,medium:3500000,long:3500000};
const eligible=p=>{
 const reasons=[];
 if(p.raw_status!=='1')reasons.push('not_open');
 if(p.quota?.status!==0)reasons.push(p.quota?.status===1?'sold_out':'status_unverified');
 if(!['short','medium','long'].includes(p.bucket))reasons.push('term_unverified_or_daily');
 if(!P.EVIDENCE_POLICY[p.tier].automatic)reasons.push('evidence_not_automatic');
 if(p.shared_metrics.reference_yield_status!=='available')reasons.push('reference_unavailable');
 if(!(p.orders.minimum>0))reasons.push('minimum_unverified');
 if(!(p.orders.step>0))reasons.push('increment_unverified');
 if(p.amount.amount!==null&&p.amount.amount<Math.max(5000,p.orders.minimum))reasons.push('known_balance_below_new_position_minimum');
 return reasons;
};
function compare(a,b,strategy){
 if(strategy==='O')return originalOrder.get(a.key)-originalOrder.get(b.key);
 return Number(b.performance['1m'])-Number(a.performance['1m'])||a.channel.localeCompare(b.channel)||a.code.localeCompare(b.code);
}
function allocate(strategy,scenario){
 const native=shares.filter(p=>strategy==='O'?p.o_candidate:p.v.status==='eligible');
 const rejected=native.map(p=>({key:p.key,reasons:eligible(p)})).filter(p=>p.reasons.length);
 const candidates=native.filter(p=>!eligible(p).length).sort((a,b)=>compare(a,b,strategy));
 const amounts=new Map(),buckets={short:0,medium:0,long:0},tiers={},families={},registrations={},trace=[];
 let remaining=10000000;
 function room(p){
  const amount=amounts.get(p.key)||0;
  const single=p.tier==='full_1y'?3000000:1000000;
  return Math.max(0,Math.min(remaining,single-amount,
   p.tier==='full_1y'?Infinity:2000000-(tiers[p.tier]||0),5000000-(families[p.family]||0),
   p.detail?.registration?5000000-(registrations[p.detail.registration]||0):Infinity,
   money(p.amount.amount??50000000)-amount,
   p.orders.max_order===null?Infinity:money(p.orders.max_order)-amount));
 }
 function add(p,budget,slice,phase){
  const before=amounts.get(p.key)||0,min=money(p.orders.minimum),step=money(p.orders.step);
  const limit=Math.max(0,Math.min(room(p),budget,slice));
  const final=Math.floor((before+limit-min)/step)*step+min;
  const delta=final-before;
  if(delta<=0||(!before&&final<Math.max(min,500000))||(before&&delta<min))return false;
  assert(delta<=limit);assert(final>=min);assert.equal((final-min)%step,0);
  amounts.set(p.key,final);remaining-=delta;buckets[p.bucket]+=delta;
  tiers[p.tier]=(tiers[p.tier]||0)+delta;families[p.family]=(families[p.family]||0)+delta;
  if(p.detail?.registration)registrations[p.detail.registration]=(registrations[p.detail.registration]||0)+delta;
  trace.push({key:p.key,phase,added:delta/100,total:final/100,bucket:p.bucket,remaining:remaining/100,
   evidence:p.amount.amount===null?'public_status_0_amount_assumption':'explicit_public_amount',backup:strategy==='V'&&!p.v.shortlisted});
  return true;
 }
 function within(rows,phase){
  for(const bucket of ['short','medium','long']){
   const peers=rows.filter(p=>p.bucket===bucket);
   // First pass preserves the old 10,000-yuan target slice, then tops up without a second new-position threshold.
   for(const p of peers)if(buckets[bucket]<targets[bucket])add(p,targets[bucket]-buckets[bucket],1000000,phase+'_initial');
   for(const p of peers)if(buckets[bucket]<targets[bucket])add(p,targets[bucket]-buckets[bucket],Infinity,phase+'_top_up');
  }
 }
 within(candidates,'strategy_priority');
 // Preserve risk caps; the latest full-investment mandate takes precedence over soft bucket targets.
 const fallback=[...candidates].sort((a,b)=>compare(a,b,strategy));
 for(const p of fallback)if(remaining>0)add(p,remaining,1000000,'cross_bucket_initial');
 for(const p of fallback)if(remaining>0)add(p,remaining,Infinity,'cross_bucket_top_up');
 assert.equal(remaining,0,strategy+'-'+scenario+' must invest all principal without violating risk caps');
 const allocations=candidates.filter(p=>amounts.has(p.key)).map(p=>({key:p.key,amount:amounts.get(p.key)/100,bucket:p.bucket,
  code:p.code,name:p.name,issuer:p.issuer,days:p.shared_term,tier:p.tier,reference:p.shared_metrics.reference_yield_pct,
  return_1m:Number(p.performance['1m']),v_native_shortlisted:p.v.shortlisted,v_rank:p.v.rank,
  quota_status:p.quota.status,quota_checked_at:p.quota.checked_at,quota_amount_raw:p.amount.raw,quota_amount:p.amount.amount,
  quota_amount_checked_at:p.quota.amount_checked_at??null,amount_assumption:p.amount.amount===null,
  quota_treatment:p.amount.amount===null?{kind:'user_rule_lower_bound',lower_bound_cny:50000000,relation:'>',source:'user_instruction',bank_amount_raw:null}:{kind:p.amount.kind,amount_cny:p.amount.amount,bank_amount_raw:p.amount.raw},
  minimum:p.orders.minimum,increment:p.orders.step,max_order:p.orders.max_order,max_order_verified:p.orders.max_order_verified,
  family:p.family,registration:p.detail?.registration??null,metrics:p.v.metrics}));
 const weighted=nsum(allocations,p=>p.amount*p.reference)/100000;
 const explicit=nsum(allocations,p=>p.amount_assumption?0:p.amount);
 assert.equal(nsum(allocations,p=>money(p.amount)),10000000);
 return {name:strategy+'-'+scenario,version:'full-investment-v2',native_candidates:native.length,buyable_candidates:candidates.length,
  allocated:100000,unallocated:0,product_count:allocations.length,reference_yield:weighted,return_1m:nsum(allocations,p=>p.amount*p.return_1m)/100000,
  static_90d:100000*weighted/100*90/365,reference_coverage:100,explicit,assumed:100000-explicit,explicit_pct:explicit/1000,assumption_pct:(100000-explicit)/1000,
  buckets:Object.fromEntries(Object.entries(buckets).map(([b,a])=>[b,{target:targets[b]/100,amount:a/100,deviation:(a-targets[b])/100}])),
  liquidity_amount:buckets.short/100,liquidity_target_met:buckets.short>=3000000,
  tiers:Object.fromEntries(Object.entries(tiers).map(([k,v])=>[k,v/100])),families:Object.fromEntries(Object.entries(families).map(([k,v])=>[k,v/100])),
  allocations,rejected,trace};
}
const groups=['S','E'].flatMap(s=>['O','V'].map(o=>allocate(o,s)));
const output={version:'full-investment-v2',correction_date:'2026-11-07',information_cutoff:supplement.finished_at,
  rules:{principal:100000,required_allocation_pct:100,cash_target:0,bucket_targets_pct:{short:30,medium:35,long:35},bucket_targets_are_soft:true,
   max_single_pct:30,lower_evidence_single_pct:10,each_lower_evidence_aggregate_pct:20,family_pct:50,
   explicit_amount_priority:false,
   blank_amount_rule:{requires_public_status:0,lower_bound_cny:50000000,relation:'>',source:'user_instruction',affects_ranking:false},
   S:'All verified-public-status-0 candidates in strategy order; known balance respected, blank amount treated as >50 million CNY under user rule, without ranking penalty.',
   E:'Same execution rule as S after user cancelled explicit-amount priority; retained as a compatibility alias, not an independent scenario.',
   reserve_pool:'V uses all eligible products in group order, not only the research top 3; no watch/rejected/pending product is promoted.',
   incomplete_order_rule:'Missing increment blocks a product; missing maximum order remains a disclosed evidence gap, not a verified unlimited order.'},
  legacy_diagnostic:{file:'results.json',reason:'The old explicit-amount-only E is a disclosure-coverage diagnostic and does not satisfy the user mandate.'},
  groups};
fs.writeFileSync(path.join(dir,'full-investment-results.json'),JSON.stringify(output,null,2)+'\n');
const {parseCsv}=require('../../../lib/products');
const base=parseCsv(fs.readFileSync(path.join(dir,'products.csv'),'utf8').replace(/^\uFEFF/,''));
const h=base.shift(),ki=h.indexOf('key');
const all=[...h.map(x=>groups.some(g=>g.name===x||g.name+'_reason'===x)?'legacy_'+x:x),...groups.flatMap(g=>[g.name,g.name+'_phase'])];
const csvCell=v=>'"'+String(v??'').replaceAll('"','""')+'"';
const rows=base.map(row=>[...row,...groups.flatMap(g=>[g.allocations.find(p=>p.key===row[ki])?.amount??0,g.trace.filter(p=>p.key===row[ki]).map(p=>p.phase).join(';')])]);
fs.writeFileSync(path.join(dir,'full-investment-products.csv'),'\uFEFF'+[all,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n');
console.log(JSON.stringify(groups.map(g=>({name:g.name,allocated:g.allocated,reference:g.reference_yield,explicit:g.explicit,buckets:g.buckets,allocations:g.allocations.map(p=>({key:p.key,amount:p.amount,backup:!p.v_native_shortlisted}))})),null,2));
