'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { gunzipSync } = require('node:zlib');
const { createHash } = require('node:crypto');
const dir = __dirname;
const input = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, 'evidence.json.gz'))));
const { shares, audit } = input;
const rawPool = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, 'pool.json.gz')))).raw;
const supplement = JSON.parse(gunzipSync(fs.readFileSync(path.join(dir, 'supplement.json.gz'))));
const supplementByKey = new Map(supplement.records.map(r=>[r.key,r]));
const sha = s => createHash('sha256').update(s).digest('hex');
const cache = new Map();
let trace = [];
function frozen(file, instrument = false) {
  const key = file + instrument;
  if (cache.has(key)) return cache.get(key);
  const rule = audit.rules.find(r => r.file === file);
  assert(rule, file); assert.equal(sha(rule.text), rule.sha256);
  let text = rule.text;
  if (instrument) {
    // Preserve allocation logic; only apply a known order increment and expose the decision inputs.
    text = text.replace('const room = Math.min(', 'let room = Math.min(')
      .replace('const effectiveFamilyCapPct = familyKeys.size <= 1 ? 100 : 50;', 'const effectiveFamilyCapPct = 50;')
      .replace('if (!Number.isFinite(room) || room < requiredMinimum) {', `
      if (product.quant_step_cents) room = Math.floor((Math.floor(room * 100 + 1e-7) - Math.round(minAmount * 100)) / product.quant_step_cents) * product.quant_step_cents / 100 + minAmount;
      quantTrace({ code: product.code, bucket, unallocated, room, requiredMinimum, minAmount, productRoom, evidenceRoom, familyRoom, quotaRoom, orderRoom });
      if (!Number.isFinite(room) || room < requiredMinimum) {`);
  }
  const module = { exports: {} };
  vm.runInNewContext(text, { module, exports: module.exports,
    require: id => id.startsWith('.') ? frozen(path.posix.normalize(path.posix.join(path.posix.dirname(file), id + '.js'))) : require(id),
    quantTrace: row => trace.push(row), console }, { filename: file });
  cache.set(key, module.exports);
  return module.exports;
}
const P = frozen('lib/products.js'), Y = frozen('lib/yield-policy.js');
const V = frozen('server/modules/r2-screening/policy.js');
const { valuationCalendar } = frozen('server/modules/r2-screening/calendar.js');
const engine = frozen('lib/products.js', true);
const number = v => v === null || v === undefined || String(v).trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v);
const pct = (n, d) => d ? n / d * 100 : null;
const sum = (rows, fn) => rows.reduce((s, r) => s + fn(r), 0);
const plain = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').normalize('NFKC').trim();
function quota(text) {
  if (!text) return { kind: 'unknown', amount: null, raw: null };
  const m = String(text).normalize('NFKC').match(/剩余\s*额度\s*[:：]?\s*(大于|超过|不少于|至少|小于|低于|约|[<>≤≥])?\s*([\d,.]+)\s*(万|亿)?元/);
  if (!m) return { kind: 'unrecognized', amount: null, raw: text };
  const amount = Number(m[2].replaceAll(',', '')) * (m[3] === '亿' ? 1e8 : m[3] === '万' ? 1e4 : 1);
  const kind = !m[1] ? 'exact' : /大于|超过|不少于|至少|[>≥]/.test(m[1]) ? 'lower_bound' : /小于|低于|[<≤]/.test(m[1]) ? 'upper_bound' : 'approximate';
  return { raw: text, kind, amount: ['exact', 'lower_bound'].includes(kind) ? Math.floor(amount * 100 + 1e-7) / 100 : null, stated_value: amount, unit: 'CNY' };
}
function orders(p) {
  const raw = p.detail_raw || {};
  const rows = [...String(raw.prdIntro || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => plain(m[1]));
  const clauses = rows.filter(s => /起购|起点|最低认购|最低申购|递增|追加|单笔|单次|上限|限额/.test(s));
  const cleaned = clauses.map(s=>s.replace(/[【】\[\]]/g,'').replaceAll('人民币',''));
  const suffix = p.code.match(/[A-Za-z]+$/)?.[0];
  function sameShare(s) {
    const sections = [...s.matchAll(/(?:^|\s)([A-Za-z]{1,6})\s*(?:类)?\s*份额\s*[:：]/g)];
    const match = sections.find(m=>m[1]===suffix);
    if (!match) return s;
    const next = sections.find(m=>m.index>match.index);
    return s.slice(match.index,next?.index);
  }
  const stepText = cleaned.find(s=>/^(?:追加)?递增金额/.test(s));
  const stepValues = stepText ? [...sameShare(stepText).matchAll(/([\d.]+)\s*元/g)].map(m=>Number(m[1]))
    : cleaned.flatMap(s=>[...sameShare(s).matchAll(/以\s*([\d.]+)\s*元.{0,16}?(?:整数倍|递增|增加)/g)].map(m=>Number(m[1])));
  const uniqueStep = [...new Set(stepValues)];
  const step = uniqueStep.length===1&&uniqueStep[0]>0 ? uniqueStep[0] : null;
  const maxText = cleaned.find(s => /(?:单笔|单次).{0,12}(?:上限|不超过|不得超过|最高).{0,10}[\d.]+\s*(?:万|亿)?元/.test(s) && /认购|申购/.test(s));
  const max = maxText?.match(/(?:单笔|单次).{0,12}(?:上限|不超过|不得超过|最高).{0,10}?([\d.]+)\s*(万|亿)?元/);
  const unlimited = cleaned.some(s=>/不(?:设|设置|设定).{0,15}单笔.{0,15}(?:申购|认购).{0,6}上限|单笔.{0,12}(?:申购|认购).{0,12}(?:不设上限|无限额)/.test(s));
  return { minimum: number(p.min_amount), step,
    max_order: max ? Number(max[1]) * (max[2] === '万' ? 1e4 : max[2] === '亿' ? 1e8 : 1) : null,
    max_order_verified: Boolean(max || unlimited),
    clauses, raw_fields: Object.fromEntries(Object.entries(raw).filter(([k,v]) => /buy|amt|min|max|add|step|lmt|limit/i.test(k) && typeof v !== 'object')),
    mode: 'new_position', additional_purchase: 'not_applicable_no_holdings' };
}
function oldReasons(p) {
  const x = p.original, result = [];
  if (!/^(R|PR)2$/.test(x.risk_level)) result.push('risk');
  if (x.currency_code && x.currency_code !== '10') result.push('currency');
  if (x.pub_prv && x.pub_prv !== 'A') result.push('private_offering');
  if (/私行|私银|私享|尊享|企享|专属|私募/.test(x.name + ' ' + x.short_name)) result.push('restricted_name');
  if (x.capacity === 0) result.push('zero_capacity');
  if (P.bucketForTerm(x.term_days) === 'unknown') result.push('unknown_native_term');
  if (p.raw_status !== '1') result.push('not_open');
  if (P.bucketForTerm(x.term_days) === 'cash') result.push('cash_display_only');
  if (!P.EVIDENCE_POLICY[P.returnEvidenceTier(x)].scoring) result.push('evidence_not_scoring');
  if (Y.calculateYieldMetrics(x).reference_yield_status !== 'available') result.push('reference_unavailable');
  return result;
}
for (const p of shares) {
  p.key = p.channel + '/' + p.code;
  const sourceIndex=rawPool.filter(r=>r.statusText===p.raw_status).findIndex(r=>r.saacod===p.channel&&r.code===p.code);
  p.list_page=Math.floor(sourceIndex/50)+1;
  const request=audit.requests.find(r=>r.status===p.raw_status&&r.page===p.list_page);
  p.list_checked_at=request?.finished_at??null;
  p.list_requested_at=request?.at??null;
  // Missing windows remain null; the old CSV mapper's Number('') behaviour is not used.
  for (const label of ['1m','3m','6m','1y']) p.original['return_' + label] = number(p.performance[label]);
  p.original.min_amount = number(p.min_amount);
  p.o_reasons = oldReasons(p);
  p.o_pool = P.isProductPoolEligible(p.original);
  p.o_candidate = P.isObservationReady(p.original);
  p.o_metrics = Y.calculateYieldMetrics(p.original);
  p.tier = P.returnEvidenceTier(p.original);
  p.amount = quota(p.quota?.amount);
  p.orders = orders(p);
  const doc=supplementByKey.get(p.key);
  if(doc?.pages) {
    const suffix=p.code.match(/[A-Za-z]+$/)?.[0];
    const found=doc.pages.flatMap(page=>{
      const compact=page.text.replace(/\s+/g,'').replace(/[【】]/g,'');
      return [...compact.matchAll(/([A-Z]{1,6})份额投资者单笔申购上限为([\d.]+)(万|亿)?元/g)]
        .filter(m=>m[1]===suffix).map(m=>({page:page.page,value:Number(m[2])*(m[3]==='亿'?1e8:m[3]==='万'?1e4:1),clause:compact.slice(m.index,m.index+110)}));
    });
    const values=[...new Set(found.map(x=>x.value))];
    if(values.length===1) {
      p.orders.max_order=values[0];p.orders.max_order_verified=true;
      p.orders.pdf_order_evidence={url:doc.url,checked_at:doc.checked_at,disclosure_date:doc.disclosure_date,...found[0]};
      p.orders.share_scale_limit_unknown=found.some(x=>/规模上限.{0,10}较小值/.test(x.clause));
    }
  }
  p.shared_term = p.detail?.term?.days ?? null;
  p.bucket = P.bucketForTerm(p.shared_term);
  p.shared_metrics = Y.calculateYieldMetrics({ ...p.original, term_days: p.shared_term });
  p.family = p.original.benchmark?.replace(/\s+/g, '') ? 'benchmark|' + p.original.benchmark.replace(/\s+/g, '') : 'product|' + p.code;
}
const screened = V.screen(shares.filter(p => p.raw_status === '1'), audit.date, valuationCalendar);
const byV = new Map(screened.results.map(p => [p.channel + '/' + p.code, p]));
const oSorted = shares.filter(p => p.o_candidate).sort((a,b) => b.o_metrics.selection_score - a.o_metrics.selection_score ||
  (b.original.return_3m ?? -Infinity) - (a.original.return_3m ?? -Infinity) ||
  (b.original.return_6m ?? -Infinity) - (a.original.return_6m ?? -Infinity) || a.code.localeCompare(b.code) || a.channel.localeCompare(b.channel));
const ranks = {};
oSorted.forEach((p,i) => { const b=P.bucketForTerm(p.original.term_days); p.o_order=i+1; p.o_bucket_rank=(ranks[b]||0)+1; ranks[b]=p.o_bucket_rank; });
shares.forEach(p => { p.v = byV.get(p.key) || { status:'not_open', shortlisted:false, rank:null, reasons:[{ gate:'open', outcome:'reject', code:'not_open' }], hints:[], metrics:{} }; });
const vSorted = shares.filter(p => p.v.shortlisted).sort((a,b) => b.v.yield_1m - a.v.yield_1m || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : a.code < b.code ? -1 : 1));
const params = { principal:100000, targets:{short:30000,medium:35000,long:35000}, target_slice:10000, minimum_new:5000,
  single_pct:30, family_pct:50, lower_evidence_single_pct:10, lower_evidence_total_pct:20, horizon_days:90, v_group_limit:3 };
function allocate(strategy, scenario, limit=3, strictOrders=false) {
  const chosen = strategy === 'O' ? oSorted : vSorted.filter(p => p.v.rank <= limit);
  trace = [];
  const input = [], rejected = [];
  const quota_by_code = {};
  for (const [i,p] of chosen.entries()) {
    const reasons = [];
    if (!['short','medium','long'].includes(p.bucket)) reasons.push('term_unverified_or_daily');
    if (p.orders.minimum === null || p.orders.minimum <= 0) reasons.push('minimum_unverified');
    if (p.raw_status !== '1') reasons.push('not_open');
    if (p.quota?.status === 1) reasons.push(p.amount.amount > 0 ? 'sold_out_with_amount_conflict' : 'sold_out');
    else if (p.quota?.status !== 0) reasons.push('quota_status_pending');
    if (!P.EVIDENCE_POLICY[p.tier].automatic) reasons.push('evidence_not_automatic');
    if (p.shared_metrics.reference_yield_status !== 'available') reasons.push('shared_reference_unavailable');
    if (strictOrders && (p.orders.step === null || !p.orders.max_order_verified)) reasons.push('order_rule_unverified');
    if (scenario === 'E' && p.amount.amount === null) reasons.push('quota_amount_unknown');
    if (reasons.length) { rejected.push({ key:p.key, reasons }); continue; }
    const available = p.amount.amount ?? 50000000;
    quota_by_code[p.key] = { available, max_order:p.orders.max_order, verified_at:p.quota.checked_at };
    input.push({ ...p.original, code:p.key, term_days:p.shared_term, bucket:p.bucket, evidence_tier:p.tier,
      selection_score:1000000-i, min_amount:p.orders.minimum, quant_step_cents:p.orders.step === null ? null : Math.round(p.orders.step*100) });
  }
  const result = engine.buildAllocation(input, { principal:100000, settings:{quota_by_code} });
  const allocations = input.filter(x => x.selected).map(x => ({ key:x.code, amount:x.target_amount, bucket:x.bucket }));
  const selected = allocations.map(a => ({...a,p:shares.find(p=>p.key===a.key)}));
  const allocated = Math.round(sum(allocations,a=>a.amount)*100)/100, calculable = selected.filter(a=>a.p.shared_metrics.reference_yield_pct!==null);
  const cp=sum(calculable,a=>a.amount), weighted=cp ? sum(calculable,a=>a.amount*a.p.shared_metrics.reference_yield_pct)/cp : null;
  const explicit=sum(selected,a=>a.p.amount.amount===null?0:a.amount), assumed=allocated-explicit;
  const aggregate = key => Object.fromEntries([...new Set(selected.map(a=>key(a.p)))].map(k=>[k,sum(selected,a=>key(a.p)===k?a.amount:0)]));
  const flags = {
    frequent_zero:sum(selected,a=>a.p.v.metrics?.zero_dates?.length>=3?a.amount:0),
    trend_weak:sum(selected,a=>a.p.v.metrics?.trend==='weak'?a.amount:0),
    trend_unknown:sum(selected,a=>!['weak','steady'].includes(a.p.v.metrics?.trend)?a.amount:0),
    drawdown_unknown:sum(selected,a=>a.p.v.metrics?.drawdown?.pct==null?a.amount:0),
    drawdown_ge_1:sum(selected,a=>a.p.v.metrics?.drawdown?.pct>=1?a.amount:0),
    unrepaired:sum(selected,a=>a.p.v.metrics?.drawdown?.recovery==='unrepaired'?a.amount:0),
    short_history:sum(selected,a=>a.p.tier!=='full_1y'?a.amount:0),
    recent_surge_05pp:sum(selected,a=>a.p.original.return_1m!==null&&a.p.original.return_3m!==null&&a.p.original.return_1m-a.p.original.return_3m>=0.5?a.amount:0),
    below_v9_1m:sum(selected,a=>a.p.original.return_1m!==null&&a.p.original.return_1m<2.15?a.amount:0),
    order_step_unknown:sum(selected,a=>a.p.orders.step===null?a.amount:0),
    order_max_unknown:sum(selected,a=>!a.p.orders.max_order_verified?a.amount:0),
    family_fallback:sum(selected,a=>a.p.family.startsWith('product|')?a.amount:0),
  };
  const families=aggregate(p=>p.family), tiers=aggregate(p=>p.tier), issuers=aggregate(p=>p.issuer);
  assert.equal(Math.round((allocated+result.unallocated_amount)*100),10000000);
  for (const a of selected) {
    assert(a.amount<=30000); assert(a.amount>=Math.max(a.p.orders.minimum,5000));
    assert(a.p.quota.status===0); assert(a.amount<=(a.p.amount.amount??50000000));
    if(a.p.tier!=='full_1y') assert(a.amount<=10000);
    if(a.p.orders.max_order!==null) assert(a.amount<=a.p.orders.max_order);
    if(a.p.orders.step!==null) assert.equal((Math.round(a.amount*100)-Math.round(a.p.orders.minimum*100))%Math.round(a.p.orders.step*100),0);
  }
  for(const n of Object.values(families)) assert(n<=50000);
  for(const tier of ['six_month','three_month']) assert((tiers[tier]||0)<=20000);
  for(const b of result.buckets) assert(b.new_amount<=params.targets[b.key]);
  return {name:strategy+'-'+scenario+(limit===2?'-top2':'')+(strictOrders?'-orderVerified':''), candidate_count:chosen.length,
    allocated, unallocated:result.unallocated_amount, product_count:allocations.length, calculable_principal:cp,
    yield_data_gap:allocated-cp, reference_yield:weighted, reference_coverage:pct(cp,allocated),
    return_1m:allocated?sum(selected,a=>a.amount*(a.p.original.return_1m??0))/allocated:null,
    return_1m_coverage:pct(sum(selected,a=>a.p.original.return_1m===null?0:a.amount),allocated),
    static_90d:cp?sum(calculable,a=>a.amount*a.p.shared_metrics.reference_yield_pct/100*90/365):null,
    explicit,assumed,explicit_pct:pct(explicit,allocated),assumption_pct:pct(assumed,allocated),
    liquid_7_30:sum(selected,a=>a.p.shared_term>=7&&a.p.shared_term<=30?a.amount:0),
    locked_over_90:sum(selected,a=>a.p.shared_term>90?a.amount:0),
    max_single:Math.max(0,...allocations.map(a=>a.amount)),top3:allocations.map(a=>a.amount).sort((a,b)=>b-a).slice(0,3).reduce((a,b)=>a+b,0),
    families,tiers,issuers,flags,allocations,buckets:result.buckets,rejected,trace };
}
const groups = ['S','E'].flatMap(s=>['O','V'].map(o=>allocate(o,s)));
const sensitivity = ['S','E'].flatMap(s=>[allocate('V',s,2),allocate('O',s,3,true),allocate('V',s,3,true)]);
// Native O diagnostic: verify the trace adapter preserves original allocator without order-specific inputs.
const native = oSorted.map((p,i)=>({...p.original,code:p.key,bucket:P.bucketForTerm(p.original.term_days),evidence_tier:p.tier,selection_score:1000000-i}));
P.buildAllocation(native,{principal:100000});
const nativeSet = new Set(native.filter(p=>p.selected).map(p=>p.code));
const parity = oSorted.map((p,i)=>({...p.original,code:p.key,bucket:P.bucketForTerm(p.original.term_days),evidence_tier:p.tier,selection_score:1000000-i}));
engine.buildAllocation(parity,{principal:100000});
assert.deepEqual(native.map(p=>[p.code,p.target_amount||0]),parity.map(p=>[p.code,p.target_amount||0]));
shares.forEach(p=>p.o_native_selected=nativeSet.has(p.key));
const breakdown = rows => Object.fromEntries([...new Set(rows)].map(k=>[k,rows.filter(x=>x===k).length]));
const quality = {
  scope:audit.scope, raw_rows:rawPool.length,
  shares:shares.length, open:shares.filter(p=>p.raw_status==='1').length, unopened:shares.filter(p=>p.raw_status!=='1').length,
  o_pool:shares.filter(p=>p.o_pool).length,o_candidates:oSorted.length,o_native_selected:nativeSet.size,v_counts:screened.counts,
  o_first_exclusion:breakdown(shares.map(p=>p.o_reasons[0]||'candidate')),
  v_first_exclusion:breakdown(shares.map(p=>p.v.reasons.find(r=>['reject','pending'].includes(r.outcome))?.code||p.v.status)),
  coverage:['O','V'].map(strategy=>{
    const rows=strategy==='O'?oSorted:vSorted;
    return {strategy,total:rows.length,quota_status:rows.filter(p=>[0,1].includes(p.quota?.status)).length,
      explicit_amount:rows.filter(p=>p.amount.amount!==null).length,detail:rows.filter(p=>p.detail).length,
      nav:rows.filter(p=>p.nav?.points?.length).length,known_term:rows.filter(p=>p.shared_term!==null).length,
      known_min:rows.filter(p=>p.orders.minimum!==null).length,known_step:rows.filter(p=>p.orders.step!==null).length,
      known_order_max:rows.filter(p=>p.orders.max_order_verified).length,
      windows:Object.fromEntries(['1m','3m','6m','1y'].map(w=>[w,rows.filter(p=>p.performance[w]!==undefined).length]))};
  }),
  term_bucket_conflicts:oSorted.filter(p=>p.shared_term!==null&&p.bucket!==P.bucketForTerm(p.original.term_days)).map(p=>({key:p.key,native:p.original.term_days,verified:p.shared_term})),
  data_dates:breakdown(shares.filter(p=>p.raw_status==='1').map(p=>p.performance_date)),
  failures:audit.failures,
};
const output = {params,audit:{...audit,information_cutoff:supplement.finished_at,supplement:{started_at:supplement.started_at,finished_at:supplement.finished_at,requested:supplement.records.length,extracted:supplement.records.filter(r=>r.pages).length},rules:audit.rules.map(({text,...r})=>r)},quality,groups,sensitivity,
  rules_comparison:{ common_native:[...nativeSet].filter(k=>vSorted.some(p=>p.key===k)),only_O_native:[...nativeSet].filter(k=>!vSorted.some(p=>p.key===k)),only_V_native:vSorted.filter(p=>!nativeSet.has(p.key)).map(p=>p.key) } };
fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(output,null,2)+'\n');
const fields = ['key','name','issuer','raw_status','registration','native_term','verified_term','category','O_pool','O_candidate','O_bucket_rank','O_native_selected','O_score','O_reasons','V_state','V_rank','V_selected','V_reasons','V_hints','1m','3m','6m','1y','reference','reference_weights','tier','performance_date','list_page','list_requested_at','list_checked_at','quota_status','quota_status_checked_at','quota_requested_at','quota_raw','amount_kind','amount_cny','amount_checked_at','amount_state','minimum','step','max_order','max_order_verified','order_clauses','detail_checked_at','nav_checked_at','nav_start','nav_end','nav_count','nav_pages','nav_total','max_drawdown','recovery','repair_date','zero_dates','trend','monthly_returns','family',...groups.map(g=>g.name),...groups.map(g=>g.name+'_reason')];
fields.push('pdf_order_evidence','share_scale_limit_unknown');
const csvCell = v => '"'+String(v===null||v===undefined?'':typeof v==='object'?JSON.stringify(v):v).replaceAll('"','""')+'"';
const csv=[fields];
for(const p of shares) {
  const m=p.v.metrics||{};
  const row={key:p.key,name:p.name,issuer:p.issuer,raw_status:p.raw_status,registration:p.detail?.registration,native_term:p.original.term_days,verified_term:p.shared_term,category:p.detail?.category,
    O_pool:p.o_pool,O_candidate:p.o_candidate,O_bucket_rank:p.o_bucket_rank,O_native_selected:p.o_native_selected,O_score:p.o_metrics.selection_score,O_reasons:p.o_reasons,
    V_state:p.v.status,V_rank:p.v.rank,V_selected:p.v.shortlisted,V_reasons:p.v.reasons,V_hints:p.v.hints,
    ...Object.fromEntries(['1m','3m','6m','1y'].map(w=>[w,p.performance[w]])),reference:p.shared_metrics.reference_yield_pct,reference_weights:p.shared_metrics.reference_normalized_weights,tier:p.tier,
    performance_date:p.performance_date,list_page:p.list_page,list_requested_at:p.list_requested_at,list_checked_at:p.list_checked_at,quota_status:p.quota?.status,quota_status_checked_at:p.quota?.checked_at,quota_requested_at:p.quota_requested_at,
    quota_raw:p.amount.raw,amount_kind:p.amount.kind,amount_cny:p.amount.amount,amount_checked_at:p.quota?.amount_checked_at,amount_state:p.quota?.amount_state,
    minimum:p.orders.minimum,step:p.orders.step,max_order:p.orders.max_order,max_order_verified:p.orders.max_order_verified,order_clauses:p.orders.clauses,detail_checked_at:p.detail_checked_at,nav_checked_at:p.nav_checked_at,
    nav_start:m.start,nav_end:m.end,nav_count:m.count,nav_pages:p.nav?.pages,nav_total:p.nav?.total,max_drawdown:m.drawdown?.pct,recovery:m.drawdown?.recovery,repair_date:m.drawdown?.repair_date,
    zero_dates:m.zero_dates,trend:m.trend,monthly_returns:m.monthly_returns,family:p.family,pdf_order_evidence:p.orders.pdf_order_evidence,share_scale_limit_unknown:p.orders.share_scale_limit_unknown};
  for(const g of groups) {
    row[g.name]=g.allocations.find(a=>a.key===p.key)?.amount||0;
    const pre=g.rejected.find(r=>r.key===p.key);
    const attempted=g.trace.filter(r=>r.code===p.key);
    row[g.name+'_reason']=row[g.name]>0?'allocated':pre?.reasons||
      (attempted.length?attempted.map(r=>r.room<r.requiredMinimum?Object.entries({quota:r.quotaRoom,order:r.orderRoom,single:r.productRoom,evidence:r.evidenceRoom,family:r.familyRoom,bucket:r.unallocated}).filter(([,v])=>v<r.requiredMinimum).map(([k])=>k).concat('minimum_5000_or_bank'):'budget_exhausted'):
      ((g.name[0]==='O'&&!p.o_candidate)||(g.name[0]==='V'&&!p.v.shortlisted)?'not_selected':'bucket_filled_before_rank'));
  }
  csv.push(fields.map(f=>row[f]));
}
fs.writeFileSync(path.join(dir,'products.csv'),'\uFEFF'+csv.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n');
const selectedKeys = new Set(groups.flatMap(g=>g.allocations.map(a=>a.key)));
const keyIndex=fields.indexOf('key');
const nativeUnion=new Set([...nativeSet,...vSorted.map(p=>p.key)]);
for(const [file,keys] of [['allocations.csv',selectedKeys],['rule-differences.csv',nativeUnion]]) {
  fs.writeFileSync(path.join(dir,file),'\uFEFF'+[fields,...csv.slice(1).filter(r=>keys.has(r[keyIndex]))].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n');
}
fs.writeFileSync(path.join(dir,'quality.json'),JSON.stringify(quality,null,2)+'\n');
console.log(JSON.stringify({shares:shares.length,assertions:'passed',groups:groups.map(g=>({name:g.name,allocated:g.allocated,reference:g.reference_yield})),adapter_native_parity:true}));
