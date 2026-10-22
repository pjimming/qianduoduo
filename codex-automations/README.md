# Codex 定时任务

这里记录钱多多工作区使用的 Codex 桌面端定时任务。它和应用自身的自动化是两层不同的机制：

| 层 | 运行位置 | 触发方式 | 负责什么 |
| --- | --- | --- | --- |
| 应用内自动化 | 本地 Node 服务 | 服务启动后每 5 分钟巡检 | 收件箱、到期、对账、评估、复盘草稿、通知去重 |
| Codex 定时任务 | Codex 桌面端 | 按 cron 时间触发 | 判断、复核、生成提醒、处理 Codex 判断队列 |

应用内自动化不依赖 Codex 是否打开；Codex 定时任务需要 Codex 桌面端在本机运行。

## 1. 任务清单

时区统一为 `Asia/Shanghai`。工作目录统一为项目根目录，当前机器是 `D:\codex\钱多多财富工作台`；换机器时替换为实际路径。

| ID（本机） | 名称 | 时间 | RRULE | 模型 | Reasoning | 执行环境 | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `r2` | R2产品快照每周更新 | 每周一 08:30 | `RRULE:FREQ=WEEKLY;BYHOUR=8;BYMINUTE=30;BYDAY=MO` | `deepseek-flash` | `high` | `local` | `ACTIVE` |
| `r2-2` | 钱多多R2每日巡检（含AI队列与消息中心） | 每天 21:00 | `RRULE:FREQ=DAILY;BYHOUR=21;BYMINUTE=0;BYSECOND=0` | `deepseek-flash` | `high` | `local` | `ACTIVE` |
| `r2-3` | 钱多多R2周五结构巡检 | 每周五 18:30 | `RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=30;BYSECOND=0` | `deepseek-flash` | `high` | `local` | `ACTIVE` |

> `ID` 是当前机器上 `%USERPROFILE%\.codex\automations\<id>\automation.toml` 的目录名。新建任务时 Codex 可能生成不同的 ID，**以任务名称、时间、提示词和运行配置为准**，不要为了复刻 ID 去手工改 Codex 内部目录。
>
> `r2` 任务当前开启了 `auto_archive`，用于避免每周任务占满列表；它不影响任务逻辑，新环境可按自己的习惯设置。

运行依赖：

| 任务 | 依赖 |
| --- | --- |
| `r2` | Node.js 24+、可访问招行公开接口、本地服务用于 `/api/products/refresh` |
| `r2-2` | 本地服务 `http://127.0.0.1:8765` 正在运行，SQLite 中可能已有 Codex 判断任务 |
| `r2-3` | 本地服务 `http://127.0.0.1:8765` 正在运行 |

## 2. 每个任务做什么

### `r2` — R2产品快照每周更新

- 运行 `scripts/fetch-cmb-r2-all.cjs`，拉取招行公开 R2 产品池；新增日开目标固定为 0%，target3 固定为短期 30% / 中期 35% / 长期 35%；
- 生成 `cmb_r2_all-*.csv`、`cmb_r2_universe-*.csv`、`cmb_r2_selected-*.csv`；
- 调用本地 `/api/products/refresh` 让应用使用新快照；
- 检查 `/api/dashboard` 的 `meta.product_csv`、`products.all.length`、`products.watchlist.length`；
- 输出数据日期、数量、期限桶分布、1Y/3M 变化和精选代码。

提示词：[r2-product-snapshot.md](r2-product-snapshot.md)

### `r2-2` — 钱多多R2每日巡检（含AI队列与消息中心）

- 每天 21:00 读取 `/api/dashboard`、`/api/review/workspace`、`/api/automation/workspace`；
- 第 0 步处理 Codex 判断队列：`screenshot_review`、`income_screenshot_review`、`evaluation_review`、`monthly_summary`、`quarterly_summary`；
- 第 1–8 步巡检账户收益、逐产品收益档案与账户/产品对账、待确认交易、收件箱、交易对账、到期、现有日开迁移事实、自动评估、复盘节点和服务状态；
- 读取 `decision_proposals`：待采纳提案只提醒用户本人决定，已采纳提案只提醒用户自行执行；不得代替用户采纳、拒绝或取消；
- 平台在可分配资金或可执行换仓出现时生成决策提案；用户本人采纳/拒绝并自行交易。上传截图后，应用自动匹配已采纳提案、审计偏差、更新执行状态并继续评估；
- 优先读取 `/api/inbox`；常规事项已在消息中心去重，只有用户补事实或最后确认的例外才进入用户消息；
- 需要用户补事实或最后确认的事项必须先通过 `POST /api/inbox/confirmations` 写入应用消息中心，使用确定性 `dedupe_key` 防重复并返回站内深链；Codex 卡片只作摘要；
- 收益提醒按 `/api/dashboard` 的 `meta.reporting_date`（通常为昨日）检查，但用户提供的实际收益日期允许不晚于今天；不得用产品 T+1/T+2 延迟拒绝或改写日期。同日期同金额视为已记录，不同金额只提醒、不覆盖；
- 产品明细缺失只标记“本次未拍到”，不得自行推断为 0、不判定赎回；用户或银行页面明确确认 0 元时必须记录为有效收益；产品合计与账户总账差异只提示核对，不覆盖任何一侧；
- 没有异常、没有待办时保持安静，不发送“今日无异常”；不得代替用户采纳、拒绝或取消决策提案；
- 只维护账本事实和流程，不写投资建议、不做收益预测。

提示词：[r2-daily-review.md](r2-daily-review.md)

### `r2-3` — 钱多多R2周五结构巡检

- 每周五 18:30 检查本周记录完整度、逐产品个人表现、账户/产品对账、持仓结构、逐只替代复核、集中度、短期桶流动性、现有日开迁移、到期阶梯、产品事件、交易对账和下周安排；
- 逐只替代复核读取 `workspace.holding_reviews`，输出继续持有/观察/建议替换、比较期限、切换等待及其 `verified/estimated` 状态、有效计息、费用、复利盈亏平衡、数据缺口和验证日；估算值必须标“估算”，不能当作已核验事实；
- 逐产品个人收益只作观察证据；短样本不换算稳定年化，产品收益不重复计入账户总收益；
- 读取 `decision_proposals`，报告待采纳和待执行方案；不得代替用户采纳、拒绝或取消；
- 需要用户补事实或最后确认的事项必须先通过 `POST /api/inbox/confirmations` 写入消息中心，使用确定性 `dedupe_key` 防重复；周卡只作摘要；
- 只在存在结构风险、待办或下周动作时发周卡；
- 不把历史年化当作未来收益，不把巡检正常写成“没有风险”；替换建议不等于买入指令，执行前仍需核对额度与赎回规则。

提示词：[r2-weekly-structure.md](r2-weekly-structure.md)

## 3. 在另一台机器上创建

### 3.1 前提

1. 已安装并登录 Codex 桌面端；
2. 已在 Codex 中打开本项目工作区，项目出现在项目列表中；
3. 本地应用能启动，`http://127.0.0.1:8765/api/health` 返回 200；
4. 已安装 `r2-wealth-management`、`serenity-skill`、`equity-research` 三个 skill；
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

如果你的 Codex 没有 `deepseek-flash`，选择同等能力、支持工具调用的模型，并把 reasoning 设为 `high`。模型名是当前环境快照，不是项目的硬依赖。

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

- `r2`：手动运行后检查 `data/` 是否生成当天 CSV，`/api/dashboard` 是否切换快照；
- `r2-2`：最近披露收益按 `meta.reporting_date` 检查，逐产品看 `product_valuation_reconciliation` 与“本次未拍到”，今日未披露不计异常；没有其他异常或待办时应“无消息”，有内容时只发一张不超过 10 行的巡检卡（含队列处理结果）；
- `r2-3`：逐产品个人表现只作观察证据，没有结构风险、产品对账异常或下周动作时应该“无消息”，有内容时只发一张周卡。

## 5. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 任务到点没跑 | Codex 桌面端未运行，或任务被暂停 | 打开 Codex，检查任务状态 |
| 任务跑了但读不到数据 | 本地服务 `8765` 未启动 | `npm run prod:start` 或双击 `start.bat` |
| 提示项目不存在 | 工作区没有在 Codex 中打开，或路径变了 | 重新打开项目，更新任务的 working directory |
| 提示模型不存在 | 换了账号或模型目录 | 选择同等能力模型，保持 high reasoning |
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
reasoning_effort = "high"
execution_environment = "local"
target = { type = "project", project_id = "<本机项目 ID>" }
cwds = ["<WORKSPACE>"]
```

## 7. 当前环境快照

截至 2026-10-21：

| 项目 | 当前值 |
| --- | --- |
| 工作区 | `D:\codex\钱多多财富工作台` |
| 本地服务 | `http://127.0.0.1:8765` |
| 时区 | `Asia/Shanghai` |
| Codex 定时任务 | 3 个，全部 `ACTIVE`、`deepseek-flash`、`local` |
| 生产守护 | Supervisor 运行中，Health OK |
| Windows 看门狗任务 | `QianDuoDuo-Production` 未安装 |
| 应用自动化 | 目标 3.0%，短/中/长 hurdle 2.5/2.8/3.0%，单只上限 30%，短期桶下限 30%，新增日开 0%，置信度 75%，巡检 5 分钟；包含逐产品收益对账和现有日开迁移提示 |

这份快照会随环境变化；分享项目时以 `SETUP.md` 的步骤为准，不要把快照当成永久配置。
