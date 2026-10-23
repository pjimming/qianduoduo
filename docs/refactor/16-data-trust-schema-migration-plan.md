# 财富数据可信度 Schema、迁移、兼容与回滚方案

> 状态：已于 2026-10-23 完成生产迁移、重启和验证
> 制定日期：2026-10-23（Asia/Shanghai）
> 迁移 ID：`2026-10-23-data-trust-v1`
> 设计基线：`docs/refactor/15-data-trust-lineage-design.md`
> 执行 DDL：`docs/refactor/migrations/001-data-trust-v1.up.sql`
> 执行 DDL SHA-256：`3F6973633E4AB5BA6A9FB1A00A71A461B2B50F569F81C0584F1E43E503D4CF17`
> 当前约束：不修改真实数据库、不迁移历史事实、不启动生产服务

## 1. 方案结论

本次迁移采用“**追加式 schema + 离线回填 + 双写兼容 + 分级回滚**”：

1. 不重命名、不删除现有业务表，不改变现有金额、日期和 JSON 字段语义。
2. 新增统一证据资产、证据事件、事实修订和证据链接四张表。
3. 为 `income_inbox` 和 `trade_inbox` 增加统一证据 ID、工作流状态、所选解释版本和状态版本。
4. 现有 `status`、`parsed_json`、`screenshot_id` 保留为兼容投影，旧代码和旧 API 可以继续工作。
5. 历史 `parsed_json` 只作为 `legacy_snapshot` 导入，不伪造当时未保存的原始解析历史。
6. 迁移与代码发布解耦：先完成离线 schema/回填，再发布 shadow 双写代码，最后切换到 enforce。
7. 任何 schema 或历史事实变更在获得明确授权前不执行。

执行 DDL 已在 **2026-10-23** 使用生产数据库的一致性副本做过语法验证：

- 5 张新表全部创建成功。
- 两个收件箱的新增列全部存在。
- `PRAGMA quick_check` 返回 `ok`。
- `PRAGMA foreign_key_check` 返回空集合。
- 新增了 14 个相关索引。
- 该验证只证明 schema 语法，不证明数据回填和业务事务已经完成。

## 2. 迁移范围

### 2.1 本次 schema 包含

- `schema_migrations`
- `evidence_assets`
- `evidence_events`
- `fact_revisions`
- `fact_evidence_links`
- `income_inbox` 的 5 个新列
- `trade_inbox` 的 5 个新列
- 对应索引和局部唯一约束

### 2.2 本次 migration runner 包含

- 迁移前预检和一致性备份。
- 现有收件箱到 `evidence_assets` 的回填。
- 现有 OCR/解析状态到 `legacy_snapshot` 事件的回填。
- 现有记录到事实基线修订的回填。
- 现有 `screenshot_id` 到证据链接的回填。
- 旧 `status` 到新 `workflow_state` 的兼容映射。
- 迁移前后完整性、计数和财务摘要对比。
- 迁移完成标记。

### 2.3 不在本迁移中

- 不把收益截图 apply 改成单事务。
- 不新增追溯 API 或页面。
- 不删除专用审计表。
- 不改变持仓、估值、对账或决策算法。
- 不清理截图文件。
- 不把历史 `pending` 自动解释成“可入账”。
- 不开始 `TD-CAL-001` 的预测字段改造。

## 3. 目标 Schema

### 3.1 `schema_migrations`

用于显式记录迁移生命周期，避免继续依赖无状态的一次性 `app_meta` 标记。

关键字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 迁移 ID |
| `script_sha256` | 冻结后的 DDL 文件校验和 |
| `status` | `running` / `completed` / `failed` |
| `started_at` | 开始时间，UTC ISO 时间戳 |
| `completed_at` | 完成时间 |
| `error` | 已知失败原因 |

执行规则：

1. runner 先在独立事务中写入 `running` 并提交。
2. 主迁移在 `BEGIN IMMEDIATE` 中执行。
3. DDL、数据回填和 `completed` 更新在同一主事务中提交。
4. 主事务失败时回滚；runner 随后在独立事务中写 `failed`。
5. 启动时发现 `running` 或 `failed`，服务拒绝启动并要求人工处置。

### 3.2 `evidence_assets`

保存不可变证据身份和文件保管信息。

关键约束：

- `(evidence_type, sha256)` 唯一。
- SHA-256 必须为 64 位。
- `available` 表示原文件当前是否可读取。
- `status` 只允许 `active`、`quarantined`、`deleted`。
- 文件不可原地替换；内容变化必须生成新证据。

`storage_namespace` 建议值：

- `income-inbox`
- `trade-inbox`
- `documents`

### 3.3 `evidence_events`

保存原始接收、OCR、机器解析、视觉识别、人工校正、版本选择和状态转换，只追加。

关键约束：

- 非空 `dedupe_key` 在同一证据内唯一。
- `confidence` 可为空，范围为 0–100。
- `previous_event_id` 形成不可变事件链。
- `payload_json` 保存完整事件快照，不使用 UPDATE 重写旧发现。

### 3.4 `fact_revisions`

跨域事实修订索引。权威当前值仍在原有业务表，本表只追加历史。

建议 `fact_type`：

- `capital_initial`
- `capital_event`
- `principal_snapshot`
- `trade`
- `account_income`
- `product_income`
- `product_yield_setting`
- `decision`
- `proposal`
- `evaluation`

建议 `fact_key`：

- `capital_initial:1`
- `capital_event:<id>`
- `principal_snapshot:<daily_records.id>`
- `trade:<trade_transactions.id>`
- `account_income:<daily_records.id>`
- `product_income:<product_daily_valuations.id>`
- `product_yield_setting:<product_code>`
- `decision:<decision_log.id>`
- `proposal:<decision_proposals.id>`
- `evaluation:<evaluation_runs.id>`

稳定数据库 ID 优先于可能变化的业务日期或产品自然键。

幂等约束：

- `(fact_type, fact_key, revision_no)` 唯一。
- `(fact_type, fact_key, operation_id)` 唯一。
- 一个入账批次可以有一个共同 `operation_id`，并产生多条不同事实的修订。

### 3.5 `fact_evidence_links`

连接具体事实修订、证据资产和采用的解释事件。

关键规则：

- `fact_revision_id` 必须指向 `fact_revisions`。
- `evidence_id` 必须与 `evidence_event_id` 所属证据一致，由应用层校验。
- `field_paths_json` 使用稳定字段路径，例如 `["daily_pnl", "holding_amount"]`。
- 链接不物理删除；失效时更新 `link_status` 和 `retired_at`。
- 同一修订、证据、解释事件和角色只允许一条链接；多个字段合并进 `field_paths_json`。

### 3.6 收件箱新增列

`income_inbox` 和 `trade_inbox` 均增加：

| 列 | 说明 |
| --- | --- |
| `evidence_id` | 对应 `evidence_assets.id` |
| `workflow_state` | 新状态机状态 |
| `selected_event_id` | 当前采用的解释事件 |
| `state_version` | 乐观锁版本，初始为 0，业务迁移后至少为 1 |
| `last_request_id` | 最近一次状态命令的请求 ID |

兼容原则：

- 旧 `status` 不删除、不改变现有值。
- `parsed_json` 继续返回最近采用的解释版本，作为兼容投影。
- `evidence_id` 在回填后要求全部非空，但列本身保持 nullable，避免重建旧表。
- 应用层和迁移验证共同保证非空；数据库另建局部唯一索引。

## 4. 旧状态到新状态映射

| 旧 `status` | 新 `workflow_state` | 说明 |
| --- | --- | --- |
| `pending` | `needs_correction` | 无法可靠区分待识别和待校正，保守进入人工可处理状态 |
| `applied` | `posted` | 保留“已处理”事实，不推断当时是否真正新增事实 |
| `ignored` | `ignored` | 保留忽略语义 |

不把旧 `trade_inbox.duplicate_of` 自动映射为 `duplicate_resolved`。当前实现中“匹配已有交易”可能同时补充截图、关联决策或确认 pending 交易，无法从旧数据证明没有业务变化，因此统一保守映射为 `posted`，并追加 `legacy_snapshot` 事件说明历史精度未知。

旧 `status` 到新 `workflow_state` 的兼容投影：

| 新状态 | 旧 `status` |
| --- | --- |
| `received` | `pending` |
| `needs_correction` | `pending` |
| `ready_to_post` | `pending` |
| `conflict_pending` | `pending` |
| `failed_retryable` | `pending` |
| `posted` | `applied` |
| `duplicate_resolved` | `applied` |
| `ignored` | `ignored` |

新代码每次状态变更必须在同一事务中同时写新状态和旧投影。

## 5. 历史数据回填

### 5.1 回填原则

1. 不修改现有事实值。
2. 不修改现有 `status`、`parsed_json`、`screenshot_id`。
3. 不声称旧 `parsed_json` 是原始机器结果。
4. 旧审计可以导入统一修订；没有审计时只建立当前值基线。
5. 缺失文件、缺失截图关联和无法解析的 JSON 都显式标记，不补造。

### 5.2 证据资产

对每条 `income_inbox`：

```text
evidence_type       = income-screenshot
source_channel      = migration
sha256              = income_inbox.sha256
original_name       = income_inbox.original_name
storage_namespace   = income-inbox
storage_name        = income_inbox.stored_name
mime                = income_inbox.mime
bytes               = income_inbox.bytes
captured_at         = NULL
received_at         = income_inbox.received_at
available           = 文件存在 ? 1 : 0
status              = active
created_at          = received_at
```

对每条 `trade_inbox`：

```text
evidence_type       = trade-screenshot
source_channel      = migration
storage_namespace   = trade-inbox
其余字段采用相同规则
```

规则：

- 相同类型和哈希只创建一条资产。
- 若同一哈希在不同域出现，分别保留为不同类型的证据，并生成迁移诊断。
- 回填后把 `income_inbox.evidence_id`、`trade_inbox.evidence_id` 指向对应资产。
- 文件缺失不会阻止迁移，但 `available=0`，后续事实显示证据缺失。

### 5.3 旧快照事件

每条收件箱创建一条 `legacy_snapshot`：

```json
{
  "original_name": "...",
  "mime": "image/png",
  "bytes": 12345,
  "sha256": "...",
  "ocr_text": "...",
  "parsed_json_raw": "{...}",
  "parse_confidence": 95,
  "legacy_status": "applied",
  "record_date": "2026-10-22",
  "error": "",
  "notes": "...",
  "provenance": "legacy-unknown",
  "message": "历史 parsed_json 可能已被人工校正覆盖，无法还原原始解析版本"
}
```

字段：

- `event_type=legacy_snapshot`
- `actor_type=migration`
- `actor_ref=data-trust-v1`
- `dedupe_key=legacy:<sha256>`
- `previous_event_id=NULL`
- `created_at=evidence_assets.received_at`

回填后把 `selected_event_id` 指向该事件。

### 5.4 事实基线

如果已有专用审计：

- 交易按 `trade_audit.created_at + id` 正序导入。
- 产品收益按 `product_daily_valuation_audit.created_at + id` 正序导入。
- 审计动作与统一动作一一映射。
- `operation_id` 使用 `legacy-<source-table>:<source-audit-id>`。
- `actor_type=migration`，原操作者未知时 `actor_ref='legacy-unknown'`。
- 原有 `note` 写入 `reason`。
- `before_json`、`after_json` 先验证 JSON；无效字符串保留在诊断 JSON，不阻止事实迁移。

如果审计为空或审计快照无法覆盖当前值：

- 追加一条 `create` 或 `recalculate` 基线修订。
- `operation_id=legacy-baseline-v1:<fact_type>:<fact_key>`。
- `reason='迁移基线：导入当前正式事实'`。
- 该修订只表示“迁移时看到的值”，不表示历史最初创建时间。

具体事实：

| 事实 | 基线来源 | 备注 |
| --- | --- | --- |
| 初始本金 | `capital_settings` | 一条基线 |
| 本金事件 | `capital_events` | 每行一条 `create` 基线 |
| 本金快照 | `daily_records.principal` | 每行一条 `recalculate` 基线 |
| 交易 | `trade_audit` + 当前交易 | 优先导入历史，末尾补齐当前快照 |
| 账户收益 | `daily_records` | 当前无历史审计，建立基线 |
| 产品收益 | 产品审计 + 当前估值 | 优先导入历史，末尾补齐当前快照 |
| 收益延迟设置 | `product_yield_settings` + 审计 | 有审计则导入，否则基线 |
| 决策 | `decision_log` | 当前字段建立基线 |
| 提案 | `decision_proposals` | 每行当前值基线 |
| 评估 | `evaluation_runs` | 每行当前值基线 |

### 5.5 现有截图链接

回填以下关系：

| 事实 | 来源字段 | `field_paths_json` |
| --- | --- | --- |
| 账户收益 | `daily_records.screenshot_id` | `["date", "daily_pnl"]` |
| 产品收益 | `product_daily_valuations.screenshot_id` | `["yield_date", "credit_date", "daily_pnl", "holding_amount"]` |
| 交易 | `trade_transactions.screenshot_id` | `["trade_date", "trade_type", "product_code", "amount", "status"]` |

要求：

1. 先找到对应收件箱行及 `evidence_id`。
2. 使用该行的 `selected_event_id` 作为 `evidence_event_id`。
3. 使用事实当前值的基线或最新导入修订作为 `fact_revision_id`。
4. 同一事实同时间只建立一条 `primary` 链接。
5. `screenshot_id` 指向不存在的收件箱时，不创建假链接；生成 `orphan-evidence-pointer` 诊断。

### 5.6 收件箱状态

在证据 ID 和所选事件就绪后：

1. 按第 4 节映射 `workflow_state`。
2. `state_version` 从 0 更新为 1。
3. 追加 `state_changed` 事件，`from_state='legacy-unknown'`、`to_state=<映射>`。
4. 事件原因写明 `迁移自旧 status=<value>，历史内部状态不可精确还原`。
5. 不修改旧 `status`。

所有 `state_changed` 事件的 `dedupe_key` 使用：

```text
legacy-state:<inbox-table>:<inbox-id>:<legacy-status>
```

## 6. 迁移事务与执行顺序

### 6.1 预备条件

必须同时满足：

- 用户明确授权执行 schema 和历史事实迁移。
- `npm run prod:stop` 已执行。
- `npm run prod:status` 确认服务未运行。
- 生产数据库无其他 SQLite writer。
- 可用磁盘空间至少为数据库大小的 3 倍。
- 当前代码测试基线通过。
- DDL 文件已冻结并记录 SHA-256。

### 6.2 操作顺序

1. **预检**
   - `PRAGMA quick_check`
   - `PRAGMA foreign_key_check`
   - 关键表、列、索引存在性
   - 非法 SHA-256、空哈希、重复状态等诊断
   - 事实表行数和金额摘要指纹
2. **一致性备份**
   - 使用 `VACUUM INTO`
   - 备份到独立文件名 `pre-data-trust-v1-*.sqlite`
   - 验证 `quick_check` 和关键表
   - 计算备份 SHA-256
3. **副本演练**
   - 复制生产一致性快照到临时路径
   - 执行完整 schema + 回填
   - 运行全部验证 SQL 和 API smoke
   - 结果通过后才允许操作生产库
4. **生产迁移**
   - 写 `schema_migrations.status='running'`
   - `BEGIN IMMEDIATE`
   - 执行 DDL
   - 执行全部回填
   - 运行事务内关键校验
   - 写 `completed`
   - `COMMIT`
5. **迁移后验证**
   - `quick_check`
   - `foreign_key_check`
   - 行数、金额摘要和业务键一致性
   - 证据与链接完整性
   - 旧字段和新投影一致性
6. **兼容代码启动**
   - 以 shadow 模式启动
   - 健康检查和关键 API smoke
   - 检查 stderr 与迁移诊断

### 6.3 不建议自动迁移

普通 `openDatabase()` 不应像现有补列逻辑一样自动执行本次迁移。建议：

- 服务启动仅检查迁移是否完成。
- 未完成时明确报错并停止接受财务写入。
- 显式命令 `node scripts/migrate-data-trust.mjs --apply` 执行。
- 测试和临时库可由测试 helper 自动执行同一迁移函数。

## 7. 兼容方案

### 7.1 HTTP 兼容

现有 API 的路径、方法、成功状态码和已有响应字段保持不变：

- 收益/交易截图上传、apply、ignore、图片和清理接口。
- 本金、账户收益、产品收益和交易接口。
- Dashboard、消息中心、决策和评估接口。

新增字段只能追加，例如：

- `workflow_state`
- `evidence_id`
- `evidence_status`
- `revision_id`
- `evidence_refs`

旧客户端忽略新增字段，不得要求旧字段改名。

### 7.2 旧字段作为兼容投影

| 兼容字段 | 新权威来源 | 写入规则 |
| --- | --- | --- |
| `income_inbox.status`、`trade_inbox.status` | `workflow_state` | 状态命令在同一事务中同步 |
| `income_inbox.parsed_json`、`trade_inbox.parsed_json` | `selected_event_id` 对应事件 | 只存最近采用版本的投影 |
| `daily_records.screenshot_id` | `fact_evidence_links` | 第一主证据的兼容指针 |
| `product_daily_valuations.screenshot_id` | `fact_evidence_links` | 第一主证据的兼容指针 |
| `trade_transactions.screenshot_id` | `fact_evidence_links` | 第一主证据的兼容指针 |

应用启动和测试必须验证这些投影不偏离新权威数据。

### 7.3 运行模式

建议新增环境变量 `R2_DATA_TRUST_MODE`：

| 模式 | 写入 | 读取 | 用途 |
| --- | --- | --- | --- |
| `shadow` | 旧字段为主，新证据/修订在同类事务中双写 | 旧路径为主，新表只做诊断 | 首批部署 |
| `enforce` | 先校验新模型，正式事实与证据/修订同事务；继续同步旧投影 | 可返回追踪字段，旧字段仍可用 | 稳定后 |

默认值建议为 `shadow`，验收通过后再切到 `enforce`。切换必须通过显式配置和重启完成，不在运行时自动升级。

### 7.4 双写一致性

shadow 和 enforce 均要求：

- 同一个业务事务完成正式事实、旧投影、证据事件、修订和链接。
- 任一写入失败整体回滚。
- 每次写后比较旧状态投影和 `workflow_state`。
- 每次写后比较 `screenshot_id` 和主证据链接。
- 对比失败时记录诊断，财务事务失败；不允许静默继续。

### 7.5 读取兼容

迁移完成但新代码尚未启用时，旧代码只允许做只读诊断或短时健康检查：

- 旧代码继续读取原表和原字段。
- 新表只读，不参与状态推进。
- 禁止用旧代码执行截图上传、apply、交易、收益或本金写入；旧代码不会创建 `evidence_id`、解释事件、修订和证据链接。
- 正式上线必须停在维护窗口内，从迁移完成直接切换到支持双写的新代码。

如果因回滚确实使用了旧代码写入，则重新进入 shadow 前必须运行 catch-up reconciler：

- 对缺少资产的收件箱补建 `evidence_assets`。
- 对缺少解释历史的记录补建 `legacy_snapshot`。
- 对新增或修改的正式事实补建基线与链接。
- 对旧 `status` 与 `workflow_state` 的差异追加 reconciliation 事件。
- catch-up 未通过前，禁止切换到 enforce。

新代码启用后：

- 旧截图列表继续正常工作。
- 事实页面新增可选 `evidence_status` 和追踪链接。
- 证据链不可用时返回明确状态，不返回伪造的完整状态。

## 8. 验证与回归

### 8.1 迁移结构验证

- 5 张新表存在。
- 两个收件箱各增加 5 列。
- 全部新索引和唯一约束存在。
- `PRAGMA quick_check = ok`。
- `PRAGMA foreign_key_check` 为空。

### 8.2 回填验证

- 每条收件箱都有非空 `evidence_id`。
- 每条收件箱都有可追溯的 `selected_event_id`。
- 资产数与对应收件箱数一致。
- 每条 `legacy_snapshot` 事件指向存在的资产。
- 每个正式事实至少有一条基线修订。
- 每个非空 `screenshot_id` 都有有效证据链接，或明确登记 orphan 诊断。
- 链接中的 `evidence_event_id` 属于同一 `evidence_id`。
- `fact_evidence_links.fact_revision_id` 均有效。

### 8.3 业务不变量验证

迁移前后必须完全一致：

- `capital_settings` 行数和全部字段。
- `capital_events` 行数及金额摘要。
- `daily_records` 行数、`daily_pnl`、`principal`、日期和备注。
- `trade_transactions` 行数、状态、产品、金额和确认日。
- `product_daily_valuations` 行数和收益摘要。
- `decision_log` 行数和关键字段。
- 现有 `status`、`parsed_json`、`screenshot_id` 完全不变。

建议对每张权威表按 ID 排序生成规范化 JSON 的行哈希，迁移前后比较。

### 8.4 测试矩阵

实施时必须新增：

1. 空数据库迁移。
2. 当前生产 schema 的一致性副本迁移。
3. 至少两个历史旧 schema fixture 升级。
4. 重复执行迁移的幂等性。
5. 迁移中每一步故障注入。
6. 文件存在和文件缺失两种证据。
7. 合法、非法和空 `parsed_json`。
8. 非空和 orphan `screenshot_id`。
9. 交易/产品审计导入顺序和最终值一致性。
10. 旧状态到新状态的映射。
11. 旧字段与新投影一致性。
12. shadow 双写成功与故障回滚。
13. enforce 下收益截图全事务提交。
14. 重复 apply、重复定时任务和并发 apply。
15. 旧 API 响应结构兼容。
16. 桌面和移动端新增追溯信息的 12px 字号。

实施交付必须运行：

```powershell
npm run check
npm test
npm run build
npm run test:e2e
node --experimental-test-coverage --test
```

### 8.5 2026-10-23 只读预检快照

以下数据只用于说明当前迁移样本，执行时必须重新生成：

| 表/分组 | 当前只读观察 |
| --- | --- |
| `daily_records` | 3 行 |
| `trade_transactions` | 8 行 |
| `trade_allocations` | 1 行 |
| `income_inbox` | 4 行，全部为 `applied` |
| `trade_inbox` | 14 行，10 行 `applied`、4 行 `ignored` |
| `product_daily_valuations` | 11 行 |
| `product_daily_valuation_audit` | 20 行，11 条 create、9 条 update |
| `trade_audit` | 58 行，8 条 create、45 条 update、5 条 confirm |
| `decision_log` | 2 行 |
| `decision_proposals` | 1 行 |

不含金额、客户信息或截图内容。该快照不得写成永久“当前状态”。

## 9. API 和 UI 实施顺序

### 9.1 第一批：只写新模型

- 上传截图时创建资产和 received 事件。
- OCR、视觉识别和人工校正改为追加事件。
- 旧 `parsed_json` 作为所选版本投影。

### 9.2 第二批：事实事务

- `postIncomeEvidence()` 单事务写账户收益、产品收益、修订、链接和状态。
- 交易 apply 扩展统一事件与链接。
- 本金、账户收益和决策写修订。

### 9.3 第三批：追踪读取

建议新增只读接口：

- `GET /api/evidence/:id/trace`
- `GET /api/facts/:factType/:factKey/trace`

响应必须同时支持“事实 -> 证据”和“证据 -> 事实”，并区分：

- 银行披露事实
- 机器解析
- 人工校正
- 正式事实
- 派生结果

### 9.4 第四批：页面

- 在账户收益、产品收益、交易、本金和决策详情增加“来源与修订”。
- 无证据事实显示 `incomplete`/`legacy_unknown`。
- 已完成事实的原图及其历史不得被普通清理入口删除。

## 10. 回滚方案

### 10.1 总原则

首选保留新表和证据数据的热回滚，不执行 schema 删除。证据链一旦产生，删除表或列会造成不可恢复的历史损失。

### 10.2 回滚等级

#### R0：迁移事务失败

触发条件：

- DDL、回填或事务内校验失败。

处理：

1. 主事务自动 `ROLLBACK`。
2. runner 将 `schema_migrations` 更新为 `failed`。
3. 服务保持停止。
4. 对数据库执行 `quick_check`。
5. 修复迁移代码后在数据库副本验证，再从备份或原库重新执行。

由于主事务使用 SQLite 事务 DDL，正常失败不应留下半个 schema。

#### R1：代码热回滚，推荐

触发条件：

- 新代码兼容问题。
- shadow 双写校验异常。
- 新页面或 API 故障。

处理：

1. 停止新服务。
2. 部署上一版代码。
3. 保留全部新增表、列和数据。
4. 旧代码忽略新列和新表，继续使用旧字段。
5. 运行健康检查、收益截图、交易 apply、Dashboard 和消息中心 smoke。

限制：

- 热回滚期间建议暂停财务写入。
- 如果旧代码已经产生新写入，旧代码不会维护新状态。重新上线新代码前必须运行方向一致性检查，把差异作为 `reopened` 或 reconciliation 事件处理。
- 未完成 reconcile 前不得切成 enforce。

#### R2：恢复迁移前备份

触发条件：

- schema 或回填造成旧表数据损坏。
- 需要彻底回到迁移前版本。
- 用户明确接受迁移后新增数据会丢失。

处理：

1. 停止服务。
2. 使用 `restoreDatabase()` 恢复 `pre-data-trust-v1-*.sqlite`。
3. 确认 pre-restore 安全快照已生成。
4. 验证 `quick_check` 和关键旧表。
5. 部署旧代码并启动。

这是数据恢复操作，不是普通代码回滚，必须单独授权。

#### R3：删除新增表和列

不建议使用。只有在迁移前备份不可用、且确认没有迁移后业务数据时，才可设计和执行一次性 down migration。

风险：

- 删除证据和修订历史。
- SQLite 删除带索引/约束的列可能需要重建收件箱表。
- 文件系统证据与新表 ID 失联。
- 后续重新迁移无法恢复已经删除的人工校正历史。

本方案不提供可直接执行的 down SQL，避免误操作。

### 10.3 回滚后的重新升级

如果采用 R1 且期间发生旧代码写入：

1. 对比旧 `status` 与 `workflow_state`。
2. 对比 `screenshot_id` 与主证据链接。
3. 对旧代码新上传但无证据事件的记录补建 `legacy_snapshot`。
4. 对状态差异追加 reconciliation 事件。
5. 全部通过后切回 shadow，再观察一个写入周期后进入 enforce。

## 11. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 历史 `parsed_json` 已被覆盖 | 明确标为 `legacy_snapshot`，不声称是原始解析 |
| 原图已被清理 | `available=0`，正式事实显示证据缺失 |
| 旧代码与新状态分叉 | shadow parity 检查；回滚期间暂停财务写入 |
| 回填金额或事实变化 | 迁移前后行哈希和财务摘要必须一致 |
| SQLite 锁或进程残留 | 服务停止、`BEGIN IMMEDIATE`、busy timeout、迁移锁 |
| orphan 文件或截图指针 | 预检报告 + reconciler；不创建假链接 |
| 双写导致半提交 | 业务事务统一写入；故障注入验证 |
| 统一修订与专用审计不一致 | 同事务双写 + parity 测试；稳定后决定专用审计是否降为适配视图 |
| 迁移后继续自动删证据 | 在 enforce 前修改清理规则，引用中的证据禁止普通清理 |

## 12. 授权与完成标准

执行前需要用户明确授权以下三项：

1. 新增 schema 和索引。
2. 在真实库回填证据、修订、链接和 workflow 状态。
3. 后续以 shadow 模式发布双写代码。

迁移实施完成标准：

- DDL 和 runner 代码已生产化并通过故障注入。
- 当前生产库副本演练成功。
- 迁移前后业务行哈希和财务摘要一致。
- 每张收件箱都有证据和解释版本。
- 正式事实的主证据链接完整，缺失项明确标注。
- 旧 API、旧数据和 Dashboard 全部兼容。
- shadow 期无 parity 异常。
- 回滚演练成功。
- 生产执行后 `prod:status`、健康接口、关键 API、stderr 和 stop marker 均正常。

只有满足以上条件后，才能把 `TD-DATA-001` 的 schema/迁移子项标记完成；本方案稿本身不等于迁移完成。

## 13. 生产执行记录（2026-10-23）

执行结果：

- 生产服务先通过 `npm run prod:stop` 停止，`prod:status` 确认 Server 和 Supervisor 均为 stopped。
- 迁移前预检 `quick_check=ok`，schema 为完整旧基线，业务表无非法哈希。
- 一致性备份：
  `D:\codex\钱多多财富工作台\data\backups\pre-data-trust-v1-20261023-165810.sqlite`
- 迁移 ID `2026-10-23-data-trust-v1` 状态为 `completed`。
- DDL SHA-256 为
  `3f6973633e4ab5ba6a9fb1a00a71a461b2b50f569f81c0584f1e43e503d4cf17`。
- 迁移前后 8 个核心业务表指纹完全一致：
  `capital_settings`、`capital_events`、`daily_records`、
  `trade_transactions`、`product_daily_valuations`、`decision_log`、
  `income_inbox`、`trade_inbox`。
- 回填结果：18 个证据资产、36 个证据事件、112 条事实修订、21 条证据链接。
- 两个收件箱缺失 `evidence_id` 均为 0，缺失有效 `selected_event_id` 均为 0，孤立链接为 0。
- `PRAGMA quick_check=ok`，`PRAGMA foreign_key_check` 为空。
- 生产服务已重启，`prod:status` 显示 Health OK；`/api/dashboard` 和
  `/api/data-trust/status` 均返回正常。
- 生产事实追溯抽查：`account_income:3` 显示 `complete`、1 个修订版本、
  1 条证据链接，原图可读。
- `R2_DATA_TRUST_MODE` 默认 `shadow`；旧字段继续同步，新证据链与修订链同时写入。
- 已实测回滚命令可在临时迁移副本上恢复迁移前快照，并保留
  `pre-restore-*` 安全副本；真实生产备份只用于必要时恢复。
