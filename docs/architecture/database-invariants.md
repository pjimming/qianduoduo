# 数据库、事务与财务不变量

> 2026-10-23：财富事实的权威载体、唯一写入用例、证据链接、修订和截图状态机设计见
> `docs/architecture/data-trust/lineage-design.md`。该文件是 `TD-DATA-001` Step 1 的设计基线；
> schema、迁移、兼容和回滚方案见 `docs/architecture/data-trust/schema-migration-plan.md`。
> 本文继续作为当前实现的数据库和事务不变量快照。

## 1. 数据库基线

**路径**：默认 `data/r2_ledger.sqlite`，可由 `R2_DB_PATH` 覆盖。  
**引擎**：Node.js 24 内置 `node:sqlite` / `DatabaseSync`。  
**连接设置**：

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

2026-10-22 重构审计时以 `readOnly:true` 打开真实库，只执行元数据和完整性检查：

- `PRAGMA quick_check`：`ok`
- `PRAGMA foreign_key_check`：空
- `PRAGMA user_version`：`0`
- 28 张业务表
- 0 个触发器
- 0 个 `FOREIGN KEY` 定义

2026-10-23 数据可信度 v1 生产迁移后，当前基线为：

- 33 张业务表
- 0 个触发器
- 9 个外键定义，集中在证据、事件、修订和链接表
- `PRAGMA quick_check = ok`
- `PRAGMA foreign_key_check` 为空

旧业务表仍主要依赖应用层不变量；新增证据链表使用外键保护引用完整性。

## 2. 表清单与所有权

| 表 | 当前主要写入者 | 语义 | 关键唯一/检查 |
| --- | --- | --- | --- |
| `daily_records` | `db.js`、收益截图工作流 | 账户每日总收益与本金快照 | `record_date UNIQUE`；principal > 0 |
| `capital_settings` | `db.js` | 单例本金起点 | `id=1`；initial_principal > 0 |
| `capital_events` | `db.js` | 转入/转出 | type/deposit/withdraw；amount > 0 |
| `products` | `db.js` | 产品 CSV 快照 | `code UNIQUE` |
| `app_meta` | `trade-store`、`db.js`、`automation-store` | 一次性迁移标记、产品指纹、分配 JSON | `key PRIMARY KEY` |
| `trade_transactions` | `trade-store` | 交易事实来源 | `dedupe_key UNIQUE`；类型/状态/金额检查 |
| `trade_allocations` | `trade-store` | 赎回匹配派生批次 | 无非空业务唯一键、无外键 |
| `trade_inbox` | `trade-store` | 成交截图与 OCR/人工校正 | `sha256 UNIQUE`；状态检查 |
| `trade_audit` | `trade-store` | 交易变更审计 | 无业务唯一键 |
| `holdings` | `review-store` | 旧持仓表，兼容/迁移遗留 | 无正式唯一键 |
| `holding_review_settings` | `review-store` | 每产品赎回/到账/费率/开放日 | `product_code PRIMARY KEY` |
| `decision_log` | `review-store` | 决策历史和评估结果 | action/rating 检查；无 dedupe |
| `decision_proposals` | `decision-proposal-store` | 规则产生的建议及执行状态 | `dedupe_key UNIQUE`；状态/动作检查 |
| `product_events` | `review-store` | 产品事件 | type/impact/status 检查 |
| `review_notes` | `review-store` | 月度五问/结论 | `month PRIMARY KEY` |
| `quarterly_notes` | `review-store` | 季度复盘 | `quarter PRIMARY KEY` |
| `income_inbox` | `income-store` | 收益截图、OCR 与入账状态 | `sha256 UNIQUE`；状态检查 |
| `product_daily_valuations` | `product-valuation-store` | 逐产品每日收益 | `(product_code,yield_date) UNIQUE` |
| `product_daily_valuation_audit` | `product-valuation-store` | 产品收益增改审计 | 无业务唯一键 |
| `product_yield_settings` | `product-valuation-store` | 产品收益延迟/来源/核验 | `product_code PRIMARY KEY` |
| `product_yield_setting_audit` | `product-valuation-store` | 收益延迟修正审计 | 无业务唯一键 |
| `evaluation_settings` | `automation-store` | 自动评估键值设置 | `key PRIMARY KEY` |
| `evaluation_runs` | `automation-store` | 评估历史与写入状态 | `dedupe_key UNIQUE`；scope/stage/outcome/status 检查 |
| `review_drafts` | `automation-store` | 月/季复盘草稿 | `(period_type,period) UNIQUE`；状态检查 |
| `notifications` | `automation-store` | 内部提醒 | `dedupe_key UNIQUE`；level 检查 |
| `automation_jobs` | `automation-store` | 待人工判断任务 | `dedupe_key UNIQUE`；状态检查 |
| `automation_runs` | `automation-store` | 每次自动周期执行结果 | 无唯一键 |
| `inbox_items` | `inbox-center` | 面向用户的消息中心 | `dedupe_key UNIQUE`；category/severity/status 检查 |
| `schema_migrations` | `data-trust-migration` | 显式迁移生命周期 | `id PRIMARY KEY`；status 检查 |
| `evidence_assets` | `data-trust-store` / migration | 不可变原始证据身份 | `(evidence_type,sha256) UNIQUE` |
| `evidence_events` | `data-trust-store` / migration | OCR、解析、人工校正和状态事件 | 非空 `(evidence_id,dedupe_key)` 唯一 |
| `fact_revisions` | 各域事务 / migration | 跨域事实修订历史 | `(fact_type,fact_key,revision_no)` 唯一 |
| `fact_evidence_links` | 各域事务 / migration | 事实与具体解释版本的双向链接 | 修订、证据、事件和角色组合唯一 |

## 3. 初始化与迁移顺序

`openDatabase()` 当前顺序：

1. `mkdir` 数据库目录。
2. 打开 `DatabaseSync`，设置 WAL、外键开关和 busy timeout。
3. 创建 `daily_records`、`capital_settings`、`capital_events`、`products` 基础 schema。
4. `createReviewStore()`：
   - 创建/确保 review 表。
   - `migrateDecisionColumns()`。
   - `migrateHoldingReviewColumns()`，其中会重建 `holding_review_settings`。
5. `createTradeStore()`：
   - 创建交易、批次、收件箱、审计及 `app_meta`。
6. `createProductValuationStore()`：
   - 创建产品收益/延迟/审计表。
   - 若缺 `credit_date`，`ALTER TABLE`，再回填。
7. `createDecisionProposalStore()`：创建提案表。
8. `createIncomeStore()`：创建收益截图表。
9. `tradeStore.migrateLegacyHoldings()`：旧 `holdings` 迁移为 pending 买入，写 `trade_migration_v1`。
10. `createAutomationStore()`：
    - 创建评估/草稿/通知/任务/运行表。
    - 若缺 `source`，`ALTER TABLE evaluation_runs`。
11. `migrateRemoveCashBalanceColumn()`：如有旧 `cash_balance`，重建 `daily_records`。
12. `ensureDailyRecordColumns()`：补 `source`、`screenshot_id`。
13. `migrateLegacyCapital()`：根据历史 `principal` 首值和差额生成初始本金/资金事件。
14. `ensureProductColumns()`：补产品扩展列。
15. `seedProducts()`：按产品文件指纹导入/替换产品快照。
16. `createInboxCenter()`：创建消息中心表。
17. `ensureDataTrustReady()`：生产要求迁移已完成；测试/临时库可自动执行 v1；随后创建数据可信度 store 并连接到交易、产品收益和决策 store。

### 3.1 迁移机制特征

- 没有中央 migration 表。
- `PRAGMA user_version` 为 0。
- 使用两类机制：
  1. `CREATE TABLE IF NOT EXISTS`、`PRAGMA table_info`、`ALTER TABLE`。
  2. `app_meta` 一次性键，如 `trade_migration_v1`、`automation_strategy_seed_v1`、`daily_open_zero_policy_v1`、`automation_decision_link_v1`。
- 部分迁移失败会抛出，阻止 `openDatabase()` 返回。
- `migrateHoldingReviewColumns()`、`migrateRemoveCashBalanceColumn()` 在 `BEGIN IMMEDIATE` 中重建表并保留字段。
- 自动化启动时会做一次策略补种和旧决策关联，写 `app_meta`。

### 3.2 迁移风险

1. 顺序隐含在函数调用中，没有一个可枚举的版本清单。
2. 不同模块建表/迁移分散在各自 store 工厂，单测很难独立验证完整旧库矩阵。
3. `ensureProductColumns()` 和 `productValuation` 的 `credit_date` 迁移只检查列名，不记录版本。
4. 迁移中断后依赖幂等 DDL/一次性键恢复；没有统一“开始/完成”状态。
5. 没有旧库 fixture 集合覆盖真实历史版本组合。

## 4. 现有业务不变量

### 4.1 账户收益

**I-LEDGER-01**：每个 `record_date` 最多一条 `daily_records`。  
状态：数据库唯一约束 + 应用显式幂等检查。  
证据：`daily_records.record_date UNIQUE`；`db.createRecord()`；`POST /api/records`。

**I-LEDGER-02**：同日同金额重复请求不重复入账。  
状态：应用检查已覆盖。  
证据：服务端 `Math.abs(existing - incoming) <= 0.005` 返回 `duplicate:true`。

**I-LEDGER-03**：同日不同金额不得自动覆盖。  
状态：应用检查已覆盖。  
证据：返回原记录、conflict、创建 notification。

**I-LEDGER-04**：账户总收益不等于产品收益之和时只对账告警。  
状态：应用查询层执行。  
证据：`getReconciliationForDate()` 只读比较，不覆盖 `daily_records`。

### 4.2 本金

**I-CAP-01**：`capital_settings` 单例。  
状态：`id INTEGER PRIMARY KEY CHECK (id=1)`。

**I-CAP-02**：某日快照本金 = 初始本金 + 截至该日 deposits − withdrawals。  
状态：`principalAt()` + 历史重算实现。

**I-CAP-03**：修改起始本金或资金事件后，所有已有收益记录的本金快照重算。  
状态：`initializeCapital()`、`updateCapitalInitial()`、`createCapitalEvent()`、`deleteCapitalEvent()` 均在 `BEGIN IMMEDIATE` 内执行。

**I-CAP-04**：收益记录不能早于本金起始日，不能对应非正本金。  
状态：应用检查。  
风险：`getCapitalState()` 的默认日期用 UTC，而 HTTP 主路径用上海日期；跨午夜边界可能不一致。

### 4.3 交易

**I-TRD-01**：交易去重键 = `trade_date|trade_type|UPPER(product_code)|rounded amount|status`。  
状态：内存预查 + `dedupe_key UNIQUE`。

**I-TRD-02**：同字段已确认交易不得重复确认。  
状态：查询 `trade_date + trade_type + product_code + amount` 且排除自身。  
缺口：重复确认已确认的同一交易不会再次形成持仓差异，但仍会重写 `updated_at` 并追加一条 `confirm` 审计；不是财务重复，却是审计噪声。

**I-TRD-03**：pending 交易不形成正式持仓。  
状态：`rebuildAllocations()` 只处理 `confirmed`。

**I-TRD-04**：持仓起点优先 `confirm_date`，否则 `trade_date`。  
状态：`holdingStartDate()` / `mapTradeToHolding()`。

**I-TRD-05**：买入批次按产品先进先出匹配赎回。  
状态：`rebuildAllocations()` 遍历已确认交易并按持有起点/交易日/id 排序后 `allocate()`。

**I-TRD-06**：赎回超过可用批次时整个交易操作失败。  
状态：`ALLOCATION_SHORTFALL` 抛出；创建/修改/确认交易的外层事务回滚。

**I-TRD-07**：切换同时消耗来源产品批次并建立目标产品批次。  
状态：`rebuildAllocations()` 中 switch 分支。

**I-TRD-08**：交易修改、确认、撤销都应有审计。  
状态：交易事务内写 `trade_audit`。

**I-TRD-09**：持仓只是交易派生物，不应有第二套正式写入口。  
状态：兼容 API 通过交易服务实现；旧 `holdings` 表仍保留。  
风险：`review-store` 仍包含直接操作 `holdings` 的方法；当前 `db.js` 返回门面覆盖了常用的 create/update/delete/get，但后续迁移必须明确谁拥有旧表，避免绕过交易服务。

### 4.4 交易截图和 OCR

**I-OCR-01**：同一图片二进制只能进入收件箱一次。  
状态：`trade_inbox.sha256 UNIQUE`。  
缺口：文件写和数据库插槽分开，去重预查在异步 OCR 前，存在并发窗口。

**I-OCR-02**：OCR 失败不能创建正式交易。  
状态：上传只创建 `pending` 收件箱；apply 需要人工字段。

**I-OCR-03**：人工修正必须覆盖/合并原始 parsed 数据并保留 OCR 原文。  
状态：`ocr_text` 保留，`parsed_json` 合并修正。

**I-OCR-04**：视觉识别金额/产品代码与 OCR 不一致时必须 409 要求人工确认。  
状态：`vision-apply` 显式检查和 `confirm_mismatch`。

**I-OCR-05**：同一收件箱重复 apply 不应重复产生交易。  
状态：已 applied 且有 trade_id 时返回 `duplicate:true`。  
缺口：首次 create 与 updateInbox 不在同一事务；重试通常可收敛，但需要故障注入证明所有中断点。

### 4.5 收益截图

**I-INC-01**：同一收益截图只能入库一次。  
状态：`income_inbox.sha256 UNIQUE`。  
并发窗口与成交截图相同。

**I-INC-02**：产品收益按 `(product_code,yield_date)` 唯一。  
状态：数据库唯一约束。

**I-INC-03**：同产品同日已有不同值时不覆盖，生成人工确认。  
状态：`upsertValuation()` 返回 conflict；服务端创建 notification。

**I-INC-04**：0 元是有效值。  
状态：排序和保存逻辑均允许 0；有回归测试。

**I-INC-05**：收益日期由用户/截图明确提供；lag 只用于缺项披露判断。  
状态：`credit_date`、`yield_date`、`valuation_date` 分开保存；收益延迟规则在 `product_yield_settings`。

**I-INC-06**：收益截图 apply 应原子地完成产品收益、账户收益和收件箱状态。  
状态：**已满足**。共享 `BEGIN IMMEDIATE` 事务同时写产品收益、账户收益、事实修订、证据链接和收件箱状态；故障注入覆盖产品、账户和收件箱三处失败。

### 4.6 决策、提案和评估

**I-DEC-01**：决策初始证据不完整时应标记为 incomplete。  
状态：`review-store.withDecisionCompleteness()`。

**I-DEC-02**：已关联未撤销交易的决策不能直接删除。  
状态：HTTP 路由先检查；数据库没有外键。

**I-PROP-01**：提案去重键唯一。  
状态：`decision_proposals.dedupe_key UNIQUE`。

**I-PROP-02**：同一 proposal 采纳只能生成一次决策。  
状态：状态必须是 `pending`；采纳后写 `accepted + decision_id`。  
缺口：创建决策和写 proposal 状态不在同一事务；中断后可能产生“决策已建、提案仍 pending”的孤立状态。

**I-EVAL-01**：同一评估键唯一。  
状态：`evaluation_runs.dedupe_key UNIQUE`，键含规则版本。

**I-EVAL-02**：人工修改后的决策不能被自动评估覆盖。  
状态：`applyDecisionRun()` 比较 applied_at 与 decision.updated_at。

**I-EVAL-03**：撤销只能针对 `auto/confirmed` 且决策未手工改变。  
状态：应用检查。

**I-EVAL-04**：评估写入/撤销与决策更新必须原子。  
状态：**未满足**；决策和 run 是两次独立写。

### 4.8 数据可信度与证据链

**I-DATA-01**：每个新截图收件箱记录必须关联唯一 `evidence_id` 和采用的具体 `evidence_events` 版本。
状态：数据库局部唯一索引、外键和应用注册事务共同保证。

**I-DATA-02**：原始图片、机器解析和人工校正只追加，不覆盖旧事件。
状态：`evidence_events` 追加式写入；`parsed_json` 仅保留当前兼容投影。

**I-DATA-03**：事实修订永久保留前后值、原因、来源、操作者和幂等操作 ID。
状态：`fact_revisions` 唯一约束 + 域事务同步写入。

**I-DATA-04**：一项事实可关联多个证据，一项证据可关联多个事实；链接指到具体解释事件。
状态：`fact_evidence_links` 多对多结构与外键校验。

**I-DATA-05**：已被正式事实引用的截图不得进入普通自动清理。
状态：交易和收益剪枝均检查活动 `fact_evidence_links`。

**I-DATA-06**：不能追溯时接口必须返回 `incomplete` 或 `partial`，不得推断成完整证据。
状态：事实追溯 API 和页面共同显示。

### 4.7 自动任务

**I-JOB-01**：任务去重键唯一。  
状态：`automation_jobs.dedupe_key UNIQUE`。

**I-JOB-02**：通知去重键唯一。  
状态：`notifications.dedupe_key UNIQUE`。

**I-JOB-03**：同一 automation run 不应在单进程内并发执行。  
状态：`automation-store.js` 闭包中的 `running` 布尔。

**I-JOB-04**：进程中断后，运行状态应可诊断/恢复。  
状态：**部分满足**。`automation_runs` 有 running/done/failed，但没有启动时清理/重试和持久化租约。

## 5. 事务边界清单

### 5.1 已有事务

| 用例 | 位置 | 事务范围 |
| --- | --- | --- |
| 删除旧 cash 列并重建 daily_records | `db.js:migrateRemoveCashBalanceColumn` | DDL + 数据复制 + 索引 |
| 旧本金迁移 | `db.js:migrateLegacyCapital` | capital settings + events |
| 产品种子/刷新 | `db.js:seedProducts/replaceProducts` | DELETE products + INSERT + 指纹 |
| 初始化本金 | `db.js:initializeCapital` | settings + 重算 daily principal |
| 修改初始本金 | `db.js:updateCapitalInitial` | settings + 重算 |
| 创建资金事件 | `db.js:createCapitalEvent` | event + 重算 |
| 删除资金事件 | `db.js:deleteCapitalEvent` | delete + 重算 |
| 持仓复核设置迁移 | `review-store.js:migrateHoldingReviewColumns` | 重建表 |
| 创建交易 | `trade-store.js:createTrade` | trade + allocations + audit |
| 修改交易 | `trade-store.js:updateTrade` | trade + allocations + audit |
| 确认交易 | `trade-store.js:confirmTrade` | trade + allocations + audit |
| 撤销交易 | `trade-store.js:cancelTrade` | trade + allocations + audit |
| 收益延迟设置 | `product-valuation-store.js:saveYieldSetting` | upsert + audit |
| 批量产品收益 | `product-valuation-store.js:upsertMany` | 多条 valuation + audit |
| 收益截图入账 | `db.js:applyIncomeScreenshot` | 产品收益 + 账户收益 + 修订 + 证据链接 + 收件箱状态 |
| 交易截图入账 | `trade-store.js:applyInbox` + trades repository | 交易/批次/审计 + 证据链接 + 收件箱状态 |

### 5.2 没有共享事务的高风险用例

| 用例 | 写入序列 | 风险 |
| --- | --- | --- |
| 采纳提案 | createDecision → proposal accepted | 孤立决策或提案重复采纳状态 |
| 拒绝已采纳提案 | decision cancellation text → proposal rejected | 决策与提案状态不一致 |
| 自动评估写入 | updateDecision → updateRunStatus | 决策已变、run 仍 pending |
| 撤销评估 | updateDecision → updateRunStatus | 回滚后 run 状态仍 auto，二次撤销被拒 |
| 确认复盘草稿 | saveNote → confirmDraft → resolve notification/job | 笔记已保存但草稿仍待确认 |
| 自动整轮 | 多类通知/任务/评估/草稿 | 中途失败留下部分完成数据 |

## 6. 读取路径中的写入

### 6.1 交易 allocations

`tradeStore.getPortfolio()`：

```text
rebuildAllocations()
  DELETE FROM trade_allocations
  iterate confirmed trades
  INSERT trade_allocations
```

该函数被以下读取路径调用：

- `getOverview()` → `/api/dashboard`、`/api/trades`、`/api/trades/inbox`、复查 workspace。
- `productValuationStore.activeHoldings()` → 产品收益 workspace/detail。
- `automationStore.getContext()` → 每次自动评估。

在 `createTrade/updateTrade/confirmTrade/cancelTrade` 内，重建位于交易事务中；在普通读取路径中则没有事务。

### 6.2 决策提案

`dashboardPayload()` 调用 `decisionProposalStore.sync(payload)`，会：

- 将过期 pending 提案推进为 expired。
- 根持仓复核生成/更新 switch proposal。
- 根据可分配资金生成/更新 cash allocation proposal。
- 同步提案与交易的执行状态、决策 review_meta。

### 6.3 消息中心

`dashboardPayload()` 调用 `inboxCenter.sync(payload)`，会：

- 将已到 snooze 日期的项恢复 active。
- 根据多个业务域生成/更新 `inbox_items`。
- 将当前来源已消失的项推进为 resolved。
- 重建 source/summary/count。

## 7. 幂等键与去重审计

| 输入/操作 | 已有保护 | 不足 |
| --- | --- | --- |
| 账户收益 | `record_date UNIQUE` + 同额/异额判断 | 并发跨进程 error 映射未测 |
| 产品收益 | `(product_code,yield_date) UNIQUE` | 修正与截图工作流需统一事务 |
| 交易 | `dedupe_key UNIQUE` + pending/potential duplicate 查询 | 预查和写入不全在同一事务；约束错误不一定映射为 409 |
| 成交截图 | `sha256 UNIQUE` | 文件和 DB 分离，异步 OCR 前去重预查有竞态 |
| 收益截图 | `sha256 UNIQUE` | 同上 |
| 提案 | `dedupe_key UNIQUE` + 状态机 | 生成/更新/采纳跨表不原子 |
| 评估 | `dedupe_key UNIQUE` | 决策与 run 不原子 |
| 通知 | `dedupe_key UNIQUE` | 生成/解决与来源状态不原子 |
| 自动任务 | `dedupe_key UNIQUE` | 没有 retry/lease 执行器 |
| 自动周期 | 内存 `running` | 无持久 lease，进程崩溃留 running |

## 8. 金额与日期规则

### 8.1 金额

- 数据库存储 `REAL`。
- 业务写入通常保留 2 位小数，交易份额保留 4 位。
- 对账以 ±¥0.005 或 ±¥0.01 为边界。
- 赎回匹配剩余金额以 ¥0.004 为停止阈值。
- 这些是现有业务语义，应在 `money` 共享模块中集中实现，但阶段 1 不改存储类型。

### 8.2 日期

- HTTP 主路径以 `todayShanghai()` 生成本地今天。
- 部分 service 默认使用 `new Date().toISOString().slice(0,10)`，这是 UTC 日期。
- 各域重复实现 `parseYmd`、`addDays`、`daysBetween`。
- 未来重构应统一成“用户日期/上海日期/UTC 时间戳”三种明确类型：
  - 用户提供的业务日期：`YYYY-MM-DD`
  - 系统当前业务日：Asia/Shanghai
  - 审计时间戳：ISO UTC

## 9. 备份与恢复

### 9.1 备份

`createDailyBackup()`：

```sql
VACUUM INTO 'data/backups/r2_ledger-YYYY-MM-DD.sqlite'
```

优点：

- 由 SQLite 保证快照一致。
- 每天只创建一份，重复启动不会覆盖当天第一份。

风险：

- 当天第一份备份包含的时间点之后，当天不再自动刷新；恢复点可能早于当天最新数据。
- `pruneBackups(dir, 45)` 实际按“备份条数”而不是日历天数保留。
- API 与启动都操作同一备份目录，没有并发锁；同一秒并发调用仍由文件存在检查兜底，但不是数据库级互斥。

### 9.2 恢复

当前 CLI：

```text
检查健康接口
-> copyFileSync(current db, pre-restore-*.sqlite)
-> copyFileSync(backup, current db)
-> 删除 current db-wal / current db-shm
```

关键风险：

1. 安全快照只复制主库，不包含 WAL；WAL 模式下可能丢最新事务。
2. `prod:stop` 强制杀 Node，不保证 WAL checkpoint。
3. 健康检查固定默认 `8765`，若服务使用其他端口，`R2_HEALTH_URL` 未设置时可能误判“未运行”。
4. 恢复没有校验备份的 `quick_check`、schema/user_version 和必要表。
5. 恢复没有签名/校验和、版本兼容检查或自动回滚验证。
6. 恢复测试只覆盖小型临时库，不覆盖生产 WAL 规模和强制终止。

阶段 8 必须使用 `VACUUM INTO` 或 SQLite backup API制作“恢复前安全备份”，并在服务完全停止后执行验证。

## 10. 数据库兼容原则

重构期间禁止：

- 删除真实数据库。
- 在真实库上做破坏性迁移测试。
- 为追求整洁改变表名、列名、REAL 金额、日期字符串或 JSON 字段语义。
- 未经验证添加外键或级联删除。
- 让一个新模块直接复用旧 SQL 并在旧模块保留第二份可写逻辑。

允许：

- 在临时 DB 上运行旧 schema fixture 到最新 schema 的迁移。
- 逐步把 SQL 移入各域 repository。
- 用显式事务协调器包裹既有写操作。
- 在不改变表结构的前提下增加诊断、幂等和恢复状态。

涉及实际 schema 变更时，必须先交付：

1. 迁移 SQL。
2. 旧库 fixture 和升级测试。
3. 备份与恢复前检查。
4. 兼容/回滚方案。
5. 数据行数和关键汇总前后对比。
