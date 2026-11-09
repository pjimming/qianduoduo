# R2 v9 执行层契约与迁移说明

> 2026-11-08 独立验收修订：HTTP/worker/当前 v9 推荐已接入，实际四项 R2 自动化已同步，持仓补采使用受控私有缓存；当前以[验收记录](r2-strategy-acceptance-2026-11-08.md)和实际状态为准。

2026-11-08。关联 [整合计划](r2-strategy-integration-plan.md)。这是冻结契约和可审查迁移方案；阶段 0–5 的本地实现与验收已完成，生产增量迁移与 v9 切换已完成（2026-11-08 01:40，`activation_seq=1`），消息中心投影已核验；保留切换后事实的副本回滚演练已完成（01:48，v9/1→legacy/2→v9/3），真实影子对照与生产回滚尚未执行。

## 规则与版本

机器契约以 `server/modules/r2-strategy/contract.js` 为源，使用稳定键序列化和 SHA256。执行版本 `r2-screening-v9-execution-v1` 分别引用选品 `v9`、配置 `r2-v9-bucket-allocation-v1`、收益 `r2-term-yield-v1`、持仓 `r2-v9-holding-review-v1`、评价 `r2-v9-eval-v1`。本次没有改变原收益权重或收益舍入公式。

| 边界 | 冻结决定及依据 |
| --- | --- |
| 准入与时效 | 复用初筛 policy 的精确小数和 `fresh()`：1M≥2.15%，数据年龄0–6天，达到7天待核。净值按自己的实际数据日另验 |
| 续持强制规则 | 仅有效、同份额1M低于2.15%构成收益门槛退出依据。锁定中保留观察动作和到期退出意图；缺证待核 |
| 其他退出边界 | 回撤、资产、期限触发风险复核；公开售罄、未入前三不构成强制退出。不得推导提前赎回权 |
| 组合约束 | 短/中/长30/35/35、日开新增0、单只≤30%、6M与3M分别10/20；7–30天流动性子集≥30%，用款约束另验 |
| 策略族 | Skill明确50%上限。旧 `products.js` 的“仅一个策略族时100%”例外仅留历史算法，不进入新契约。缺乏可核验的策略族映射时不认定已穿透、不自动放行 |
| 发行方 | 只展示，不设集中度上限 |
| 组内与组间 | 原分类＋实际期限内按v9排序，前三以外保留原排名作为替补。组间先等预算首轮，按期限升序、分类代码升序轮转补足；不建立跨组1M总排名 |
| 额度 | 状态0才允许新买；金额空白按用户“大于5000万可买”假设，明确非银行披露。显式金额不享优先级 |
| 满仓 | 以分为单位闭合；任一约束冲突返回无可行方案和未配金额，不跨桶偷偷填满 |

产品正式条款依据文件版本及变更公告；报告保留报告期和是否最新；App额度在执行时点核验。不能把这些字段全部套用7日有效期。

## 读边界与证据载荷

初筛 repository 的 `readExecutionSnapshot()` 在一个 SQLite **只读事务**内冻结 current、批次、全部份额摘要、来源证据与净值内容哈希，不传入账户事实，不输出全量净值。上限20000份额，超限整体返回不可用而非截取一部分冒充全池。

`evidence.js` 是纯适配器，输入该快照、北京时间业务日、账本侧显式映射；不打开库、不联网、不持久化。未知/歧义映射不按名称或相同代码跨渠道替换。`degraded` 按全池完整性及逐份额证据分别处理。每份额保留原始rank、shortlisted、提示、收益原文、数据日、净值摘要/哈希、来源摘要、映射版本、quota假设及参考年化计算结果。快照深冻结；指纹包括批次创建时间、数据内容和证据，不能只用run_id当事件键。

`automatic_eligible` 在本层仅代表**可进入自动配置计算**，不代表可执行或已有建议金额。HTTP/API、CLI 与独立 worker 已接入统一用例，生产当前为 v9/1。决策快照在现有payload/review_meta中扩展，载荷版本1，单对象≤65536字节，历史缺项标“历史未冻结”。本层不把1M替换为未来收益预测，也不向账本写入公开净值。

## 实际 schema 对照与新增对象

现有 `decision_proposals` 有唯一dedupe和状态，但没有逐交易腿预留金额；`automation_jobs` 有dedupe和尝试次数，但没有租约token/截止、策略序号的条件提交；`holding_review_settings` 只按产品码保存可修改设置，无法作为同份额版本证据；`decision_log.review_meta` 和提案payload可以保留冻结摘要，但不能替代数据库资金唯一约束。

该层最初增量新增 7 张账本侧表；交易前复核与产品映射移除后现存 5 张：`r2_strategy_state`、`r2_strategy_transitions`、`r2_fund_reservations`、`r2_derivation_jobs`、`r2_derivation_watermarks`，DDL 唯一来源为 `server/modules/r2-strategy/schema.sql`。不修改初筛库schema，不改旧表列、索引、约束或历史事实。初筛身份仍由其现有(source,channel,code)主键定义。

| 对象 | 字段与约束 | 生命周期 |
| --- | --- | --- |
| r2_strategy_state | singleton=1；schema_version=1；账本UUID；activation_seq；mode；contract_hash；updated_at | 初始legacy/0，不自动启用v9；状态缺失按未迁移处理 |
| r2_strategy_transitions | operation_key主键；activation_seq唯一；from/to；hash；summary_json；时间 | 每次切换追加，和激活及旧pending处理同事务 |
| r2_fund_reservations | proposal/decision外键；leg_key；activation_seq；amount/executed/released整分；state | proposal+leg与decision+leg分别唯一；已执行＋释放≤总额；非active必须闭合 |
| r2_derivation_jobs | event_type+activation_seq+input_hash唯一；input_json；attempts≤3；租约token/截止；retry_at；result/error | pending→running→done；失败→pending退避/failed；过期输入→superseded；running必须有唯一租约 |
| r2_derivation_watermarks | event_type主键；activation_seq；input_hash；job外键；completed_at | 只在派生结果提交事务内推进；启动扫描补建丢失通知 |

JSON载荷和hash使用字段类型/check约束；高频任务调度和active预留有索引。新表不是新账本事实源。首版不自动清理被引用证据。

## 用例与并发协议（后续实现验收要求）

1. HTTP、worker、CLI都在账本事务外读取一份冻结公开上下文。对初筛缺失或不可信的新推荐失败关闭，事实录入和历史读取继续独立。
2. 明确写用例以BEGIN IMMEDIATE取得账本写锁，重读activation_seq及账户输入指纹；不一致返回409待重算。事务内禁止联网和长净值计算。
3. 提案生成不预留；采纳同事务校验组合资金与敞口、创建决策/预测、创建唯一预留并转提案状态。相同操作重试返回已提交对象；不同并发采纳不能重复用款。
4. 预留余额=总额−已执行−已释放。确认交易将匹配的部分转为实际承诺/持仓占用；同一腿的pending不能再计一次。合法取消/失效只释放余额；已发生超额交易如实入账并记录偏差。
5. worker领取事务使用唯一token和有界租约；完成事务重验token、策略序号、输入指纹。结果、done与水位同事务；崩溃不推进水位，过期可恢复，最多3次，有退避，不重放旧批次制造提案。
6. 切换暂停派生和采纳，等待/停止worker；一次事务递增序号、处理旧pending和记审计。已采纳、部分/全部执行记录不改策略或原预测；未执行部分要求重核。迟到worker不得提交旧序号。
7. 评价选择决策冻结版本而非当前全局设置。历史缺失不补造；当前持仓监控独立使用当前契约。已确认评价/月季复盘保留。

这些协议必须以实际服务、事务与竞争测试兑现；建表与基础测试**不代表**已通过整合计划13.6的并发演练。

## 调度契约

不调整现有时间、频率、模型或托管方式。初筛工作日12:00发布后提示派生，启动/周期扫描按指纹补偿。评估worker显式传库路径、策略序号和摘要；不隐式导入CSV或迁移。周一08:45观察核对08:30快照实际成功与数据日，不能只比较时间；不把每日初筛算成周观察样本。r2-2/r2-3按持仓当前可处理状态读摘要，继续遵守节假日静默和消息去重。实际 r2/r2-2/r2-3/r2-4 已通过应用自动化工具同步，保留原日程、模型和通知偏好。

## 迁移、兼容与回滚

工作区AGENTS.md第4节和本计划12.1/13.1要求明确授权后才能变更生产schema。用户已明确回复“授权该增量迁移，继续完成整合”；授权针对所附DDL及增量备份迁移方案，迁移后仍为legacy。生产已按方案停服、分别备份、事务apply并经现有计划任务启动，该次迁移后为 legacy/序号0，随后于 2026-11-08 01:40 显式切换为 v9/序号1。脚本不挂入 `openDatabase()`、HTTP GET、生命周期或worker。

只读预检：`node scripts/migrate-r2-strategy.mjs preflight`。指定 `--db` 和 `--screening-db` 可检查临时库。apply必须另给受控 `--backup-dir`，且在停止账本写入及初筛采集的维护窗口运行。

1. 校验账本关键表、两库路径隔离、初筛application_id/schema及两库integrity/foreign keys。
2. 用SQLite `VACUUM INTO` 分别创建WAL一致备份，不复制活动主文件；受控manifest记录逻辑检查点、两文件SHA256、旧表逐表签名、旧schema签名和契约hash。manifest不进入Git/Pages。
3. BEGIN IMMEDIATE后核对账本仍与备份一致。并发业务已变则终止重试；不以旧备份覆盖新事实。
4. 同事务新增表和legacy/0状态，比较所有既有表及schema签名。失败直接ROLLBACK（含DDL），保留备份。重复apply为无变化；局部schema或DDL漂移拒绝继续。
5. 临时环境验证兼容后才允许生产迁移。迁移本身不启用v9、不失效旧提案、不改交易/决策/收益事实；切换由后续独立用例执行。

空迁移可执行 `rollback-empty --db <受控路径>`，仅在legacy/0且其余新表全空时删除新对象，旧事实签名必须一致。一旦已有策略记录或业务数据，禁止删表或恢复旧整库覆盖新账；保留增量表，停用推荐，回退已验证可读新JSON的兼容应用。只有无新事实的受控恢复演练才使用备份还原，分别恢复两库并核对引用/指纹。

## 当前验收与剩余范围

已实现：机器契约、显式迁移/预检/空回滚工具、只读已发布快照、纯证据适配器、整数分约束配置、持仓收益退出状态机、资金预留和可恢复任务repository；分版本冻结评估、买入/退出/替换提案、启动/周期调度、三分区前端与 v9 持仓待办投影。基础、配置、持仓、评估和repository均有离线/临时库定向测试。

配置引入精确锁定的 `javascript-lp-solver@1.0.3`（[官方仓库](https://github.com/JWally/jsLPSolver)）。金额由起购二元变量与整分递增变量组成；先最大化已配金额，再最小化各组偏离等预算，最后按组间冻结顺序逐个最大化原v9排名。每轮结果独立以整数复核全部硬约束；证据档位、登记产品聚合、策略族、短桶预算、流动性子集及具体用款日期不可放宽。截止或偏好解未完成时保持pending，不能凭一个可行但未核验排名的解声称完成。即使试算通过，也只代表公开数据可行，仍须经采纳用例；提案不会因试算完成而自动执行。

`pretrade.js` 与 `r2_share_mappings`、`r2_pretrade_checks` 两张表已于 2026-11-08 按用户决策整体移除，应用内不再有逐项核实表单；交易前核对改为人工一次性尽调，结论写入决策记录。到账事实改由交易表承载：已确认赎回交易的实际到账日写入 `trade_transactions.arrival_date`，核验时间写入 `arrival_verified_at`，经 `PUT /api/trades/:id` 提交。`holdings.js` 使用lot级 `kind=holding_redemption` 事实：需要明确核验的最早赎回日；当日可赎还必须有同日App/窗口确认。到期、公开买入开放日不能替代赎回核验。

当前已接通共享engine、账户占用适配、HTTP状态/工作区/预览/重算/提案、CLI、独立worker和启动/周期调度；无初始化适配器使这些入口不隐式迁移、导入CSV或刷新历史审计时间。本地已完成买入、`holding_exit`、`holding_switch`提案生成与采纳重核、同计划逐只采纳、未执行取消、交易/预留原子接续、分版本冻结评估及前端“选品与配置”“决策与评估”三分区。生产已于2026-11-08 01:40发布最新代码并激活v9/1，首个派生job#1完成、watermark seq=1；切换后修复启动投影顺序，消息中心已投影11条evidence_pending。事实修正追加历史版本已完成并随 2026-11-08 02:02 生产重启发布；真实切换前影子对照因直接授权切换未执行；部分执行余额取消已实现、完成本地全量验收并随 2026-11-08 01:55 生产重启发布；保留切换后事实的副本回滚演练已完成，生产回滚未执行。新执行版本被阻止进入旧全局hurdle/年化评估器，不以旧结果代评；legacy模式只读预览仍返回待核，供回滚兼容。

生产迁移验收：两份备份SHA256重新核验通过，旧schema和八类核心事实的逐表签名与备份一致，新状态legacy/0；现有托管启动来源为task-scheduler，Health、新策略API和初筛API为200，收益口径899/899，stderr为空且无停止标记。具体备份路径、账户金额和签名仅留在受控备份manifest中。

2026-11-08 01:40 生产切换：用户明确确认后，先 `prod:stop` 并确认端口关闭，再以操作键 `prod-v9-activation-20261108T0140+08`、`expected_seq=0` 将账本切到 `mode=v9`、`activation_seq=1`，随后 `prod:start` 由既有计划任务重新托管。切换前备份 `data/backups/r2_ledger-2026-11-08.sqlite`；切换 CLI 先在同一备份副本完成 legacy/0→v9/1→legacy/2 演练。切换后 Health 200，派生 job#1 `done`，watermark seq=1；因启动投影早于首个派生完成，消息中心一度为0条，修复启动装配顺序并在派生完成后投影后重启，`/api/inbox` 现含11条`evidence_pending`。回滚路径为停服后按 `expected_seq=1` 切回legacy，或恢复切换前备份；保留切换后事实的副本回滚演练已于01:48完成，生产回滚未执行。

2026-11-08 02:02 事实修正追加版本：maturity 评价按冻结证据的 `{available,reason,actual,valuation_ids,snapshot_hash}` 计算 revision，并追加到评价去重键；旧行 revision 不同则插入新版本，不覆盖已 auto/confirmed 的历史评价，buy_day 不追加 revision。全量 577/577、0 todo，check/build/E2E 通过；`prod:restart` 后 Supervisor PID 24384、Server PID 576，策略仍 v9/1，job#1 done，`/api/inbox` 17 条（策略 11 条）。

2026-11-07测试过程曾因openDatabase参数类型误用打开默认账本初始化器，现已修正为显式临时路径。随后只读对照当日既有备份：schema、账户总账、产品收益、交易/分摊、本金设置/事件、持仓和决策事实逐表一致，integrity_check=ok，新增策略表为0。旧初始化器更新了持仓迁移记录的completed_at；未恢复或改写该审计时间。常驻自动化的运行记录、评价和inbox更新时间亦与晨间备份不同，不据此认定为财务变化。后续测试必须显式限定临时根目录。
