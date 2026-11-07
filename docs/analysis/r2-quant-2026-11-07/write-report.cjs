'use strict';
const fs=require('node:fs'),path=require('node:path');
const r=require('./results.json');
const {parseCsv}=require('../../../lib/products');
const data=parseCsv(fs.readFileSync(path.join(__dirname,'products.csv'),'utf8').replace(/^\uFEFF/,''));
const headers=data.shift(),rows=data.map(row=>Object.fromEntries(headers.map((h,i)=>[h,row[i]])));
const byKey=new Map(rows.map(p=>[p.key,p]));
const f=(v,d=2)=>v===null||v===undefined||v===''?'不可计算':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const esc=s=>String(s??'').replaceAll('|',' / ').replaceAll('\n',' ');
const table=(h,body)=>[h,'| '+h.split('|').slice(1,-1).map(()=>'---').join(' | ')+' |',...body.map(row=>'| '+row.map(esc).join(' | ')+' |')].join('\n');
const money=v=>f(v,2),g=r.groups;
const types={full_1y:'完整1Y',six_month:'6M',three_month:'仅3M',one_month:'仅1M',no_data:'无'};
const label={short:'短',medium:'中',long:'长'};
const bool=v=>v==='true';
const local=s=>s?new Date(s).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false}):'未获取到';
const nativeKeys=new Set(Object.values(r.rules_comparison).flat());
const selectedKeys=new Set(g.flatMap(x=>x.allocations.map(a=>a.key)));
const selected=rows.filter(p=>selectedKeys.has(p.key));
function vWhy(p){
 const reasons=JSON.parse(p.V_reasons);
 const rejects=reasons.filter(x=>['reject','pending'].includes(x.outcome)).map(x=>({yield_below:'1M低于2.15%',sold_out:'售罄',term_exceeds:'超过190天',rolling:'滚动待核',periodic:'定开',yield_unverified:'收益待核'})[x.code]||x.code);
 return rejects.join('、')||(bool(p.V_selected)?'正式候选':'同天数同类别超过第3名');
}
const groupsTable=table('| 组别 | 候选数 | 配置只数 | 配置金额 / 元 | 未分配 / 元 | 统一参考年化 | 近1M年化 | 收益金额覆盖 | 明确额度支持率 | 假设依赖率 | 90天静态参考 / 元 |',g.map(x=>[x.name,x.candidate_count,x.product_count,money(x.allocated),money(x.unallocated),x.reference_yield===null?'不可计算':f(x.reference_yield,4)+'%',x.return_1m===null?'不可计算':f(x.return_1m,4)+'%',x.reference_coverage===null?'不可计算':f(x.reference_coverage,0)+'%',x.explicit_pct===null?'不可计算':f(x.explicit_pct,0)+'%',x.assumption_pct===null?'不可计算':f(x.assumption_pct,0)+'%',x.static_90d===null?'未计算':money(x.static_90d)]));
const bucketTable=table('| 组别 | 短期已配 / 缺口 | 中期已配 / 缺口 | 长期已配 / 缺口 | 7–30天流动性 | 超90天锁定金额 |',g.map(x=>[x.name,...x.buckets.map(b=>money(b.new_amount)+' / '+money(b.unallocated_amount)),money(x.liquid_7_30),money(x.locked_over_90)]));
const coverageTable=table('| 字段 | O候选（626只） | V正式（16只） |',[['状态精确匹配',...r.quality.coverage.map(c=>c.quota_status+'/'+c.total)],['明确额度金额（含极小余额）',...r.quality.coverage.map(c=>c.explicit_amount+'/'+c.total)],['详情 / 净值完整取回',...r.quality.coverage.map(c=>c.detail+' / '+c.nav)],['公开期限可量化',...r.quality.coverage.map(c=>c.known_term+'/'+c.total)],['列表起购额',...r.quality.coverage.map(c=>c.known_min+'/'+c.total)],['递增金额可解析',...r.quality.coverage.map(c=>c.known_step+'/'+c.total)],['单笔上限或明确不设上限可解析',...r.quality.coverage.map(c=>c.known_order_max+'/'+c.total)],...['1m','3m','6m','1y'].map(w=>[w+'收益窗口',...r.quality.coverage.map(c=>c.windows[w]+'/'+c.total)])]);
const allocationsTable=table('| 代码（均为D07渠道） | 已核期限 / 天 | 参考年化 | 近1M | O-S / 元 | V-S / 元 | O-E / 元 | V-E / 元 | 额度原文 |',selected.map(p=>[p.key.split('/')[1],p.verified_term,f(p.reference,4)+'%',f(p['1m'],2)+'%',...g.map(x=>money(p[x.name])),p.quota_raw||'金额未披露；S采用假设']));
const riskTable=table('| 代码 | 净值区间 / 有效点数 | 最大回撤 | 修复 | 最近7点挂零次数 | 走势 | 证据档 |',selected.map(p=>[p.key.split('/')[1],p.nav_start+'～'+p.nav_end+' / '+p.nav_count,f(p.max_drawdown,4)+'%',({none:'无回撤待修复',repaired:'已修复',unrepaired:'未修复',pending:'待核'})[p.recovery]||p.recovery,p.zero_dates?JSON.parse(p.zero_dates).length:'待核',({steady:'未连续走弱',weak:'走弱',pending:'待核',short:'历史不足'})[p.trend]||p.trend,types[p.tier]]));
const nativeTable=table('| 代码 | O原生11只 | V正式16只 | O桶内名次 | V组内名次 | 分歧依据 |',rows.filter(p=>nativeKeys.has(p.key)).map(p=>[p.key.split('/')[1],bool(p.O_native_selected)?'是':'否',bool(p.V_selected)?'是':'否',p.O_bucket_rank||'不可评分',p.V_rank||'—',bool(p.O_native_selected)&&!bool(p.V_selected)?vWhy(p):!bool(p.O_native_selected)&&bool(p.V_selected)?(bool(p.O_candidate)?'O可评分，但原生动态配置未排到；V按具体天数×类别入选':'仅1M证据：V可入选，O不可自动评分'):'共同入选']));
const vTable=table('| 代码 | 天数 / 类别 | 组内名次 | 近1M | 统一参考 | 证据档 | V-S金额 / 元 | 未配置主因 |',rows.filter(p=>bool(p.V_selected)).map(p=>[p.key.split('/')[1],p.verified_term+' / '+p.category,p.V_rank,f(p['1m'])+'%',p.reference===''?'不可计算':f(p.reference,4)+'%',types[p.tier],money(p['V-S']),Number(p['V-S'])>0?'已配置':p.tier==='one_month'?'仅1M，不自动配置':p.quota_raw?'明确余额0.01元不足建仓':'6M档合计20%空间已用尽']));
const riskFlags=[['最大单只',x=>x.max_single],['前三只合计',x=>x.top3],['最大既有策略代理键',x=>Math.max(0,...Object.values(x.families))],['短历史（6M或仅3M）',x=>x.flags.short_history],['频繁挂零',x=>x.flags.frequent_zero],['走势走弱',x=>x.flags.trend_weak],['走势未确定或历史不足',x=>x.flags.trend_unknown],['回撤尚未修复',x=>x.flags.unrepaired],['近1M低于v9门槛',x=>x.flags.below_v9_1m],['1M高于3M至少0.5pp',x=>x.flags.recent_surge_05pp],['递增金额未明确',x=>x.flags.order_step_unknown],['单笔上限未明确',x=>x.flags.order_max_unknown],['无基准、按产品键回退',x=>x.flags.family_fallback]];
const riskSummary=table('| 指标（占已配金额） | O-S | V-S | O-E | V-E |',riskFlags.map(([n,fn])=>[n,...g.map(x=>x.allocated?money(fn(x))+' / '+f(fn(x)/x.allocated*100,1)+'%':'不可计算')]));
const issuerTable=table('| 发行方（展示，不限额） | O-S / 元 | V-S / 元 | O-E / 元 | V-E / 元 |',[...new Set(g.flatMap(x=>Object.keys(x.issuers)))].map(i=>[i,...g.map(x=>money(x.issuers[i]||0))]));
const sensitivityTable=table('| 对照组 | 配置 / 元 | 未分配 / 元 | 统一参考年化 |',r.sensitivity.map(x=>[x.name,money(x.allocated),money(x.unallocated),x.reference_yield===null?'不可计算':f(x.reference_yield,4)+'%']));
const report=`# R2 两套选品策略量化比较结果

执行日期：2026-11-07。对应[执行方案](r2-strategy-quant-comparison-plan-2026-11-07.md)。本次仅使用公开产品数据，以独立于真实账户的100,000元新增资金计算；没有修改账本、研究池或真实持仓。

## 1. 结论与可用范围

**在本轮公开证据和已知订单约束下，S情景中O模拟配置100,000元，V模拟配置70,000元；统一期限加权参考年化分别为2.9913%和2.7666%。两组已配置金额的100%依赖金额缺失时的默认额度假设。** V的近1M加权值更高，为2.7071%，O为2.3105%；O配置中45,000元的近1M低于2.15%，其较高参考值部分来自较长历史窗口，不能推断未来收益更高。

明确金额E情景中，O可在较低参考收益产品上配置100,000元，统一参考年化降至1.8544%；V配置为0。V正式候选只有ZX040225取得明确余额0.01元，低于5,000元首次建仓门槛，其余金额未知。**V-E为0表示公开金额证据不能支持本次建仓，并不表示银行额度全部为0或用户一定买不到。**

这是一份**公开证据条件下的部分比较**。全部实配产品已核验公开期限与列表起购，S组已解析递增单位，但部分单笔上限仍未明确；实际账户资格、实时额度及底层策略穿透也未核验。主表为条件模拟结果。只采用静态订单字段明确的候选时，见第8节的敏感性结果；其中动态份额规模限制仍待核。暂缓对两套策略整体优劣、实际可成交率和长期收益作判断。

## 2. 信息集、来源与覆盖审计

共同主采集窗口（北京时间）：**${local(r.audit.started_at)}—${local(r.audit.finished_at)}**；说明书补核为**${local(r.audit.supplement.started_at)}—${local(r.audit.supplement.finished_at)}**，统一信息截止T为**${local(r.audit.information_cutoff)}**。两套策略共同使用截至T取得的主采集与补核数据；未混入凌晨既有30只通过/17只正式候选批次。所有时间戳原值以UTC留在明细中。主池、收益和额度仍表示各自请求时点，不声称在T同时刷新。

“全量”指**招行统一查询平台公开代销R2请求返回的全量**，请求固定type=PN、isOwn=C、isPublic=Z、riskLevel=R2、crossFinance=Z，分别status=1和2；不代表全国所有银行产品。开放1,013条/21页，未开放5,126条/103页，共6,139条；每页总数、页数及记录数一致。人民币、公募后剩4,330个销售份额，其中开放984、未开放3,346。其余1,809条是币种或公私募范围排除。4330个渠道/代码键无重复，未使用名称合并份额。登记编码仅对补采详情取得的份额交叉核验，不声称全量登记编码覆盖。

原策略可评分候选与v9近1M过门槛产品的并集共696个份额，全部补查状态、详情和完整净值分页，失败0。货架翻至终止游标，共50页，覆盖其中432个份额；未见产品或金额空白均保持未知，不填0。状态与金额逐产品查询时间分列。列表开放与搜索售罄是不同层级事实，分别保留。

${coverageTable}

上述订单覆盖来自公开概览与39份说明书的保守结构化解析；完整说明书补查记录另见第8节。原策略独有候选没有因未采集而被判淘汰；626只的状态、详情、净值覆盖均为100%。公开期限可量化580/626，其余46只不在金额层自动配置。v9正式16只均完成相同层级补采。

主要来源及原始字段：

- [统一查询平台](https://finprod.paas.cmbchina.com/)：queryProdList，原始pastPerf的A/B/C/D分别对应1M/3M/6M/1Y，zprfDat为业绩日；份额须与zripCod、zsaaCod一致。开放样本最新业绩日11月5日，551条；11月4日381条；其余日期和空值见quality.json。原始全池含所有返回记录。
- [公开理财搜索](https://mbsearch.paas.cmbchina.com/finance)：mix/search，代码、渠道和名称精确匹配后的quota_status，0可买、1售罄。
- [移动货架](https://mobile.cmbchina.com/IEntrustFinance/financeproduct/financelist.html)：alllist的dxsTag剩余额度原文，按销售渠道、销售代码匹配。
- [招行详情与历史净值示例](https://cfweb.paas.cmbchina.com/Personal/saproductdetail?saaCod=D07&funCod=120056A&type=prodvalue#toTarget)：ProductInfo详情及ProductValue分页接口；单位净值znavVal、净值日znavDat，保留原始精度和累计净值对照。

净值按冻结的sse-2025-2026日历过滤休市记录，用最新有效净值日往前一年或实际短历史。未对分红、拆分做复权，最大回撤及月度走势可能受影响；不同产品区间不可直接当作同区间风险比较。日期与单位均可在压缩证据文件按销售键定位。

## 3. 冻结规则和金额适配

O沿用r2-dynamic-v4、r2-term-yield-v1、front_load_scheme=B。先检查R2/PR2、人民币、公募、名称不含“私行/私银/私享/尊享/企享/专属/私募”、capacity不为0、合法期限、开放状态；日开只展示，至少3M证据且指定期限收益可计算才能评分。参考权重短期1M/3M/6M=20/50/30，中期3M/6M/1Y=50/30/20，长期=20/40/40，缺失重归一化。选择分再扣1M比3M低超过0.5pp时的0.08、B方案前视扣分，满18/24月加0.015/0.03；排序依次选择分、3M、6M、代码。O不额外施加V的2.15%、190天或回撤门槛。

V复用冻结v9实现：1M不低于2.15%、收益和净值日距筛选日不足7天、quota_status=0、期限不超过190天、定开排除、滚动待核；最大回撤低于1%正式，1%—1.5%观察，高于1.5%淘汰。挂零与走势仅提示。公开类别×具体天数每组最多3只，按1M降序，同分按渠道、代码稳定排序；最多2只另作敏感性。

两套候选独立形成后，金额层复用buildAllocation，不调用其外层O产品准入过滤。保留默认**单只目标10,000元、首次建仓至少max(银行起购,5,000元)**、短中长顺序、单只30%、6M和仅3M各单只10%/同档20%，仅1M不自动配置。每只只占用一次额度，桶间不补差，发行方不限额。

适配仅发生在离线内存中，生产源码未变：用策略原生次序驱动桶内排序；共享金额层改用公开详情核验期限；已明确递增单位向下取整；底层代理键上限固定50%，关闭原函数“仅一个键可放宽100%”特例。相同基准字符串为既有策略代理键，无基准则回退产品代码；**它不是已穿透的底层策略识别**，对应占比只作代理检查。原生O金额分配与适配器无订单改动时逐产品一致性断言通过。

原实现名称解析与详情期限跨桶冲突有2只：ZX040229的30天改为31天，ZX040309的7天改为369天；保留原生筛选与评分，金额层使用核验期限；两只未进入四组实际配置。缺失收益保持null，未使用旧CSV映射中空字符串转0的行为。

S：状态0且明确金额按金额；金额未知按50,000,000元假设，仅标为假设，不当作银行披露下界。E：金额未知为0模拟配置，仍标未知。明确大于某金额只用已知下界；小于/约数不作可用精确余额；状态1、状态待核或不开放均不配置。四组都不代表账户成交。

## 4. 筛选漏斗与集合差异

O全量审计的首个排除顺序冻结为风险→币种→公私募→名称资格→capacity→期限→开放→日开→证据档→参考值。首个排除统计：名称资格652、期限未知1,064、未开放1,914、日开18、收益证据不可评分56、可评分626，合计4,330；同只全部可观察原因保留在products.csv。O普通池准入700只，626只可评分，原生动态配置在不施加搜索额度前选11只。观察池每桶前3只不是实际金额候选上限。

V先按共同开放范围排除未开放3,346只；开放984只中近1M拒绝774、待核48，收益通过162。首个后续排除为售罄131、滚动待核1、超过190天2，余28只具正式资格，按组内名额正式入选16只，其余12只不占正式名额；回撤观察0。v9状态总计eligible28、watch0、pending47、rejected909，合计984。售罄/期限拒绝与待核可能交叉，状态计数和首因漏斗并非同一个分解，不相加。

按“可评分O候选 vs V正式”比较，共同14、仅O612、仅V2；仅V的MS040218、GD040241均为只有1M的新产品，保留入选，金额为0。按“原生O动态11只 vs V正式16只”比较，共同2、仅O9、仅V14，逐只如下。**O原生入选不代表通过统一额度执行层。**

${nativeTable}

原生O仅选9只中，5只搜索售罄，另4只近1M低于V门槛；这两类因素与排序、档位、名额共同影响最终结果。实际S金额共同配置120040A、17318K、NY040204三只，O独配8只，V独配4只，具体金额见第6节。

## 5. 四组汇总与期限缺口

${groupsTable}

参考年化仅评价已配置且可计算本金，前三组覆盖100%；对应可计算本金分别100,000、70,000、100,000元，已配收益字段缺口均0。V-E本金0，比例和均值不可计算。未分配金额没有填0收益，也未计算静态参考收益；四组均没有可据以声称未来达到3%的预测依据。

90天数值统一按金额×参考年化/100×90/365换算，未额外扣费或加入再投资、净值路径和复利。超过90天锁定的产品仍受原期限约束，不能解释为第90天可提现收入。

${bucketTable}

目标短30,000、中35,000、长35,000元。V-S短期流动性只到20,000元，低于组合30%要求；没有为了填满目标跨桶挪钱。V-S长期配置30,000元；超90天锁定40,000元还包含100天的132034A。

V-S缺口逐桶解释：短期10,000元，正式短期全为6M档，先配两只即用尽该档20%总额，ZX040225另受0.01元余额限制；中期15,000元，只剩132034A的仅3M档和HX040223的完整1Y档各配10,000元，其他正式中期为6M档或仅1M；长期5,000元，三只完整1Y各按原函数目标切片10,000元配置，余下6M档已无空间、仅1M不自动配。原函数不第二轮把剩余5,000元追加给已选产品，即使其30%单只上限还有空间。集中度代理上限没有成为这三处缺口的直接限制。

## 6. 逐产品金额与V候选未配原因

${allocationsTable}

完整中文名称、起购、递增、订单条款、状态时间、金额时间和四组未配原因在[配置明细](r2-quant-2026-11-07/allocations.csv)中。明细只使用销售代码归因，名称不作跨份额替代。

${vTable}

V的6M档20,000元在优先短期桶由120040A、120019K各10,000元用尽；因此即使HX040224、JY040247、JY040237、ZX040235的1M较高，仍不能再获6M档金额。120094A在V里同样被档位挤出，在O里因统一参考值较高先获得短期份额。这是排序、桶序、证据上限和候选结构的交互，不能单独归因于某一门槛。

## 7. 历史风险、集中度与近期收益

${riskSummary}

“近1M比3M高至少0.5pp”仅是本次统一的冲高诊断，未参与任一策略筛选；不是持续性判定。V正式候选中最高1M为HX040224的4.76%，其3M为3.51%、统一参考为2.9767%，受档位上限未获配置。O-S近1M低于V门槛的45,000元、O-E的90,000元，是两套策略目标不同的直接表现。

四组均通过已计算单只、证据档和代理策略键上限；所有实配历史最大回撤均低于1%，不代表未来损失上限。底层穿透尚未取得，不能声称真实底层策略50%约束已完成核验。分组净值回撤不加权为组合最大回撤。

${riskTable}

最近7点实际日期、每次挂零日、峰谷、修复日期及修复自然日、三个月端点和区间收益可在原始证据/明细按销售键复算。“走势待核”多来自公开估值规则不足以确认应有端点，不能当成走势稳定。表中“无回撤待修复”表示观察区间最大回撤为0，无修复任务。

${issuerTable}

发行方占本金比例用上述金额除以100,000元；占已配资金比例用对应组已配金额作分母。V-S招银理财40,000元，占本金40%、占已配57.14%；不触发发行方限额。

## 8. 额度、订单和候选数量敏感性

O-S→O-E：金额仍为100,000元，但统一参考年化从2.9913%降到1.8544%，下降1.1369个百分点，90天静态参考从737.57元降到457.25元。较高的S收益参考全部建立在额度金额假设上。V-S→V-E：70,000元全部失去公开明确金额支持，不能据此将其年化下降量写成2.7666个百分点。

相同S口径下，O比V多配置30,000元；已配部分参考年化高0.2247个百分点，90天静态参考多260.05元，但同时有45,000元低于V近1M门槛。相同E口径下，O多配置100,000元，V无可计算年化，不能计算收益率差。上述差值包含候选、排序、桶序、额度覆盖、起购、证据档位的交互，不是单一规则的因果效果。

O-E有20,000元落在超过190天的产品（PA040209为270天、667803A为370天），这部分期限能力是O本身允许的范围；V不会为填满金额突破190天门槛。S情景下两套已配产品的期限均未超过190天。

${sensitivityTable}

top2仅把V每组正式名额由3降到2，复用其他规则；S配置从70,000降到60,000元，参考值升到2.8057%，说明仅看已配部分年化会掩盖配置缺口。orderVerified只在公开概览或说明书已能保守解析递增和静态单笔上限/明确不设上限的候选中配置，不把未知上限默认为已核验。V-S缩至40,000元、参考值反而为3.0290%，但只覆盖本金40%，仍不满足30%的短期流动性要求。它是订单证据完整度敏感性，不是新的收益策略。

39份相关说明书全部下载并抽取成功，补查同时覆盖两套策略的原生入选和实际金额候选。新增确认11只O候选、5只V候选的静态申购数值上限（有交集），主表金额不变。例如120040A的A份额静态单笔申购上限5,000万元，120019K的K份额为1亿元，17318K的K份额为1亿元；均另有“与份额规模上限取较小值”等动态条件。动态规模、销售机构调整与账户限额仍未知，不能把静态上限当作实际可成交额度。缺少上限正文的其他说明书继续标待核，不以“正文未写”推断无限额。

下载时间、披露日期、PDF页码、原文、URL与哈希保存在supplement-index.json、supplement.json.gz；订单字段引用保存在products.csv的pdf_order_evidence。补核只增强共同证据，不用补核时点新额度回填主采集的额度。

## 9. 验收、局限与复算入口

已通过：两套读取同一主池、完整分页和身份键检查；原策略626只候选的关键公开证据补采；每组金额按分对账且配置+未分配=100,000元；可计算收益的缺失/0值区分；状态、金额、精确值、未知和假设分离；单只30%、6M/仅3M各10%/20%、期限桶预算上限、不重复用额度及已知起购/递增/订单上限检查；同登记产品份额合计50%检查；O原生金额适配一致性。冻结数据重复离线计算5份结果文件的SHA-256完全相同。Skill测试27项通过，JS/Python收益黄金用例33项通过，39份PDF原始字节哈希复核通过。

未完全满足：实配订单单笔上限等缺字段、底层策略代理不等于穿透识别、全池并未获取所有产品说明书登记编码、实际账户适当性与实时额度未知。因此本次不能列为所有共同执行约束已核验，也不据此推荐实际买入O-S或宣称O长期胜出。净值分红未复权、历史长度不同、公开状态采集并非同一秒、未披露字段无法补成0，均保留影响说明。

首次准备性采集在未开放状态参数及103页超过原100页保护上限处停止，未被合入主结果；最终轮次扩到200页并逐页校验，公开货架扩到300页保护上限、实际50页终止。失败准备轮摘要单独保留，未刷新生产研究池。

必要证据、冻结源码、参数和脚本均留在[r2-quant-2026-11-07](r2-quant-2026-11-07/)目录：

| 文件 | 内容 |
| --- | --- |
| [results.json](r2-quant-2026-11-07/results.json) | 四组与敏感性金额、桶缺口、逐次约束输入、未配置原因、参数和规则哈希 |
| [products.csv](r2-quant-2026-11-07/products.csv) | 4,330个份额全量O/V判定、全部已观察原因、收益、时间戳、风险及金额 |
| [allocations.csv](r2-quant-2026-11-07/allocations.csv) | 26个实际获金额份额的配置差异与风险 |
| [rule-differences.csv](r2-quant-2026-11-07/rule-differences.csv) | 原生O11只与V16只之并集25只，逐只规则差异 |
| [quality.json](r2-quant-2026-11-07/quality.json) | 覆盖、首因漏斗、期限冲突、日期分布、补采失败项 |
| pool.json.gz / evidence.json.gz | 全量原始返回；696份额度、详情与完整净值，以及冻结源码 |
| collect.cjs / compute.cjs / verify.cjs | 公开采集、冻结数据离线复算及独立验收；collect会形成新采集轮次 |
| supplement.cjs / extract.py / supplement*.json* / prospectuses.zip | 39份说明书PDF、补查时间、URL、摘要、哈希与文本证据 |
| manifest.json | 本次保留文件的SHA-256与大小 |

离线重算：在工作区执行node docs/analysis/r2-quant-2026-11-07/compute.cjs，再运行write-report.cjs与verify.cjs；不会连接银行或写SQLite。所有评分与参考收益均从evidence内冻结源码加载。更换采集轮次必须两套一起重算。现阶段未做真实持仓换仓、后续收益回测、组合净值路径或实际成交测试。

R2非保本，历史年化与90天静态换算均不是承诺或未来收益预测。
`;
fs.writeFileSync(path.join(__dirname,'../r2-strategy-quant-comparison-result-2026-11-07.md'),report,'utf8');
console.log('report written');
