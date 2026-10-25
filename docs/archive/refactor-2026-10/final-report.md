# 钱多多后端渐进式重构最终报告

> 历史快照：本文记录当时的重构、审计或验收结果，不代表当前实现或运行状态。当前事实以代码、`TODO.md`、运行接口和 [文档地图](../../README.md) 为准。

## 1. 最终结论

阶段 0–10 已完成。

后端已从单个 3,557 行 `server.js` 演进为：

- 15 行启动入口。
- 模块化 HTTP 路由。
- 按域 service/repository/validation。
- 独立 OCR、backup、logging、transaction infrastructure。
- 集中 scheduler 和 lifecycle。
- 静态研究报告独立适配。

现有 API 路径、HTTP 方法、主要状态码和响应结构保持兼容。

数据库 schema 未在本轮重构中改变，SQLite 数据文件未被执行破坏性迁移。

## 2. 最终目录

```text
server.js

server/
  app.js
  config.js
  lifecycle.js

  http/
    router.js
    routes.js
    response.js
    errors.js
    static.js
    middleware/

  infrastructure/
    backup/
    database/
    logging/
    ocr/

  jobs/
    automation-scheduler.js

  modules/
    capital/
    dashboard/
    decisions/
    evaluations/
    income/
    ledger/
    notifications/
    operations/
    product-valuations/
    products/
    proposals/
    research/
    reviews/
    trades/

  shared/
    images.js

lib/
  现有 SQLite store、领域计算和兼容模块
```

## 3. 旧架构与新架构对比

| 维度 | 重构前 | 当前 |
| --- | --- | --- |
| 入口 | 3,557 行 `server.js` 包含路由、业务、生命周期 | 15 行入口，生命周期和应用工厂分离 |
| 路由 | 巨型 `if` 链 | 69 个显式 pattern + 模块 routes |
| 业务 | 路由直接调多个 store | route → service → repository/domain |
| 校验 | 集中在 server | 按域 validation |
| 错误 | 路由内零散处理 | HTTP error mapper + service errors |
| OCR | 与 HTTP 混用 | infrastructure OCR adapter |
| 任务 | 启动函数内 timer | jobs scheduler + retry/status |
| 备份 | 复制主库 | SQLite 一致快照 + 验证 + 临时恢复 |
| 研究 | 由 generic static 全权处理 | research 静态归属 |
| Legacy | 无单独层 | 已删除 |

## 4. 已迁移模块

- operations：健康检查、备份。
- dashboard：dashboard/workspace 查询门面。
- capital：本金和资金事件。
- ledger：每日收益和 CSV。
- products：产品池、分配和持仓复核设置。
- product-valuations：逐产品收益、延迟和对账。
- trades：交易、持仓、赎回、收据和 vision apply。
- income：收益截图。
- decisions：决策 CRUD。
- proposals：提案。
- evaluations：自动评估、任务、设置。
- reviews：产品事件、笔记、草稿、Markdown。
- notifications：消息中心与 notification 状态。
- research：报告静态归档和索引只读访问。

## 5. API 兼容性

- `API_ROUTE_PATTERNS` 69 个模式全部有模块 handler。
- 启动时强制检查未迁移/重复路由。
- 所有旧 API 回归测试通过。
- 未知 API 仍为 404 `{error:"接口不存在"}`。
- 非 JSON 仍为 415；跨站写仍为 403；静态 HEAD/缓存/gzip 保持。
- 已记录但未修正的 HTTP 异常行为仍存在，例如非法 JSON 返回 500。

## 6. 测试结果

最终命令：

```powershell
node --test
node --experimental-test-coverage --test
npm run check
npm run build
npm run test:e2e
npm audit --omit=dev
```

结果：

```text
tests 193
pass  193
fail  0

line coverage   88.16%
branch coverage 73.09%
func coverage   86.77%

npm run check: passed
npm run build: passed
npm run test:e2e: passed
npm audit --omit=dev: 0 vulnerabilities
```

E2E 验证：

- 报告正文检索、直达、目录和键盘切换。
- 七个 R2 入口。
- 双截图入口。
- 消息、提案、复盘、产品收益、持仓复核、交易、收件箱、评估。
- 前端布局、回滚、错误兜底和字体下限。

## 7. 数据库与恢复

真实数据库只读检查：

```text
PRAGMA quick_check: ok
PRAGMA user_version: 0
```

恢复验证：

- WAL 安全快照包含恢复前最新事务。
- 有效备份可恢复。
- pre-restore 快照可恢复当前状态。
- 损坏备份在覆盖前被拒绝。
- 恢复后删除旧 WAL/SHM。

## 8. 生产重启与验收

2026-10-22 已完成本机生产服务 `8765` 重启和重启后验收。

- 重构后实例已验证 stop marker 优雅关闭，未达到超时才强杀。
- 当前 Server PID 8068，Supervisor PID 24388，Health OK。
- health、dashboard、trades、inbox、review、decision proposals、product valuations、backups、automation workspace 和 CSV 导出接口均返回预期结果。
- 首页、投资研究、科技图谱和抽样归档报告均可访问。
- 未知 API 保持 404 `{"error":"接口不存在"}`。
- 真实数据库只读 `quick_check` 为 `ok`，`foreign_key_check` 为空，`journal_mode=wal`。
- 运行目录无残留 stop marker。
- 新 Server stderr 为空，自动评估 startup 正常执行。

详细记录见 `docs/archive/refactor-2026-10/14-production-acceptance.md`。

生产验收保留事项已登记到 `TODO.md` 的 `TD-REF-001` 至 `TD-REF-005`。

## 9. 已知问题和边界

### 财务一致性

1. `applyIncomeScreenshot()` 仍未把产品收益、账户收益、收件箱状态放进同一事务。
2. Dashboard GET 仍会刷新 allocations、提案和消息中心，属于既有副作用。
3. 数据库没有外键，关键关联由应用维护。

### 架构

1. `lib/*-store.js` 仍持有 SQL；模块通过 repository adapter 单一委托。
2. `getPortfolio()` 仍可能在读取时重建 allocations。
3. 自动 cycle 同步执行，timeout 只能诊断，不能硬中断。
4. OCR/screenshot DB 占位与文件写入之间仍有极端崩溃窗口。

### 运行

1. Watchdog 计划任务当前未安装。
2. 没有在真实用户数据库上执行恢复或批量重算。
3. 没有使用真实银行截图执行 OCR 成功链路 smoke。
4. 守护日志中的 Node 退出码字段当前可能为空，不影响 graceful/forced 判定。

## 10. 后续建议

1. 将 income screenshot apply 改为显式状态机/补偿事务。
2. 将 allocations 从 GET 读路径移到命令或后台投影刷新。
3. 在安全迁移方案下评估关键外键和 orphan audit。
4. 把 `lib/*-store.js` 的 SQL 逐步迁入域 repository，同时删除旧方法。
5. 为 OCR 文件写入到 DB 占位加入启动 orphan reconciliation。
6. 将同步 automation cycle 移出 HTTP/主事件循环前，先设计 worker 和 SQLite 连接边界。

## 11. Git 状态

本轮没有自动提交或切分支；生产服务只在本机完成受控重启和验收，没有执行线上部署。

未修改研究报告源文件、股票索引、交易截图或个人数据库数据。
