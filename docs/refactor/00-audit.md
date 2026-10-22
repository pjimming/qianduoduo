# 阶段 0：钱多多后端架构审计

## 1. 审计结论

**审计日期**：2026-10-22（Asia/Shanghai）  
**源码基线**：`main` 分支，提交 `b41dbc9`，审计开始时工作区干净，`main...origin/main` 无未提交修改。  
**运行环境**：Node.js `v24.20.0`，使用内置 `node:sqlite`、CommonJS 与 Windows PowerShell 启动脚本。  
**数据库基线**：只读打开 `data/r2_ledger.sqlite`；SQLite `PRAGMA quick_check` 为 `ok`，`user_version` 为 `0`，实际有 28 张业务表、0 个触发器、未定义外键。  
**测试基线**：执行 `node --test`，157 个测试全部通过；执行 `node --experimental-test-coverage --test`，整体行覆盖率 87.92%、分支覆盖率 73.62%、函数覆盖率 90.92%。

当前系统是一个可运行的**单进程模块化雏形**，不是完全没有分层的单体：

- `lib/` 已按交易、收益、产品、复盘、自动化等业务域拆出 store 和若干纯计算模块。
- 交易、持仓、产品收益、评估等关键表已有部分唯一约束、审计表和幂等键。
- 测试覆盖明显高于一般个人项目，核心交易批次、产品收益、决策提案和自动评估已有回归保护。

但当前仍存在四个结构性事实：

1. `server.js` 是一个 3,557 行的组合层，同时包含 HTTP 路由、输入校验、业务编排、SQL 调用、OCR 流程、报告导出、静态文件、定时任务和进程生命周期。
2. `lib/db.js` 不是单纯数据库连接层，而是全局组装器、账本/本金 repository、产品 repository、收益截图业务编排和多个 store 的兼容门面。
3. 多数 store 同时承担 repository、domain service、工作流编排和跨模块查询；`dashboardPayload()` 还会在 GET 请求中触发写入。
4. 若干跨表业务没有统一事务边界，特别是“收益截图 → 产品收益 → 账户收益 → 收件箱状态”和“评估结果 → 决策 → 任务/提醒”。

因此，目标应是把现有能力迁移到**模块化单体**，而不是换框架、换数据库或按文件长度机械拆分。

## 2. 真实运行与部署入口

| 场景 | 入口 | 行为 |
| --- | --- | --- |
| 生产/日常 | `start.bat` | 构建前端后执行 `node server.js`；若 8765 已有健康服务则直接打开页面 |
| npm 服务 | `npm run server` | `node --no-warnings server.js` |
| npm 一键启动 | `npm start` | 先 `npm run build`，再启动 `server.js` |
| 开发 | `npm run dev:all` | `scripts/dev.js` 启动 `node --watch server.js` 与 Vite，Vite 代理 `/api` |
| 生产守护 | `scripts/daemon.ps1` | 启动/监控 Node 子进程，写 PID 和 stdout/stderr 日志；异常退出按 2–60 秒退避重启 |
| 部署 | `scripts/deploy-production.ps1` | 构建、测试、停止旧守护进程、安装计划任务/启动项、启动并健康检查 |
| 数据库备份/恢复 | `scripts/db.mjs` | `list`、`backup`、`restore`；恢复前要求健康检查不可达 |

`startServer()` 是唯一真正的后端启动函数：

1. `openDatabase()` 初始化表、迁移和 store。
2. 创建当天备份并清理旧备份。
3. 清理超过 180 天的已处理成交截图。
4. 注册启动自动评估与 60 秒轮询定时器。
5. 调用 `createServer({ repository })` 启动 HTTP 服务。
6. 注册 `SIGINT`/`SIGTERM`，关闭定时器、HTTP Server 与数据库。

`createServer()` 接受已打开的 `repository`，因此测试可以监听临时端口并使用临时数据库。

## 3. 当前实际目录与职责

```text
server.js
  HTTP 入口、路由、校验、流程编排、导出、静态文件、启动与关闭

lib/
  db.js                      数据库连接 + 全局仓库门面 + 账本/本金/产品/收益截图编排
  trade-store.js             交易、批次匹配、持仓推导、交易收件箱、审计
  review-store.js            决策、旧持仓、持仓复核设置、产品事件、月/季笔记
  income-store.js            收益截图文件与收件箱表
  income-parser.js           收益截图文本解析与产品拆分
  product-valuation-store.js 逐产品收益、收益延迟、对账、修正审计
  automation-store.js        自动评估、复盘草稿、通知、任务、自动化运行
  decision-proposal-store.js 决策提案、执行状态匹配与偏差审计
  inbox-center.js            跨域消息中心聚合与状态
  metrics.js                 收益记录派生指标、复盘统计、日期工具
  products.js                产品 CSV、候选排序、配置与资金分配
  holdings-review.js         持仓替换/继续持有分析
  r2-policy.js               固定策略常量与期限桶规则
  trade-parser.js            成交截图文本解析
  ocr.js                     Windows OCR 子进程适配
  backup.js                  SQLite `VACUUM INTO` 备份

test/
  27 个 `*.test.js` / `*.test.mjs` 文件，当前 157 个测试

scripts/
  dev.js、daemon.ps1、db.mjs、e2e-smoke.mjs
  报告生成/同步/发布脚本
```

核心文件实际行数：

| 文件 | 行数 |
| --- | ---: |
| `server.js` | 3,557 |
| `lib/automation-store.js` | 2,647 |
| `lib/trade-store.js` | 1,292 |
| `lib/db.js` | 1,213 |
| `lib/review-store.js` | 1,166 |
| `lib/products.js` | 924 |
| `lib/decision-proposal-store.js` | 904 |
| `lib/product-valuation-store.js` | 844 |
| `lib/metrics.js` | 841 |
| `lib/inbox-center.js` | 829 |
| `lib/holdings-review.js` | 811 |

行数只作为定位证据，不被当作缺陷本身。

## 4. `server.js` 的真实职责

`server.js` 可以分成以下区段：

| 区段 | 代表源码 | 职责 |
| --- | --- | --- |
| 配置与常量 | 第 1–130 行附近 | 目录、默认数据库、策略枚举、MIME、安全头、产品 CSV 发现 |
| HTTP 基础设施 | 第 133–207 行附近 | JSON 响应、错误响应、请求体读取、同源写入保护 |
| 输入校验/错误转换 | 第 208–848 行附近 | 记录、本金、决策、持仓、事件、交易、收件箱、图片、复盘笔记 |
| 导出与格式化 | 第 849–1102 行附近 | CSV、Markdown、金额/百分比格式化 |
| 跨域业务编排 | 第 1103–1261 行附近 | 交易后同步决策/评估、完整 dashboard 聚合 |
| 静态文件 | 第 1262–1329 行附近 | SPA fallback、缓存、gzip、CSP、路径穿越防护 |
| 全部 HTTP 路由 | 第 1330–3454 行附近 | 直接校验、调用 repository/store、拼装响应 |
| 启动/定时/关闭 | 第 3455–3557 行附近 | 打开数据库、备份、截图清理、自动评估、监听和信号处理 |

`createServer()` 内部存在约 66 个 `pathname` 条件分支。展开同一正则上的不同动作和 HTTP 方法后，当前 API 覆盖健康检查、备份、本金、产品、交易、交易收件箱、收益、逐产品收益、决策、提案、评估、复盘、通知和消息中心。

## 5. 核心业务边界（从现有代码提取）

### 5.1 本金

- `capital_settings` 保存初始本金和起始日。
- `capital_events` 只保存转入/转出。
- 某日本金由“初始本金 + 当日及之前的转入 – 转出”计算。
- `daily_records.principal` 是该日本金快照，不是自由现金余额。
- 调整本金起始值或资金事件时，会重算所有 `daily_records.principal`。
- 交易本身不会自动改写 `capital_settings`、`capital_events` 或 `daily_records.principal`。

### 5.2 交易与持仓

- `trade_transactions` 是持仓事实来源；旧 `holdings` 表只用于历史迁移。
- `pending` 交易不进入正式持仓。
- 只有 `confirmed` 交易参与批次匹配与持仓推导。
- 持有起点使用 `confirm_date`；没有确认日才回退 `trade_date`。
- 买入形成成本批次；赎回按同产品批次先进先出匹配；“切换”先赎回来源产品，再为来源金额/到账金额建立目标产品批次。
- `trade_allocations` 是从已确认交易重建出的派生表。
- 部分/完全赎回、编辑、确认和撤销都会重建全部 allocations。
- 旧 `/api/review/holdings` 兼容接口实际创建/修改/撤销买入交易，不再维护独立正式持仓来源。

### 5.3 收益

- `daily_records` 是账户每日总收益，每日期唯一。
- `product_daily_valuations` 是逐产品收益，按 `(product_code, yield_date)` 唯一。
- 产品收益合计与账户总收益只做对账，不自动覆盖账户总账。
- 同日期同金额视为幂等；同日期不同金额保留原值并生成消息中心确认项。
- 0 元是有效产品收益。
- 产品收益延迟用于判断“本次未拍到”是否已到正常披露时点，不用于改写用户明确提供的收益日期。
- 历史产品收益修正通过 `product_daily_valuation_audit` 留痕。

### 5.4 决策、交易、评估

- 决策可关联交易，但不是所有交易都由人工决策创建。
- 未关联决策的新交易会自动创建“待补充”决策。
- 已采纳提案可匹配后续交易，并跟踪偏差点。
- `evaluation_runs` 是评估历史；`auto/confirmed` 可写入决策，`undone` 记录撤销。
- 人工修改过的决策不能被自动评估静默覆盖。
- 自动评估的置信度低于阈值、结果不明或缺少交易/到账证据时进入待确认任务。
- 当前没有独立规则引擎；阈值、阶段、评分逻辑集中在 `automation-store.js`，固定策略常量在 `r2-policy.js`。

### 5.5 文件与外部服务

- 图片以 JSON Base64 上传，最大 10 MB。
- 成交截图保存在 `data/trade-inbox/`；收益截图保存在 `data/income-inbox/`。
- OCR 通过本机 `powershell.exe` 调 `scripts/ocr-image.ps1`，默认 25 秒超时；`R2_OCR=0` 可关闭。
- OCR 失败仍可保存收件箱记录，但不能直接产生正式交易或收益。
- 产品 CSV 从 `data/cmb_r2_universe*.csv` 取最新日期快照；可由 `R2_PRODUCT_CSV` 覆盖。
- 股票研究报告是静态文件和构建生成物，不通过账本 SQLite 存储。

## 6. 当前测试能力

### 6.1 已有覆盖

当前 `node --test` 覆盖：

- 应用 HTTP 主流程、未知输入、跨站写入拒绝、Content-Type 校验。
- 数据库初始化和旧数据迁移，包括历史本金推导。
- 每日收益幂等、冲突和手工修改。
- 交易 pending/confirmed 语义、部分赎回、切换、FIFO 批次、审计。
- 交易截图 SHA-256 去重、人工校正、视觉识别字段与 OCR 交叉校验。
- 收益截图解析、逐产品收益、0 元收益、披露延迟和对账。
- 持仓复核、候选替换、收益率门槛、费用与 T+1/T+2 估算。
- 决策提案生成、采纳、拒绝、过期、交易匹配和执行偏差。
- 自动评估、人工确认、撤销、人工结果保护、复盘草稿、通知去重。
- 备份创建、DB CLI 恢复、路径安全、静态缓存/gzip/HEAD。
- 报告清单、报告构建和科技图谱静态数据。

### 6.2 覆盖缺口

Node 覆盖率显示的重点缺口：

| 模块 | 行覆盖率 | 主要未覆盖分支 |
| --- | ---: | --- |
| `lib/ocr.js` | 46.67% | 真实子进程启动、超时、stderr/异常退出 |
| `lib/income-store.js` | 77.55% | 截图清理失败与文件/DB 半完成状态 |
| `server.js` | 80.66% | `startServer()`、定时器、关闭流程、部分低频 API |
| `lib/backup.js` | 81.43% | 旧备份清理失败 |
| `lib/db.js` | 87.30%，分支 61.19% | 部分迁移失败、收益截图异常分支、本金删除分支 |
| `lib/product-valuation-store.js` | 90.88%，分支 63.89% | 修正失败、冲突保存、对账边界 |

### 6.3 测试基础缺口

- 没有专门的 `test/unit/`、`test/integration/`、`test/fixtures/` 目录；测试平铺在 `test/`。
- 没有统一测试工厂来确保临时 DB、截图目录、端口、时钟、OCR 和日志总是一起隔离。
- 没有故障注入器来断言“文件已写但 DB 未提交”“产品收益已写但账户收益失败”等半完成状态。
- 没有真正测试 `startServer()` 的启动、并发定时任务、信号关闭、端口占用和活动 OCR 子进程终止。
- 没有异步并发测试；当前测试主要是单进程、顺序执行。
- 没有 schema snapshot、迁移版本、旧库 fixture 到最新 schema 的矩阵测试。
- 没有恢复流程的 WAL/`-shm` 一致性测试。

## 7. 高风险发现

以下问题均由源码路径可直接确认；本阶段只记录，不修复。

### P0-1 收益截图入账跨表非原子

`lib/db.js` 的 `applyIncomeScreenshot()` 依次执行：

1. `productValuationStore.upsertMany()` 在自己的事务内提交产品收益。
2. `insertRecord.run()` 写入账户每日收益。
3. `incomeStore.updateInbox()` 将截图标记为已入账。

三步没有共享事务。第 2 或第 3 步失败时，可能出现“产品收益已存在，但账户收益或收件箱状态未完成”。重试虽可继续收敛，但没有显式恢复状态机。

### P0-2 读取接口会写入派生账本

`getPortfolio()` 每次调用 `rebuildAllocations()`；后者先 `DELETE FROM trade_allocations`，再重新插入。`GET /api/dashboard`、`GET /api/trades` 都会触发该路径。该重建在独立读取时没有包裹事务，进程中断可能留下部分 allocations。

### P0-3 备份恢复的安全快照可能遗漏 WAL 数据

`scripts/db.mjs` 的恢复前快照使用 `copyFileSync(dbPath, safety)`，只复制主数据库文件。当前生产数据库处于 WAL 模式，审计时 `-wal` 文件显著大于主库；若服务被强制停止且未 checkpoint，该快照可能不包含最新事务，随后删除 `-wal` 会丢失这些事务。`daemon.ps1` 的 `prod:stop` 使用 `Stop-Process -Force`，不会等待应用优雅关闭。

### P1-1 图片保存与数据库去重不是原子操作

成交/收益截图都是先 `fs.writeFileSync()` 保存文件，再 OCR，最后插入收件箱。SHA-256 唯一约束在数据库内有效，但去重检查发生在异步 OCR 前。两个相同图片并发上传时可能都先写文件、都通过去重前检查，最终一个插入成功，另一个以数据库唯一约束异常结束，并留下孤立文件。

### P1-2 评估、提案和交易后处理存在跨表半提交

- `applyDecisionRun()` 先更新决策，再更新 evaluation run。
- `undoRun()` 先回滚决策，再标记 run 为 undone。
- `adoptProposal()` 先创建决策，再更新提案。
- `rejectProposal()` 先更新关联决策，再更新提案。
- `confirmDraft()` 先保存复盘笔记，再确认草稿、解决通知和任务。

以上均无共享事务。尤其是评估撤销：若决策已回滚但 run 状态更新失败，下一次撤销会因“决策已被手工修改”而无法继续。

### P1-3 自动运行和任务重试语义有限

- `automation_runs` 会记录运行状态，但进程中断后会永久停留在 `running`。
- 防重入只依赖内存变量 `running`；单进程内有效，跨进程没有租约。
- `automation_jobs` 没有统一重试执行器；`attempts` 只在人工 `resolveJob()` 时增加。
- `runCycle()` 失败时只标记整次运行失败，不会回滚已经完成的通知、任务、草稿或评估。

### P1-4 GET dashboard 具有业务副作用

`dashboardPayload()` 在读取过程中调用：

- `decisionProposalStore.sync(payload)`：失效提案、创建/更新提案、协调执行状态。
- `inboxCenter.sync(payload)`：创建、更新、恢复或解决消息中心项。
- `tradeStore.getPortfolio()`：重建 allocations。
- `decisionProposalStore.getWorkspace()` 和 `inboxCenter.getWorkspace()` 还可能推进 snooze 状态。

这不是纯粹的查询接口，测试和迁移如果只看 `SELECT` 会遗漏写入。

### P1-5 数据库没有外键，关键关联靠应用维护

实际数据库 0 个外键。以下关联均无数据库级完整性保证：

- `daily_records.screenshot_id -> income_inbox.id`
- `trade_transactions.screenshot_id -> trade_inbox.id`
- `trade_transactions.decision_id -> decision_log.id`
- `trade_allocations.redeem_trade_id/buy_trade_id -> trade_transactions.id`
- `evaluation_runs.decision_id/trade_id`
- `decision_proposals.decision_id`
- `product_daily_valuations.screenshot_id`

不能在阶段 1 直接加外键；历史迁移数据、删除语义和兼容 API 必须先建立约束审计。

### P1-6 日期和金额规则重复实现

- `parseYmd()` 在 8 个模块中分别实现。
- `round()` / `roundMoney()` 在 7 个模块中分别实现。
- 部分公开 service 默认使用 UTC 日期 `new Date().toISOString().slice(0, 10)`，而 HTTP 主路径使用 `todayShanghai()`。
- 金额仍使用 SQLite `REAL` 和两位/四位小数舍入；这是现有口径，不能在结构重构时擅自改成分。

### P2-1 HTTP 错误形态不完全统一

- 业务错误通常返回 `{ error }`，部分 409 还带 `code`、OCR/视觉字段或 `checks`。
- 非法 JSON 的 `Error` 未设置 `statusCode`，当前会走 500。
- 超限请求会 `request.destroy()`，客户端可能先遇到连接中断，而不是稳定读到 413 响应。
- 未捕获 500 会把底层 `error.message` 返回客户端。

阶段 1 需要先固化现状；是否改为更准确的 400/500 需要单独兼容决策。

### P2-2 后端目标目录不能沿用顶层 `src/`

顶层 `src/` 已经是 Vue 前端源码。若要采用清晰分层的后端目录，应使用 `server/`（推荐）或 `backend/`，不要与前端共用 `src/`。

## 8. 最值得优先重构的三个位置

1. **财务用例事务边界**：先建立统一的事务执行器和用例服务，优先覆盖收益截图、交易收件箱、评估写入/撤销、提案采纳/拒绝。
2. **交易与持仓只读模型**：把 allocations 重建从读取路径中移出，明确“交易命令写入 → 派生持仓刷新”的唯一入口，并保护部分赎回/切换。
3. **HTTP 与业务编排解耦**：建立 `server/app.js`、路由器、中间件和按业务域注册路由；让 `server.js` 只装配和启动。

这三个位置同时满足高风险、跨模块依赖多、迁移后能显著降低后续成本。

## 9. 本阶段边界与结论

本阶段没有修改 `server.js`、`lib/`、数据库、脚本或前端；仅完成只读检查、测试基线和 `docs/refactor/` 文档。

阶段 0 完成条件：

- [x] 实际目录、入口和运行方式已核实。
- [x] 全部 HTTP 路由和主要调用链已盘点。
- [x] 数据库表、唯一约束、迁移、写入点和事务边界已盘点。
- [x] 文件、OCR、备份和恢复流程已盘点。
- [x] 前端 API 调用和主要响应契约已盘点。
- [x] 当前测试通过并记录覆盖缺口。
- [x] 已提出迁移顺序、验收与回滚原则。

进入阶段 1 的前置条件：

1. 用户审查本阶段文档。
2. 确认“保持现有行为优先于顺带修复业务缺陷”。
3. 确认测试只使用临时数据库和临时截图目录。
4. 确认不自动提交、不部署、不操作真实资金数据。
