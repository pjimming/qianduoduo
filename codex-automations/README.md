# Codex 定时任务

这里记录钱多多工作区使用的 Codex 桌面端定时任务。它和应用自身的自动化是两层不同的机制：

| 层 | 运行位置 | 触发方式 | 负责什么 |
| --- | --- | --- | --- |
| 应用内自动化 | 本地 Node 服务 | 服务启动后每 5 分钟巡检 | 收件箱、到期、对账、评估、复盘草稿、通知去重 |
| Codex 定时任务 | Codex 桌面端 | 按 cron 时间触发 | 判断、复核、生成提醒、处理 Codex 判断队列 |

应用内自动化不依赖 Codex 是否打开；Codex 定时任务需要 Codex 桌面端在本机运行。

自动化 cycle 在独立 worker 中运行，主进程持有硬超时、防重入、终止和中断恢复边界。手动运行、交易写后评估和后台定时巡检共用同一 runner。

本机任务 `a` 自2026-11-11起为 `PAUSED`，其余任务配置保持原状，模型和推理档位见下表。

## 1. 任务清单

时区统一为 `Asia/Shanghai`。工作目录统一为项目根目录，当前机器是 `D:\codex\钱多多财富工作台`；换机器时替换为实际路径。

| ID（本机） | 名称 | 时间 | RRULE | 模型 | Reasoning | 执行环境 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `a` | 钱多多A股收盘每日简报 | 每天 18:00 | `RRULE:FREQ=DAILY;BYHOUR=18;BYMINUTE=0;BYSECOND=0` | `gpt-6.1-sol` | `medium` | `local` | `PAUSED` |
| `r2` | R2产品快照每周更新 | 每周一 08:30 | `RRULE:FREQ=WEEKLY;BYHOUR=8;BYMINUTE=30;BYDAY=MO` | `gpt-6-luna` | `medium` | `local` | `ACTIVE` |
| `r2-2` | 钱多多R2工作日巡检（含AI队列与消息中心） | 周一至周五 21:00，法定节假日跳过 | `RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=21;BYMINUTE=0;BYSECOND=0` | `gpt-6.1-sol` | `high` | `local` | `ACTIVE` |
| `r2-3` | 钱多多R2周五结构巡检 | 每周五 18:30 | `RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=30;BYSECOND=0` | `gpt-6.1-terra` | `medium` | `local` | `ACTIVE` |
| `r2-4` | 钱多多R2样本外观察 | 每周一 08:45 | `RRULE:FREQ=WEEKLY;BYHOUR=8;BYMINUTE=45;BYDAY=MO` | `gpt-6-luna` | `high` | `local` | `ACTIVE` |

> `ID` 是当前机器上 `%USERPROFILE%\.codex\automations\<id>\automation.toml` 的目录名。新建任务时 Codex 可能生成不同的 ID，**以任务名称、时间、提示词和运行配置为准**，不要为了复刻 ID 去手工改 Codex 内部目录。
>
> 可按使用习惯设置任务结果的自动归档。

运行依赖：

| 任务 | 依赖 |
| --- | --- |
| `a` | Codex 桌面端运行、可访问交易所/官方公告和行情来源、Node.js 24+、本地生产服务用于健康检查 |
| `r2` | Node.js 24+、可访问招行公开接口、本地服务用于 `/api/products/refresh` |
| `r2-2` | 本地服务 `http://127.0.0.1:8765` 正在运行，SQLite 中可能已有 Codex 判断任务 |
| `r2-3` | 本地服务 `http://127.0.0.1:8765` 正在运行 |
| `r2-4` | `r2` 周快照任务已生成最新 universe CSV；本地工作区含冻结观察规格和 cohort |

## 2. 每个任务做什么

### `a` — 钱多多A股收盘每日简报（已暂停）

每日市场简报入口为 `/investment/briefs`，按需读取投资科学公开 API，不调用 Serenity，也不再自行采集、整理或生成日报。日期来自源站 `/api/daily-market-analyses/dates`；正文来自 `/api/daily-market-analyses/YYYY-MM-DD` 的 `analyses`，支持早盘（morning_brief）、午盘（midday_brief）、收盘（market_overview），默认最新日期的收盘分析，可用 `?date=YYYY-MM-DD&period=midday_brief` 深链定位。正文保持源站 Markdown 内容，通过 DOMPurify 安全渲染；标注来源和北京时间发布时间，未发布或接口失败明确显示并允许重试，不用旧本地稿伪装成功。后端固定主机转发，不携带 Cookie 或凭证，仅短时内存缓存，不写账本或研究报告。Codex 任务 `a` 已暂停；`market-briefs/*.md` 保留为历史归档，原八章模板只约束历史手工稿，不约束接口原文。简报不进入报告清单、独立报告库或 GitHub Pages。

### `r2` — R2产品快照每周更新

- 运行 `scripts/fetch-cmb-r2-all.cjs`，拉取招行公开 R2 产品池；新增日开目标固定为 0%，旧版 target3 的历史基线为短期 30% / 中期 35% / 长期 35%；
- 生成 `cmb_r2_all-*.csv`、`cmb_r2_universe-*.csv`、`cmb_r2_selected-*.csv`；
- 调用本地 `/api/products/refresh` 让应用使用新快照；
- 检查 `/api/dashboard/products` 的 `meta.product_csv`、`products.all.length`、`products.stats.evidence_counts`、`products.stats.observation_ready`、`products.watchlist.length` 和 `products.allocation.allocation_policy.evidence_caps`；
- 输出数据日期、数量、期限桶分布（`1–30 / 31–100 / 101+`）、五档证据数量、期限调整参考年化/原始 1Y/3M 变化和精选代码；缺 1Y 与仅 3M 档为 10%/20%，仅 1M 不自动配置。

### `r2-4` — 钱多多R2样本外观察

- 在周一产品快照后运行 `npm run yield:observe -- --json` 和 `npm run yield:observe:review -- --json`；
- 使用冻结的 `td-yield-002-observation-spec.json` 与固定 689 只产品 cohort，不扩池、不替换代码、不修改阈值；
- 同一产品数据日幂等，只有间隔 5–10 天且质量闸门通过的快照才追加为独立周样本；
- 少于 4 个样本保持 `collecting` 并静默；4–7 个无触发时继续收集；达到 4 个且触发异常或达到 8 个里程碑时进入 `review_required`，先写消息中心再发短卡；
- 超过 5–10 天窗口进入 `cadence_broken`，重复/质量/哈希异常进入 `ledger_invalid`；两者都必须报告，不能静默、回填或自行重置基线；
- 分析 short 前 5% 集中度、单一窗口高分、前后三/前十稳定、换手、不可计算比例、31/101 边界和 `667828A`；
- 披露收益只作前向代理；真实经济结果不足时不改正式权重。

提示词：[r2-out-of-sample.md](r2-out-of-sample.md)

### `r2-2` — 钱多多R2工作日巡检（含AI队列与消息中心）

- 初筛已启用，`r2-2` 从 `GET /api/r2-screening/status` 只读检查批次及证据时效，异常附站内链接。初筛刷新由工作台调度。
- 周一至周五 21:00 运行；周六、周日由 RRULE 排除，周一至周五先按 `Asia/Shanghai` 用国务院办公厅当前年度安排或中国政府网正式通知核验法定节假日，放假日静默退出，不调用 API、不刷新投影、不写消息、不发卡片；
- 节后首个工作日按账本当前累计状态照常巡检，不追补周末调休上班日；通过运行日闸门后先调用 `POST /api/dashboard/refresh`，再读取 `/api/dashboard`、`/api/review/workspace`、`/api/automation/workspace`；
- 第 0 步处理 Codex 判断队列：`screenshot_review`、`income_screenshot_review`、`evaluation_review`、`monthly_summary`、`quarterly_summary`；
- 第 1–8 步巡检账户收益、逐产品收益档案与账户/产品对账、待确认交易、收件箱、交易对账、到期、现有日开迁移事实、自动评估、复盘节点和服务状态；替换候选写明证据档位、缺失周期与单只 10% 执行闸门；
- 月度复盘中读取预测校准结果，区分命中、未命中、失效、待验证和未执行；数据不足或未执行不得计入命中率；
- 读取 `decision_proposals`：待采纳提案只提醒用户本人决定，已采纳提案只提醒用户自行执行；不得代替用户采纳、拒绝或取消；
- 平台在可分配资金或可执行换仓出现时生成决策提案；用户本人采纳/拒绝并自行交易。上传截图后，应用自动匹配已采纳提案、审计偏差、更新执行状态并继续评估；
- 优先读取 `/api/inbox`；常规事项已在消息中心去重，只有用户补事实或最后确认的例外才进入用户消息；
- 需要用户补事实或最后确认的事项必须先通过 `POST /api/inbox/confirmations` 写入应用消息中心，使用确定性 `dedupe_key` 防重复并返回站内深链；临时桥接本金还要附带结构化金额、转入/转出日期、目标本金和决策 ID；逐产品收益待补要附带 `metadata.product_income_requirement={product_code,yield_date}`，但若 `/api/inbox` 已存在同一 `product_valuation_reconciliation` 事项，只引用现有记录，不再写入重复项；事实、明确 0 元或覆盖区间确认后自动关闭；Codex 卡片只作摘要；
- 收益提醒按 `/api/dashboard` 的 `meta.reporting_date` 检查；该日期由当前持仓最大 `yield_lag_days` 推算，没有持仓时才回退昨日。用户提供的实际收益日期允许不晚于今天；不得用产品 T+1/T+2 延迟拒绝或改写日期。同日期同金额视为已记录，不同金额只提醒、不覆盖；
- 日期和至少一条产品明细明确时，归档产品事实并按当日产品合计创建或更新账户总账；截图账户金额只作可选核对。`product_valuation_reconciliation` 的 `waiting` 表示最大 T+N 尚未完成，最终披露日当天仍等待、次日仍缺才转为 `missing-product-details`；连续日期且缺口集合相同的消息合并为日期区间，已见产品进入汇总且后续到账自动重算，不要求用户补账户总额。覆盖区间只消除来源缺口，金额仍归最后披露日，不向前几日补 0、均分或复制。`same_day_redeemed_product_codes` 只提示确认赎回日收益归属，不得直接定性漏记；投影完整性异常才进入系统修复。`matched` 或覆盖区间确认后自动关闭，`missing-account-total` 已退役，0 元只有在用户或银行页面明确确认时记录；
- 通过运行日闸门后每轮都输出一张不超过 10 行的巡检卡，并在最终回复正文明确报告结果；无需用户处理时写“巡检完成，暂无需要你处理的事项”，简述服务、收益披露/对账和队列结果。既有低置信度评估和正常披露等待不计为用户待办，不为例行结果新增消息中心事项；不得代替用户采纳、拒绝或取消决策提案；
- 只维护账本事实和流程，不写投资建议、不做收益预测。

提示词：[r2-daily-review.md](r2-daily-review.md)

### `r2-3` — 钱多多R2周五结构巡检

- 每周五 18:30 先调用 `POST /api/dashboard/refresh`，再检查本周记录完整度、逐产品个人表现、账户/产品对账、持仓结构（评分桶 1–30 与流动性子集 7–30 分开）、逐只替代复核、单只/期限桶结构、发行方展示、现有日开迁移、到期阶梯、产品事件、交易对账和下周安排；
- 逐只替代复核读取 `workspace.holding_reviews`，输出继续持有/观察/建议替换、期限调整参考年化、`yield_status/yield_reason`、证据档位、比较期限、切换等待及其 `verified/estimated` 状态、有效计息、费用、复利盈亏平衡、数据缺口和验证日；6M/3M 候选执行单只 10%、同类合计 20%，估算值必须标“估算”，不能当作已核验事实；
- 逐产品个人收益同时驱动账户日总账，但周卡只把逐产品表现作为持有体验与下钻证据；短样本不换算稳定年化，不重复累加金额；
- 读取 `decision_proposals`，报告待采纳和待执行方案；不得代替用户采纳、拒绝或取消；
- 读取 `GET /api/calibration/monthly?month=YYYY-MM`，把到复核日的预测命中、未命中、待验证、失效和误差来源纳入周卡；待验证和未执行不计入命中率；
- 需要用户补事实或最后确认的事项必须先通过 `POST /api/inbox/confirmations` 写入消息中心，使用确定性 `dedupe_key` 防重复；临时桥接本金提醒必须附带结构化金额、转入/转出日期、目标本金和决策 ID；逐产品收益待补要附带 `metadata.product_income_requirement={product_code,yield_date}`；周卡只作摘要；
- 只在存在结构风险、待办或下周动作时发周卡；
- 不把历史年化当作未来收益，不把巡检正常写成“没有风险”；替换建议不等于买入指令，执行前仍需核对额度与赎回规则。

提示词：[r2-weekly-structure.md](r2-weekly-structure.md)

## 3. 在另一台机器上创建

### 3.1 前提

1. 已安装并登录 Codex 桌面端；
2. 已在 Codex 中打开本项目工作区，项目出现在项目列表中；
3. 本地应用能启动，`http://127.0.0.1:8765/api/health` 返回 200；
4. 已安装 `r2-wealth-management`、`serenity-skill` 两个 skill；
5. 系统时区或 Codex 调度时区为 `Asia/Shanghai`。

### 3.2 创建步骤

1. 打开 Codex 的 Automations（定时任务）页面；
2. 新建一个 cron 任务；
3. 按上面的任务表填写名称、时间、模型和 reasoning；
4. 执行环境选 `local`；
5. 目标项目选本项目，工作目录设为项目根目录；
6. 从对应的 `.md` 文件复制提示词，替换 `<WORKSPACE>` 等占位符；
7. 保存并启用；
8. 先手动运行一次，确认能读到本地 API，再等下一次定时触发。

如果账号无法使用表中的模型，选择支持工具调用且能力相近的模型，按该任务配置相应推理档位。

### 3.3 替换占位符

| 占位符 | 当前机器值 | 说明 |
| --- | --- | --- |
| `<WORKSPACE>` | `D:\codex\钱多多财富工作台` | 项目根目录，必须是绝对路径 |
| `<LOCAL_URL>` | `http://127.0.0.1:8765` | 本地生产服务地址 |
| `<NODE_EXE>` | `C:\Program Files\nodejs\node.exe` 或 Codex 运行时 node | Node.js 24+ 可执行文件 |
| `<NODE_PATH>` | Codex 运行时的 `node_modules` 目录 | 只在自动化 shell 找不到依赖时需要 |

## 4. 验证

### 4.1 服务

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/api/health
```

应返回 HTTP 200。

### 4.2 应用设置

```powershell
(Invoke-RestMethod http://127.0.0.1:8765/api/automation/workspace).settings
```

对照 `SETUP.md` 的“应用初始化设置”表。

### 4.3 产品快照

```powershell
Get-ChildItem data\cmb_r2_universe-*.csv | Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

应能看到最新日期的候选池文件。

### 4.4 任务本身

- `r2`：手动运行后检查 `data/` 是否生成当天 CSV，`/api/dashboard/products` 是否切换快照，五档 `evidence_counts` 与 6M/3M 的 10%/20% 上限是否存在；
- `r2-2`：最近披露收益按最大 T+N 推算的 `meta.reporting_date` 检查，逐产品看 `product_valuation_reconciliation` 与 `product_valuation_disclosure_policy`；`waiting` 不写消息中心事项，最终披露日次日仍缺、且未被覆盖区间消除的产品才提示。应用消息中心已按连续日期和相同缺口聚合，Codex 不重复建卡；已见产品驱动账户总账，投影完整性异常才单独提示。产品-only 截图就是账户总账来源；替换候选应显示期限调整参考年化、`yield_status/yield_reason`、证据档位和短历史单只上限；通过运行日闸门后每轮只发一张不超过 10 行的巡检卡（含队列处理结果），无需用户处理也在正文明确说明，不能只有收件箱指令；周末和法定放假日仍静默跳过；
- `r2-3`：逐产品个人表现只作观察证据，替换候选应显示证据档位与 10%/20% 限制；账户/产品对账只报最终状态，等待到账保持安静；没有结构风险、最终对账异常或下周动作时应该“无消息”，有内容时只发一张周卡。

## 5. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 任务到点没跑 | Codex 桌面端未运行，或任务被暂停 | 打开 Codex，检查任务状态 |
| 任务跑了但读不到数据 | 本地服务 `8765` 未启动 | `npm run prod:start` 或双击 `start.bat` |
| 提示项目不存在 | 工作区没有在 Codex 中打开，或路径变了 | 重新打开项目，更新任务的 working directory |
| 提示模型不存在 | 换了账号或模型目录 | 按任务配置表选择能力相近的模型和对应推理档位 |
| 周报读不到产品快照 | 最新 `cmb_r2_universe-*.csv` 未生成或应用未刷新 | 检查 `r2` 任务、`data/` 快照和 `/api/dashboard` 的 `meta.product_csv` |
| 任务重复发消息 | 应用通知未去重，或手动运行+定时运行叠加 | 检查 `/api/automation/workspace` 的 notifications 和 runs |
| 任务改了不该改的数据 | 提示词边界被忽略 | 暂停任务，恢复原状态，重新粘贴完整提示词 |

## 6. 不要直接复制的内容

不要把他人的 `.codex/automations` 目录原样复制到新机器：

- `project_id` 是 Codex 为本机项目生成的，不能跨机器复用；
- `cwds` 是绝对路径，换目录会失效；
- `created_at` / `updated_at` 是本机时间戳；
- 模型名可能因账号不同而不可用；
- Codex 的内部配置格式可能随版本变化。

推荐用 Codex UI 创建，再把提示词粘贴进去。下面的 TOML 只用于理解字段，不建议手工覆盖：

```toml
version = 1
id = "<本机自动生成>"
kind = "cron"
name = "<任务名称>"
prompt = """<从对应 .md 文件复制>"""
status = "ACTIVE"
rrule = "<RRULE>"
model = "<模型名>"
reasoning_effort = "<任务推理档位>"
execution_environment = "local"
target = { type = "project", project_id = "<本机项目 ID>" }
cwds = ["<WORKSPACE>"]
```

## 7. DSH 侧镜像（方案 B，可选）

DSH 原生定时任务是会话级提醒：绑定创建它的会话，每次触发只向原会话追加提醒消息，不支持「每次新会话运行」，也没有暂停态。要在 DSH 里得到接近 Codex 的定时执行，用「专用会话 + 每轮新子代理」：专用会话里放 5 条提醒，每条只派发 `subagent`（不用 `subagent_fork`），业务仍由 `codex-automations/*.md` 的提示词驱动。

- 安装步骤与逐条 prompt：`codex-automations/dsh-reminder-setup.md`。
- 提醒只能绑定创建它的会话，安装清单必须在新会话里执行。
- 与 Codex 同时启用会重复执行（发卡、发布、提交），先停掉其中一边。
- 桌面端关闭时不执行，重开只补最近一次漏触发；提醒激活期间该会话不能归档。
- **运行状态**：任务 `a` 已暂停，不再创建其 DSH 镜像；其他任务以本机任务清单和客户端实际状态为准。

## 8. 当前环境快照

截至 2026-11-01：

| 项目 | 当前值 |
| --- | --- |
| 工作区 | `D:\codex\钱多多财富工作台` |
| 本地服务 | `http://127.0.0.1:8765` |
| 时区 | `Asia/Shanghai` |
| Codex 定时任务 | 运行配置见本页任务清单 |
| R2 巡检节奏 | `r2-2` 周一至周五 21:00；法定节假日静默跳过 |
| 生产守护 | Supervisor 运行中，Health OK |
| 独立托管 | 当前用户计划任务 `QianDuoDuo-Production`，仅登录触发一次并通过隐藏 WScript 拉起 Supervisor；无分钟巡检，`prod:stop` 通过持久停止意图隔离 |
| 应用自动化 | 目标 3.0%，短/中/长 hurdle 2.5/2.8/3.0%，单只上限 30%，短期桶下限 30%，新增日开 0%，置信度 75%，巡检 5 分钟；包含逐产品收益对账和现有日开迁移提示 |

这份快照会随环境变化；分享项目时以 `SETUP.md` 的步骤为准，不要把快照当成永久配置。

## 2026-11-08 策略执行入口

<!-- r2-strategy-acceptance-2026-11-08 -->
v9 统一执行层巡检：通过原有运行日闸门后读取 GET /api/r2-strategy/status 与 GET /api/r2-strategy/workspace。mode=v9 时以该工作区的 allocation、monitoring、selected_reviews 及 stale 为当前策略依据，旧 dashboard.holding_reviews 和 CSV 仅作 legacy 历史观察。stale=true、结果缺失或接口不可用时标注待重算/待核，不退回旧算法生成当前建议，不调用策略重算、初筛刷新或自动采纳。低于有效同份额近1月年化2.15%时区分立即可退出与锁定到期退出意图；售罄、未入前三不构成强制退出。证据待核、预留/在途资金和约束冲突按当前状态解释，已有消息只引用不重复创建。入口为 /ledger/products?section=allocation、/ledger/products?section=holdings 和 /ledger/evaluation?section=proposals。历史决策按冻结版本评价，周快照与样本外观察仍沿用原独立规则，不切换生产模式。

### v9 流动性配置

当前建议以 GET /api/r2-strategy/workspace 为准。使用 contract.bucket_caps_pct 读取中期、长期上限，使用 result.allocation.bucket_limits 读取实际策略占用和超限，字段缺失标记待更新。现金需求以 cash_needs 的付款日为准，旧区间末日标注估算。过期、契约不匹配、缺结果或接口异常时标注待核。当前配置与持仓动作仅使用 v9 工作区，CSV 与样本外结果标明各自的证据和冻结版本。r2-2、r2-3 原运行日闸门和财务事实巡检继续适用。
