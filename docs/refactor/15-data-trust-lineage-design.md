# 财富事实归属与来源链设计（TD-DATA-001 Step 1）

> 状态：设计基线已完成
> 完成日期：2026-10-23（Asia/Shanghai）
> 范围：数据归属盘点、唯一写入契约、证据来源链、状态机和后续迁移约束
> 非范围：本文件不包含 schema 实施、生产库迁移、业务逻辑修改或页面开发
> 核实来源：`TODO.md`、`docs/refactor/03-database-invariants.md`、当前 `lib/`、`server/` 实现，以及生产 SQLite 的只读元数据检查

## 1. 结论

本项目的财富数据必须持续区分以下五层，不能再用一个可覆盖的 `parsed_json`、备注字段或页面临时状态代替：

1. **原始证据层**：用户上传的图片或文件，以及其内容哈希、存储位置和接收时间。
2. **解释层**：OCR 原文、机器解析结果、视觉识别结果和人工校正版本。
3. **正式事实层**：本金、交易、账户收益、逐产品收益等已经确认的业务事实。
4. **派生投影层**：持仓、赎回批次、本金快照、对账结果、Dashboard 和消息中心。
5. **判断层**：决策提案、正式决策、评估结论和复盘，不能与银行披露事实混为一类。

目标设计采用四项硬约束：

- **单一权威载体**：每类财富事实只有一个可写权威表，其他表只能是派生结果或兼容投影。
- **单一业务入口**：HTTP route 不直接写 SQL；正式写入只能经过对应领域 service/repository 的显式业务命令。
- **证据与事实多对多**：一张截图可以支持多个产品收益和一条账户收益；一项事实也可以由多张截图或后续补充页共同证明。
- **历史只追加**：原始证据、解析版本、事实修订和状态转换均不可静默覆盖。修正产生新版本，旧版本仍可查询。

## 2. 数据归属盘点

### 2.1 权威事实

| 财富事实 | 权威载体 | 业务身份 | 唯一允许的写入用例 | 修订方式 | 当前证据关联 |
| --- | --- | --- | --- | --- | --- |
| 初始本金 | `capital_settings`，固定 `id=1` | 单例 | `capital` 模块的首次初始化和修改初始本金 | 需新增本金审计；更新前后值、原因、来源和操作者 | 当前无 |
| 本金转入/转出 | `capital_events` | `capital_events.id` | `capital` 模块创建和删除本金事件 | 需新增本金审计；删除必须保留撤销记录 | 当前无 |
| 某日本金快照 | 由 `capital_settings + capital_events + 日期` 计算；`daily_records.principal` 是缓存 | `record_date` | 只能由本金重算流程内部写入 | 记录本金重算原因及关联本金修订，不接受用户直接上传 | 派生自本金事实，不直接关联图片 |
| 交易事实 | `trade_transactions` | `trade_transactions.id`；另有业务去重键 | `trades` 模块创建、修改、确认、撤销；交易截图 apply 也必须调用同一交易命令 | `trade_audit`，并纳入统一事实修订索引 | `trade_transactions.screenshot_id`；目标改为 `fact_evidence_links` 权威链接 |
| 持仓和赎回批次 | 由已确认交易计算；`trade_allocations` 只是投影缓存 | 交易 ID / 分配规则 | 没有公开写入口；交易命令提交后重建 | 不单独修订，可从交易事实重建 | 继承来源交易及其截图 |
| 账户每日收益 | `daily_records` | `record_date` | `ledger` 手工录入；收益截图待入账命令 | 同金额幂等；异金额禁止自动覆盖；必须新增前后值审计 | `daily_records.screenshot_id`；目标改为 `fact_evidence_links` |
| 逐产品每日收益 | `product_daily_valuations` | `(product_code, yield_date)` | `product-valuations` 手工补录/修正；收益截图待入账命令 | `product_daily_valuation_audit` 加统一事实修订索引 | `product_daily_valuations.screenshot_id`；目标改为 `fact_evidence_links` |
| 产品收益披露延迟 | `product_yield_settings` | `product_code` | `product-valuations` 核验设置命令 | `product_yield_setting_audit` | 来源为产品文档、App 规则或本人确认，应进入证据链接 |
| 收益/交易截图证据 | `income_inbox`、`trade_inbox` 及其文件 | 内容 SHA-256；流程记录 ID | 各域证据收件箱上传、识别、校正、忽略命令 | 目前会覆盖 `parsed_json`；目标改为追加解释事件 | 原图、OCR、解析和流程状态在收件箱内 |
| 决策 | `decision_log` | `decision_log.id` | `decisions` 模块；提案采纳只能产生待执行决策 | 当前可覆盖更新且无完整修订历史；目标增加决策修订 | `evidence_date` 只是日期，不足以证明证据内容 |
| 提案 | `decision_proposals` | `dedupe_key` | 提案同步、采纳、拒绝、过期 | 保留状态历史；不得删除原提案 | 应链接生成提案时的正式事实、规则和证据版本 |
| 自动评估 | `evaluation_runs` | `dedupe_key` | 自动评估、人工 apply/undo | 保留 rule version、应用和撤销时间 | 必须引用被评估的决策、交易、收益事实及其版本 |

### 2.2 派生和非权威数据

以下内容不得成为财富事实的第二个写入口：

- `trade_allocations`：完全由已确认交易推导。
- 持仓兼容 API 返回的 holding：由交易映射得到，不是独立事实。
- 旧 `holdings` 表：迁移兼容遗留，不是正式持仓来源。
- `daily_records.principal`：本金事件的计算快照，不是用户直接录入的本金。
- `product_daily_valuations.product_name`：证据当时的产品名称快照，不是产品主数据。
- `product_daily_valuations.holding_amount`：截图或录入当时的产品持仓金额，不是当前持仓事实。
- `notifications`、`inbox_items`：业务事实的提醒投影，不是证据或财务事实。
- Dashboard 中的汇总、对账和完成率：读模型，不是可回写的业务状态。
- `app_meta` 中的产品配置、迁移标记和一次性同步状态：运行配置或投影元数据，不是财富事实。

### 2.3 写入所有权规则

1. `server/modules/*/routes.js` 只能调用 service，不得直接访问 `db` 或 store。
2. repository/adapter 可以调用既有 store，但只能暴露领域业务命令；不得向 route 暴露任意 SQL。
3. `GET` 和 Dashboard 读路径不得产生正式财务写入、提案状态变化、消息状态变化或 allocation 重建写入。
4. `/api/review/holdings` 只能继续作为交易命令的兼容适配器，不能恢复写旧 `holdings` 表。
5. 收益截图内部的账户收益和产品收益写入，必须调用 ledger 与 product-valuation 共用的领域命令，不能复制一套截图专用 SQL。
6. `screenshot_id` 字段在迁移期保留兼容，但以后只能由证据链接服务同步生成，不能由页面随意传入或独立维护。

### 2.4 当前实现的主要断点

以下问题必须在后续实施阶段解决，本设计完成不代表问题已经关闭：

1. 截图行同时承担文件、OCR、解析、人工修正和流程状态，`parsed_json` 会被校正直接覆盖。
2. 收件箱没有统一的证据 ID；各事实只保存域内 `screenshot_id`，无法稳定表达一张截图支持多个事实。
3. 账户收益的修改和删除没有前后值审计；本金设置与本金事件也没有完整修订历史。
4. 收益截图当前跨“产品收益 -> 账户收益 -> 收件箱状态”分开写入，不是单一事务。
5. 收益截图遇到同日同金额账户收益时会提前返回，可能跳过同图中的新增产品收益明细；目标设计必须把账户事实和产品事实分别计划，而不是整张截图一并忽略。
6. Dashboard 和部分读取路径仍会重建 allocations、同步提案和消息，读请求存在持久化副作用。
7. 当前过期清理会删除已入账截图，使正式事实永久失去原图来源。
8. 决策可以被直接覆盖更新，且没有足以重建“当时判断”的不可变修订。

## 3. 统一来源链

### 3.1 标识规则

| 对象 | 稳定标识 | 示例 |
| --- | --- | --- |
| 原始证据 | `evidence_assets.id` | `42` |
| 事实 | `fact_type + fact_key` | `account_income:2026-10-22` |
| 修订 | `fact_revisions.id` | `103` |
| 解释事件 | `evidence_events.id` | `501` |
| 证据链接 | `fact_evidence_links.id` | `88` |
| 入账请求 | 确定性 `request_id` / `operation_id` | `income-apply:42:selected-event-501` |

业务键优先使用天然唯一键：

- 账户收益：`record_date`
- 逐产品收益：`product_code + yield_date`
- 交易：交易 ID，辅以现行交易去重键
- 本金事件：本金事件 ID
- 初始本金：固定键 `initial`
- 决策：决策 ID
- 提案：`dedupe_key`

### 3.2 目标数据结构

以下为设计契约；实施前仍需单独的 schema、迁移、兼容和回滚方案审批。

#### `evidence_assets`

保存不可变的原始证据身份：

- `id`
- `evidence_type`：`income-screenshot`、`trade-screenshot`、`bank-statement`、`product-document`、`user-attestation` 等
- `source_channel`：页面、手工导入、迁移等
- `sha256`，内容级唯一
- `original_name`
- `storage_namespace`
- `storage_name`
- `mime`
- `bytes`
- `captured_at`（未知时为空）
- `received_at`
- `available`
- `created_at`

规则：

- 文件内容不可原地替换。
- 同一 SHA-256 再次上传时复用证据，并追加一次重复接收事件。
- 物理文件丢失时保留证据元数据和链接，`available` 标记为不可读取，页面显示“证据缺失”。
- 已被正式事实引用的证据不得进入普通自动清理。

#### `evidence_events`

保存所有可解释版本和流程事件，只追加：

- `id`
- `evidence_id`
- `event_type`
- `actor_type`：`human`、`ocr`、`vision-model`、`automation`、`migration`、`system`
- `actor_ref`
- `payload_json`
- `confidence`
- `dedupe_key`
- `request_id`
- `created_at`

建议事件类型：

- `received`：接收到文件
- `duplicate_received`：重复文件再次上传
- `ocr_completed`：OCR 原文和引擎信息
- `machine_parsed`：机器解析完整快照
- `vision_parsed`：视觉识别结果和检查项
- `human_corrected`：完整新版本、变更字段、前后值和原因
- `version_selected`：确认采用哪个解释版本
- `state_changed`：流程状态转换
- `conflict_detected`：冲突事实和复核要求
- `posted`：正式入账结果和关联修订 ID
- `ignored`：忽略原因
- `failed`：失败阶段、错误和是否可重试
- `legacy_snapshot`：历史数据导入快照，明确不代表当时原始版本

规则：

- `ocr_text` 只在新事件中保存，不覆盖旧事件。
- 人工校正必须是一次新的 `human_corrected` 事件，包含完整有效版本及字段级差异。
- 置信度只是识别质量信号，不等于事实可信度，也不能替代人工确认。
- `income_inbox.parsed_json`、`trade_inbox.parsed_json` 在迁移期保留为“当前选择版本的兼容投影”，不是历史来源。

#### `fact_revisions`

跨域事实修订索引，只追加：

- `id`
- `fact_type`
- `fact_key`
- `revision_no`
- `action`：`create`、`update`、`delete`、`confirm`、`cancel`、`recalculate`
- `before_json`
- `after_json`
- `changed_fields_json`
- `reason`
- `source_class`：`bank-disclosure`、`screenshot`、`document`、`manual`、`derived`、`automation`、`migration`
- `actor_type`
- `actor_ref`
- `request_id`
- `operation_id`
- `created_at`
- 唯一约束：`(fact_type, fact_key, revision_no)`、`(fact_type, fact_key, operation_id)`

规则：

- 当前值仍在各域权威表；修订表只保存历史，不形成第二份可编辑事实。
- 删除是墓碑修订，`before_json` 保留原值，`after_json` 明确记录删除。
- 本金变动引发的账户本金快照重算，使用 `recalculate` 修订并引用触发的本金修订。
- 现有 `trade_audit`、`product_daily_valuation_audit` 继续保留域内细节；迁移后由同一事务同时生成统一修订索引。待读取端完全切换到统一历史后，再评估退役专用审计，不能让两套表各自承担唯一历史。

#### `fact_evidence_links`

描述证据如何支持正式事实：

- `id`
- `fact_type`
- `fact_key`
- `fact_revision_id`
- `evidence_id`
- `evidence_event_id`：采用的具体解释版本
- `role`：`primary`、`corroborating`、`superseded`、`derived-input`
- `field_paths_json`：例如 `["daily_pnl", "products[120056A].daily_pnl"]`
- `confidence`
- `link_status`
- `created_at`
- `retired_at`

规则：

- 一个事实可关联多个证据，一个证据可关联多个事实。
- 正式事实必须指到具体解释版本，不能只指到一个可变的收件箱行。
- 旧链接不删除，用 `superseded`/`retired_at` 结束有效期。
- 查询必须双向可用：
  - 事实 ID -> 原图、OCR、解析、人工校正、采用版本和修订史
  - 证据 ID -> 生成的账户收益、产品收益、交易和决策

### 3.3 来源链示例

```text
evidence_assets#42
  -> evidence_events#301 received
  -> evidence_events#302 ocr_completed
  -> evidence_events#303 machine_parsed (confidence 71)
  -> evidence_events#304 human_corrected (金额 ¥12.34，原因：OCR 将 3 识别为 8)
  -> evidence_events#305 version_selected
  -> fact_evidence_links#881 -> account_income:2026-10-22, field=["daily_pnl"]
  -> fact_evidence_links#882 -> product_income:120056A:2026-10-22, field=["daily_pnl"]
  -> fact_evidence_links#883 -> product_income:107320A:2026-10-22, field=["daily_pnl"]
  -> fact_revisions#901 -> 账户收益创建
  -> fact_revisions#902..#904 -> 产品收益创建
  -> evidence_events#306 posted
```

## 4. 截图状态机

### 4.1 状态定义

| 状态 | 语义 | 是否允许产生正式事实 |
| --- | --- | --- |
| `received` | 已收到文件，等待 OCR/解析 | 否 |
| `needs_correction` | 识别失败、置信度不足、字段缺失或存在待确认差异 | 否 |
| `ready_to_post` | 已选择解释版本并通过预检，等待写入 | 否 |
| `posted` | 正式事实、修订和证据链接已原子提交 | 是 |
| `conflict_pending` | 同日/同产品已有不同值或其他冲突，等待人工处理 | 否 |
| `duplicate_resolved` | 与既有事实一致，已补充证据链接，无新事实 | 是，已有事实 |
| `ignored` | 用户明确忽略，记录原因 | 否 |
| `failed_retryable` | 技术失败或证据暂不可读，可重试 | 否 |

旧 `pending` 在迁移时统一映射为 `needs_correction`，不能推断为“已准备好入账”。

### 4.2 允许的状态转换

```text
received
  -> needs_correction
  -> ready_to_post
  -> failed_retryable
  -> ignored

needs_correction
  -> ready_to_post
  -> failed_retryable
  -> ignored

ready_to_post
  -> posted
  -> duplicate_resolved
  -> conflict_pending
  -> needs_correction
  -> failed_retryable
  -> ignored

conflict_pending
  -> ready_to_post
  -> needs_correction
  -> duplicate_resolved
  -> ignored

failed_retryable
  -> needs_correction
  -> ready_to_post
  -> ignored

posted / duplicate_resolved / ignored
  -> 终态；如需重开，必须追加显式 re-open 事件并记录原因
```

### 4.3 状态机规则

- 每次状态转换都追加 `evidence_events.state_changed`，包含 `from_state`、`to_state`、原因、操作者和请求 ID。
- 正式入账必须在 `BEGIN IMMEDIATE` 事务内同时写正式事实、事实修订、证据链接和 `posted` 状态。
- 事务失败时全部回滚，截图保持 `ready_to_post`；重试使用相同幂等键。
- 不把短暂的内存锁或事务执行称为持久状态。流程状态只表达业务状态，不依赖进程内布尔值。
- 重复 apply 已 `posted` 的截图，返回原结果并追加可选的幂等回放记录，不新增事实。
- 同一图片不同文件名必须命中同一证据哈希，不创建第二份原图。

## 5. 核心业务事务

### 5.1 收益截图入账

目标命令：`postIncomeEvidence(evidenceId, selectedEventId, overrides, requestId)`

事务内顺序：

1. 锁定收件箱行并校验 `ready_to_post`、状态版本和幂等键。
2. 校验日期、收益日期、到账日、本金、产品代码、显式 0 元和披露延迟。
3. 预检账户收益和每个产品收益：
   - 同键同值：复用已有事实，只计划补链接。
   - 账户收益同键同值但产品明细尚不存在：复用账户事实，同时计划新增产品事实和链接。
   - 同键异值：整批转 `conflict_pending`，不写部分事实。
   - 缺失且已到披露时点：进入待校正，不推断为 0。
   - 只有所有目标事实都已存在且同值、本次仅补证据链接时，最终才进入 `duplicate_resolved`；只要新增了任一正式事实，就进入 `posted`。
4. 调用 ledger 领域命令写账户收益及其修订。
5. 调用 product-valuations 领域命令批量写产品收益及其修订。
6. 写 `fact_evidence_links`，明确账户级和产品级字段路径。
7. 更新收件箱为 `posted` 或 `duplicate_resolved`，追加状态和 posted 事件。
8. 提交事务。

对账、Dashboard 和消息中心在事务提交后由只读投影或事务后 projector 更新，不参与财务事实事务回滚。

### 5.2 交易截图入账

现有交易 apply 已具备交易主事务，但还要扩展为：

1. 选择具体证据解释版本。
2. 在交易事务中创建/确认/匹配交易，重建 allocations，追加交易审计和统一修订。
3. 写交易事实与证据链接。
4. 在同一事务中把截图更新为 `posted` 或 `duplicate_resolved`。
5. 提交后再同步决策和自动评估；这些跨域状态不得伪装成银行交易事实。

### 5.3 人工修正

- 修正收益截图识别：新增 `human_corrected` 事件，旧 OCR/机器解析版本保留。
- 修正已入账账户收益：新增 `account_income.update` 修订，要求原因、来源和前后值。
- 修正已入账产品收益：新增 `product_income.update` 修订和证据链接变更，原值保留。
- 修正交易：沿用 `trade_audit` 并同步统一修订，已确认交易修改必须重新校验持仓不变量。
- 删除本金事件或收益记录：写墓碑修订；依赖审计和业务检查保留为什么可以删除。

### 5.4 手工录入

手工录入是合法的业务命令，但证据等级必须显式：

- 有银行页面、文档或本人说明时，先建立证据和解释事件，再链接事实。
- 无外部证据时仍可录入，但 `evidence_status=incomplete`，页面不得显示“证据完整”。
- 手工值可以作为正式事实，不能伪造 OCR 结果或虚构截图。

## 6. 冲突、漏拍和完整性

### 6.1 同键规则

| 场景 | 处理 |
| --- | --- |
| 同日期同金额的账户收益 | 幂等；可补证据链接，不更新时间戳制造新事实 |
| 同日期不同金额的账户收益 | 保留原值；新截图进入 `conflict_pending`；消息中心待确认 |
| 同产品同收益日同金额 | 幂等；补链接 |
| 同产品同收益日不同金额 | 保留原值；整批冲突待确认，不自动覆盖 |
| 产品未出现在截图中但尚未到披露时点 | 不提示缺项，不生成事实 |
| 产品已过披露时点仍未拍到 | 标记本次漏拍，不推断为 0、不判定赎回 |
| 页面明确显示 0 元 | 写入 0 元事实并保留证据链接 |
| 部分赎回/完全赎回 | 交易事实决定持仓；历史产品收益和证据永久保留 |

### 6.2 证据完整性

为每个正式事实计算只读状态：

- `complete`：至少一条有效主证据，所选解释版本存在，文件可读。
- `partial`：有指标级或补充证据，但关键字段或某段时间仍缺证据。
- `incomplete`：无证据、旧迁移无截图或原图不可读。
- `legacy_unknown`：历史导入，无法重建真实解析版本。

页面和 API 必须明确显示状态。`partial`、`incomplete`、`legacy_unknown` 不得被写成一个确定事实或静默补成 0。

### 6.3 证据保留

- 被正式事实引用的原图、OCR、解析版本和链接永久保留。
- 自动清理只允许处理从未生成正式事实的临时/忽略证据，且必须记录清扫事件。
- 如用户明确授权物理删除，先更新证据状态和链接，保留哈希、元数据和删除原因；事实页面显示“原图已删除”。
- 当前 180 天自动清理会删除已入账截图，和“任一事实可追溯到来源证据”的目标冲突，实施阶段必须收紧。

## 7. 幂等、并发与恢复

### 7.1 幂等键

- 上传：`sha256`。
- 解释：`evidence_id + event_type + deterministic event key`。
- 选择版本：`evidence_id + selected_event_id`。
- 入账：`evidence_id + selected_event_id + normalizer_version`。
- 事实修订：`fact_type + fact_key + operation_id`。

同一幂等键只能形成一条有效事实修订和一组有效证据链接。重复请求返回现有结果。

### 7.2 并发

- 财务写入统一使用 `BEGIN IMMEDIATE`。
- 收件箱行增加状态版本或乐观锁字段；状态改变时校验旧版本。
- 交易 allocations 在交易命令完成时更新；读请求不能再全表删除后重建。
- 两个相同文件并发上传，只允许一个证据资产和一个收件箱流程记录胜出。
- 两个不同截图同时尝试写同一 `(product_code, yield_date)`，后到者按同键规则变成幂等或冲突。

### 7.3 文件与数据库一致性

建议上传流程：

1. 流式写入临时文件并计算 SHA-256。
2. 以哈希查重。
3. 将临时文件原子移动到最终存储名。
4. 在一个事务内写 `evidence_assets`、收件箱记录和 `received` 事件。
5. 文件移动成功但数据库失败时，由启动/定期 reconciler 清理孤立文件。

任何孤立文件或缺失文件都必须可诊断，不能造成正式事实。

## 8. 历史迁移设计

本步骤不执行迁移。后续获得 schema/历史事实变更授权后，按以下原则实施。

### 8.1 回填

1. 为每个 `income_inbox`、`trade_inbox` 行创建或复用 `evidence_assets`。
2. 将现有 `ocr_text`、`parsed_json`、置信度作为单条 `legacy_snapshot` 事件。
3. 不得声称该快照是当时原始机器解析；历史版本可能已被人工覆盖，标记 `legacy_unknown`。
4. 从 `daily_records.screenshot_id`、`product_daily_valuations.screenshot_id`、`trade_transactions.screenshot_id` 建立初始证据链接。
5. 将现有交易审计和产品收益审计导入统一事实修订索引，保留原时间戳和备注。
6. 对无截图的迁移交易、手工收益和旧决策建立 `incomplete` 或 `legacy_unknown` 状态，不补造证据。

### 8.2 状态映射

| 旧状态 | 新状态 |
| --- | --- |
| `income_inbox.pending` / `trade_inbox.pending` | `needs_correction` |
| `applied` | `posted` |
| `ignored` | `ignored` |
| `trade_inbox.applied` 且 `duplicate_of` 非空 | `posted`；保留旧 `duplicate_of`，历史是否真正新增事实无法精确还原 |

### 8.3 迁移安全

迁移必须单独提供：

1. 迁移 SQL 和旧库 fixture。
2. `VACUUM INTO` 备份。
3. 行数、金额汇总、唯一键和完整性检查的前后对比。
4. 兼容读取期和回滚脚本。
5. 失败时保留旧列和旧状态，禁止半迁移后启动写业务。

## 9. 页面追溯要求

每个关键数字应能打开统一的“来源与修订”面板：

- 当前采用值及所属正式事实
- 证据完整度
- 原图缩略图、文件名、哈希、接收时间
- OCR 原文
- 机器解析、视觉识别和人工校正版本
- 每个字段来自哪个版本
- 修订前后值、变更字段、原因、来源和时间
- 相关账户收益、产品收益、交易、决策链接
- 冲突、漏拍和未到披露时点的说明

页面文字仍须满足 12px 下限，并检查桌面和移动宽度。

## 10. 验收与测试映射

Step 2 实现后至少覆盖：

- 同一图片重复上传、不同文件名上传。
- OCR 金额错误、产品代码错误、人工校正后保留原解析。
- 同日期同金额、同日期不同金额。
- 同产品同日同金额、不同金额。
- 正常披露延迟、已到披露时点漏拍、明确 0 元。
- 部分赎回、完全赎回、赎回后历史收益仍可追溯。
- 重复 apply、重复 automation run、并发 apply。
- 在正式事实、修订、链接和收件箱状态任一步注入故障，整批回滚或停在可重试状态。
- 事实 -> 证据 -> 修订双向查询完整。
- GET 前后数据库状态不变。
- 已被事实引用的截图不会被自动清理。
- 无证据历史事实明确显示 `incomplete`/`legacy_unknown`。

与现有待办的对应关系：

- `TD-REF-001`：第 5.1 节的事务边界和故障注入。
- `TD-DATA-001` 来源链：第 3、4、6、8、9 节。
- `TD-CAL-001`：第 2.1 节决策和评估只引用正式事实、证据版本和规则版本，不直接引用 OCR 原始值。

## 11. 实施边界与下一步

本 Step 1 已完成：

- 盘点本金、交易、持仓、账户收益、逐产品收益、截图证据和决策的权威载体。
- 明确唯一业务写入口和禁止写路径。
- 明确原始证据、解释版本、正式事实、修订和派生投影的分层。
- 设计证据与事实的双向链接、截图状态机、幂等与迁移原则。

尚未完成：

- schema 变更和迁移脚本。
- 收益截图单一事务实施。
- 账户收益、本金和决策修订表。
- 证据追溯 API 和页面。
- 完整可信度回归测试。

下一步应先基于本文件产出 schema/迁移与兼容方案，经用户授权后再修改真实数据库。不得把本设计完成当成 `TD-DATA-001` 或 `TD-REF-001` 已完成。
