'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {CONTRACT_HASH}=require('../server/modules/r2-strategy/contract');
const {validateReplacementPortfolio:validate}=require('../server/modules/r2-strategy/replacement-constraints');
function fixture(){
 const row=(lot,amount,product,family,bucket='short')=>({key:lot,lot_id:lot,source:'confirmed_holding',amount_cents:amount,product_code:product,product_key:product,family_key:family,bucket,evidence_tier:'full_1y',liquidity_eligible:bucket==='short',available_on:'2026-11-09'});
 const exposures=[row('lot1',20000,'A','f1'),row('lot2',20000,'B','f2'),row('lot3',30000,'C','f3','medium'),row('lot4',30000,'D','f4','long')];
 return {account:{verified:true,contract_hash:CONTRACT_HASH,blockers:[],principal_cents:100000,committed_cents:100000,blocked_cash_cents:0,exposures},holding:{lot_id:'lot1',product_code:'A'},candidate:{automatic_eligible:true,evidence_tier:'full_1y',mapping:{product_code:'E'},term:{days:30}},pretrade:{executable:true,limits:{product_key:'E',family_key:'f5',liquidity_eligible:true,available_on:'2026-11-09'}},settings:{cash_needs:[{by_date:'2026-11-10',required_cents:100000}]},amount_cents:20000};
}
test('replacement uses whole principal and exact lot without modifying frozen inputs',()=>{
 const f=fixture(),before=JSON.stringify(f);assert.deepEqual(validate(f),{ok:true,reasons:[]});assert.equal(JSON.stringify(f),before);
 f.amount_cents=21000;assert.equal(validate(f).ok,false);
});
test('replacement aggregates same registration, families and limited history tiers',()=>{
 const f=fixture();f.pretrade.limits.product_key='B';assert.ok(validate(f).reasons.includes('replacement_product_cap'));
 f.pretrade.limits.product_key='E';f.pretrade.limits.family_key='f2';f.account.exposures[2].family_key='f2';assert.ok(validate(f).reasons.includes('replacement_family_cap'));
 const g=fixture();g.candidate.evidence_tier='six_month';assert.ok(validate(g).reasons.includes('replacement_evidence_single_cap'));
 const h=fixture();h.amount_cents=10000;h.candidate.evidence_tier='three_month';h.account.exposures[1].evidence_tier='three_month';assert.ok(validate(h).reasons.includes('replacement_evidence_tier_cap'));
});
test('replacement rejects diminished liquidity, unavailable cash, unknown evidence and changed buckets',()=>{
 const f=fixture();f.pretrade.limits.liquidity_eligible=false;assert.ok(validate(f).reasons.includes('replacement_liquidity_conflict'));
 const g=fixture();g.pretrade.limits.available_on='2026-11-11';assert.ok(validate(g).reasons.includes('replacement_cashflow_conflict'));
 const h=fixture();h.candidate.evidence_tier='one_month';assert.equal(validate(h).ok,false);
 const i=fixture();i.candidate.term.days=90;assert.ok(validate(i).reasons.includes('replacement_bucket_changed'));
 const j=fixture();j.account.verified=false;assert.equal(validate(j).ok,false);
});
