# 后端重构进度

> 历史快照：本文记录当时的重构、审计或验收结果，不代表当前实现或运行状态。当前事实以代码、`TODO.md`、运行接口和 [文档地图](../../README.md) 为准。

## 当前状态

- 当前阶段：阶段 0–10 与生产重启验收均已完成。
- 下一步：用户审查本轮未提交变更；财务一致性问题按独立修复任务处理。
- 源码分支：`main`
- 审计基线提交：`b41dbc9`
- 审计日期：2026-10-22（Asia/Shanghai）
- 开始审计时 Git：工作区干净，`main...origin/main`

## 已完成阶段

### 阶段 0：代码审计与重构计划

已完成只读审计：

- 实际目录、运行入口、部署和守护方式。
- `server.js` 全部 HTTP 路由及主要调用链。
- `lib/` 模块职责、依赖和跨域访问。
- 28 张实际 SQLite 表、索引、唯一约束和检查约束。
- 分散初始化/迁移及一次性迁移键。
- 数据库写入点、事务边界和读取时写入。
- 截图文件、OCR、备份和恢复。
- 自动评估、提案、通知、复盘草稿和定时任务。
- 前端 API 调用与响应依赖。
- 现有测试和覆盖率。
- 高风险财务一致性问题。

交付文档：

- `docs/archive/refactor-2026-10/00-audit.md`
- `docs/archive/refactor-2026-10/01-dependency-map.md`
- `docs/archive/refactor-2026-10/02-api-inventory.md`
- `docs/architecture/database-invariants.md`
- `docs/archive/refactor-2026-10/04-refactor-plan.md`
- `docs/archive/refactor-2026-10/progress.md`

### 阶段 1：建立测试保护

已完成：

- 新增临时测试上下文 helper。
- 新增应用启动/关闭测试。
- 新增交易重复确认、部分赎回和收益幂等集成测试。
- 新增旧 `daily_records` 迁移测试。
- 新增 WAL 模式备份内容测试。
- 新增收益截图半提交 characterization 测试。
- 新增自动周期失败与重试测试。
- 新增 OCR 引擎启动失败测试。

交付：

- `test/helpers/test-context.js`
- `test/integration/app-lifecycle.test.js`
- `test/integration/financial-idempotency.test.js`
- `test/integration/migrations-and-backup.test.js`
- `test/integration/transaction-failure.test.js`
- `test/unit/ocr-adapter.test.js`
- `docs/archive/refactor-2026-10/05-test-baseline.md`

### 阶段 2：拆分应用启动与 HTTP 基础设施

已完成：

- `server.js` 从 3,557 行收窄为 15 行。
- 新增 `server/app.js` 应用工厂。
- 新增 `server/lifecycle.js` 启动、ready、stop 和信号处理。
- 新增 `server/jobs/automation-scheduler.js`。
- 新增通用 `Router`。
- 新增 69 个显式 API method/path 模式。
- 抽出 JSON 响应、错误处理、静态文件、JSON body 和 Origin middleware。
- 保留单一 legacy adapter，没有复制两套业务实现。
- `package.json check` 纳入全部新增后端文件。

交付：

- `docs/archive/refactor-2026-10/06-http-infrastructure.md`
- `server.js`
- `server/app.js`
- `server/lifecycle.js`
- `server/http/*`
- `server/jobs/automation-scheduler.js`
- `test/unit/router.test.js`
- `test/unit/automation-scheduler.test.js`
- `test/integration/lifecycle-module.test.js`

### 阶段 3：低风险基础模块

已完成：

- 新增运行配置模块。
- 抽出 dashboard query service 和 routes。
- 迁移 health、backups 到 operations。
- 迁移产品 CSV、刷新、分配设置、持仓复核到 products。
- 迁移 inbox 和 notifications 状态处理到 notifications。
- 迁移静态资源、favicon、SPA fallback 和 405 到 app fallback。
- 删除 legacy 中上述全部重复分支。
- 新增阶段 3 模块集成测试。

交付：

- `docs/archive/refactor-2026-10/07-low-risk-modules.md`
- `server/config.js`
- `server/modules/dashboard/*`
- `server/modules/operations/*`
- `server/modules/products/*`
- `server/modules/notifications/*`
- `test/integration/stage3-modules.test.js`

### 阶段 4：本金、账户账本与逐产品收益

已完成：

- 本金初始化、调整、资金事件迁入 capital 模块。
- 账户收益 CRUD 和 CSV 导出迁入 ledger 模块。
- 逐产品收益、收益延迟设置、修正迁入 product-valuations 模块。
- 删除 legacy 对应路由以及本金/收益校验和 CSV 实现。
- 新增历史本金重算兼容性测试。
- 新增阶段 4 模块路由集成测试。

交付：

- `docs/archive/refactor-2026-10/08-capital-ledger-product-valuations.md`
- `server/modules/capital/*`
- `server/modules/ledger/*`
- `server/modules/product-valuations/*`
- `test/integration/historical-principal.test.js`
- `test/integration/stage4-modules.test.js`

### 阶段 5：交易、持仓、赎回匹配、截图与 OCR

已完成：

- 交易 CRUD、确认、撤销、审计和持仓推导门面迁入 trades。
- 部分赎回、切换和 FIFO 规则维持原 trade store。
- 交易截图列表、上传、去重、校正、apply、vision-apply、ignore、清理和图片读取迁移。
- `/api/review/holdings` 兼容接口迁移。
- OCR 实现迁移到 infrastructure，`lib/ocr.js` 仅做兼容导出。
- 图片解析移动到 shared。
- trade store 增加可嵌套事务，inbox apply 原子化。
- 截图上传改为先建 DB pending 占位，再 OCR 更新。
- 删除 legacy 中交易、收件箱、持仓兼容、相关校验和同步逻辑。

交付：

- `docs/archive/refactor-2026-10/09-trades-holdings-ocr.md`
- `server/modules/trades/*`
- `server/infrastructure/ocr/*`
- `server/shared/images.js`
- `test/integration/stage5-trades-modules.test.js`

### 阶段 6：决策、提案、自动评估、通知与复盘

已完成：

- 决策 CRUD 迁入 decisions。
- 提案读取/采纳/拒绝迁入 proposals。
- 自动评估、设置、任务、apply/undo 迁入 evaluations。
- 产品事件、月度/季度笔记、复盘草稿和 Markdown 导出迁入 reviews。
- 共享数据库事务协调器新增并接入提案、评估、决策删除和草稿确认。
- 通知 REST 接口继续由阶段 3 的 notifications 模块提供。
- 删除 legacy 中对应路由、校验、导出和评估同步实现。

交付：

- `docs/archive/refactor-2026-10/10-decisions-evaluations-reviews.md`
- `server/infrastructure/database/transaction.js`
- `server/modules/decisions/*`
- `server/modules/proposals/*`
- `server/modules/evaluations/*`
- `server/modules/reviews/*`
- `test/integration/stage6-transactions.test.js`

### 阶段 7：股票研究报告与静态索引隔离

已完成：

- 新增 research repository/static/service。
- `/research/stocks`、media、scripts、techmap 由 research 静态适配器归属。
- 投资研究 SPA 路由保持原样。
- 报告索引和技术图谱索引仅只读加载。
- 未修改任何报告正文、结论、索引或日期。

交付：

- `docs/archive/refactor-2026-10/11-research-static-isolation.md`
- `server/modules/research/*`
- `test/unit/research-service.test.js`
- `test/integration/stage7-research.test.js`

### 阶段 8：调度、关闭、备份恢复与日志

已完成：

- scheduler 增加失败重试、指数退避、停止清理和执行状态。
- 启动时恢复中断的 automation run。
- OCR 子进程纳入关闭生命周期。
- 守护脚本通过 stop marker 先请求优雅关闭，超时才强杀。
- 新增 WAL 一致备份、备份验证和安全恢复模块。
- `scripts/db.mjs backup/restore` 使用一致快照和临时文件验证。
- 新增敏感日志脱敏。

交付：

- `docs/archive/refactor-2026-10/12-operations-lifecycle-backup.md`
- `server/infrastructure/backup/sqlite-backup.js`
- `server/infrastructure/logging/logger.js`
- scheduler/lifecycle/OCR/daemon 更新
- `test/unit/logger.test.js`
- `test/integration/sqlite-backup.test.js`
- `test/integration/stage8-operations.test.js`

### 阶段 9：旧实现与依赖清理

已完成：

- 删除 `server/http/legacy-app.js`。
- 收益截图迁入 income 模块。
- 删除旧 registerRoutes fallback。
- API 启动时强制校验全部 pattern 已迁移且无重复。
- 扫描模块直接 SQL、循环依赖、重复 helper 和兼容导出。
- 确认报告和数据库文件未被改动。

交付：

- `docs/archive/refactor-2026-10/13-cleanup-audit.md`
- `server/modules/income/*`
- 路由完整性运行时校验

### 阶段 10：最终验证

已完成：

- 全量 Node 测试。
- 覆盖率。
- TypeScript/Node 静态检查。
- 生产构建。
- Playwright E2E。
- npm production dependency audit。
- 真实 SQLite 只读 quick_check。
- WAL 备份恢复测试。
- 服务启动/关闭测试。
- 无循环依赖扫描。
- API route 完整性检查。
- 报告/数据库零改动检查。
- 本机生产 `8765` 重启和重启后验收。

交付：

- `docs/archive/refactor-2026-10/final-report.md`
- `docs/archive/refactor-2026-10/14-production-acceptance.md`

## 已迁移模块

- operations：健康检查、备份。
- dashboard：dashboard/workspace 查询门面。
- capital：本金和资金事件。
- ledger：账户收益和 CSV。
- products：产品池、分配和持仓复核设置。
- product-valuations：逐产品收益、延迟和对账。
- trades：交易、持仓、赎回、收据和 vision apply。
- income：收益截图。
- decisions：决策。
- proposals：提案。
- evaluations：自动评估、任务和设置。
- reviews：产品事件、笔记、草稿和复盘导出。
- notifications：消息中心。
- research：研究报告静态归档和只读索引。

## 尚未迁移的旧逻辑

- `lib/*-store.js` 中仍有现有 SQL 和部分既有业务计算；当前模块通过 repository adapter 单一委托，不存在两套 HTTP 路由实现。
- 收益截图跨产品收益、账户收益和收件箱状态的原子性仍未完成。
- Dashboard 读请求中的 allocations、提案和消息中心刷新仍是既有副作用。
- automation cycle 仍同步执行，缺少可强制中断的 worker 边界。

## 当前测试结果

### 阶段 10 完成执行

命令：

```powershell
node --test
```

结果：

- 193 tests
- 193 pass
- 0 fail
- 0 skipped
- 约 2.4 秒

阶段 10 覆盖率：

- 行覆盖率：88.16%
- 分支覆盖率：73.09%
- 函数覆盖率：86.77%

静态检查：

```powershell
npm run check
```

- 通过。
- 包含 Vue TypeScript 检查、原 `lib/` 语法检查和全部新增 `server/` 文件语法检查。

### 覆盖率

命令：

```powershell
node --experimental-test-coverage --test
```

阶段 1 覆盖率基线：

- 行覆盖率：88.36%
- 分支覆盖率：73.91%
- 函数覆盖率：90.86%

阶段 2 完成覆盖率：

- 行覆盖率：88.88%
- 分支覆盖率：73.77%
- 函数覆盖率：90.12%

重点缺口：

- `lib/ocr.js`：超时和进程异常退出仍未全部覆盖。
- `server.js`：`startServer()`、定时器、关闭和低频路由。
- `lib/income-store.js`：截图清理和文件/DB 半完成状态。
- `lib/backup.js`：清理失败。
- `lib/db.js` / `product-valuation-store.js`：异常分支。

### 未执行

- 真实生产数据库上的破坏性备份恢复演练；备份恢复已在隔离测试数据库验证，真实库只执行只读完整性检查。
- 真实银行截图的 OCR 成功链路 smoke；当前只验证失败路径、上传和事务测试。

## 当前数据库检查

只读检查真实库：

- `PRAGMA quick_check`：`ok`
- `PRAGMA foreign_key_check`：空
- `PRAGMA user_version`：`0`
- `journal_mode`：`wal`
- 28 张业务表
- 0 个触发器
- 0 个已定义 `FOREIGN KEY`

未执行任何真实数据库写入、迁移、恢复或修复。

### 生产重启后复核

2026-10-22 23:47 完成本机生产重启：

- 旧 Server PID 23708 优雅退出。
- 新 Server PID 8068，Supervisor PID 24388。
- Health OK。
- 首页、投资研究、科技图谱和抽样归档报告均返回 200。
- 关键 API、CSV 导出和未知 API 404 契约均通过。
- 新 Server stderr 为空。
- 运行目录无残留 stop marker。
- 重启后再次只读检查：`quick_check=ok`、`foreign_key_check` 为空、`user_version=0`、`journal_mode=wal`、28 张业务表。

详细记录见 `docs/archive/refactor-2026-10/14-production-acceptance.md`。

生产验收保留事项已登记到根目录 `TODO.md`，编号为 `TD-REF-001` 至 `TD-REF-005`。

## 未解决问题

### 财务一致性

- 收益截图的产品收益、账户收益、收件箱状态没有共享事务。
- 交易收件箱的 create/confirm/update 与 inbox applied 状态没有共享事务。
- 评估写入/撤销，提案采纳/拒绝，复盘确认，跨 decision/run/proposal/note/job/notification 非原子。
- 读取持仓时会重建 allocations，并可能在非事务路径中断。
- 当前没有外键，关键业务关联由应用维护。

### 文件/外部服务

- 图片上传先建 DB 占位、再 OCR；文件与数据库之间仍存在极端崩溃窗口和孤立文件风险。
- OCR 子进程已纳入关闭生命周期，但真实银行截图的成功/超时混合链路仍需后续专项 smoke。

### 运维

- 当前守护脚本先通过 stop marker 请求优雅关闭，超时才强杀；本次重构后重启已实际验证 graceful path。
- 本机 Watchdog 计划任务当前未安装。
- 自动运行的持久状态和重试语义已有基线，但同步 cycle 仍不能硬超时。

### HTTP

- 非法 JSON 当前返回 500。
- 超限请求可能表现为连接中断。
- 图片 HEAD 外层路由未匹配。
- 500 可能返回底层错误文本。

## 下一步执行计划

最终状态：

- 所有 API 由模块注册。
- legacy 已删除。
- 自动化测试、E2E、构建和安全审计通过。
- 本机生产 `8765` 已重启并通过基础验收。
- 已知财务/架构风险已写入最终报告，不与结构重构混改。
- 等待用户审查未提交变更；后续财务一致性修复应独立立项和验证。
