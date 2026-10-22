# 渐进式后端重构计划

## 1. 目标与非目标

### 1.1 目标

在保持现有 API、SQLite schema、业务规则和前端调用不变的前提下，把后端迁移为职责清晰的模块化单体：

- HTTP 接入层只负责协议、输入适配、调用用例和响应映射。
- 业务用例可脱离 `http.IncomingMessage`/`ServerResponse` 独立测试。
- 各域 repository 集中管理本域 SQL。
- 事务由业务用例拥有，repository 不自行开启不可协调的嵌套事务。
- 文件、OCR、备份、日志和时钟是显式基础设施端口。
- 定时任务定义、调度和执行分离，可诊断、可恢复、可重试。
- 迁移完成后删除旧路由分支、重复 SQL 和重复业务实现。

### 1.2 非目标

- 不推倒重写。
- 不更换 `node:sqlite`。
- 不引入 ORM、Redis、消息队列、微服务或大型 DI 框架。
- 不整体迁移 TypeScript。
- 不调整收益门槛、评分、分配、赎回匹配或投资策略。
- 不为了目录整齐把每个小函数拆成单独文件。
- 不在结构重构中悄悄修业务缺陷。

## 2. 目录选择

任务建议中的顶层 `src/` 与现有 Vue 前端冲突。最终推荐：

```text
server.js                         # 仅启动装配

server/
  app.js                          # 创建 HTTP app / 路由装配

  http/
    router.js                     # 显式注册各模块 routes
    middleware/
      origin.js
      json-body.js
      error-handler.js
      not-found.js
    response.js
    errors/
      map-error.js

  modules/
    capital/
      routes.js
      service.js
      repository.js
      validation.js

    ledger/
      routes.js
      service.js
      repository.js
      validation.js
      export.js

    products/
      routes.js
      service.js
      repository.js
      validation.js

    trades/
      routes.js
      service.js
      repository.js
      domain.js
      validation.js

    income/
      routes.js
      service.js
      repository.js  # income inbox
      workbench.js   # repository adapter 初期复用 lib/db
      validation.js

    product-valuations/
      routes.js
      service.js
      repository.js
      domain.js

    decisions/
      routes.js
      service.js
      repository.js
      proposals.js
      validation.js

    evaluations/
      routes.js
      service.js
      repository.js
      rules.js
      jobs.js
      validation.js

    reviews/
      routes.js
      service.js
      repository.js
      export.js

    notifications/
      routes.js
      service.js
      repository.js

    research/
      routes.js
      service.js

    operations/
      routes.js
      service.js
      jobs.js

  infrastructure/
    database/
      connection.js
      migrations.js
      transaction.js
    ocr/
      windows-ocr.js
      parser.js
    filesystem/
      image-inbox.js
      atomic-write.js
    backup/
      backup.js
      restore.js
    logging/
      logger.js
    time/
      clock.js

  shared/
    errors.js
    dates.js
    money.js
    validation.js
    result.js

test/
  unit/
  integration/
  fixtures/
  helpers/
```

本计划不强制一次性建立所有文件。原则是：

- 低风险、单表 CRUD 可合并 `routes/service/repository`。
- 交易、收益、评估等高风险域才拆细。
- `lib/` 在迁移期作为**唯一兼容实现**被 adapter 调用，不允许复制一份新业务后长期并存。
- 每个域迁移完成并验证后，删除被替换的旧路由/旧 store 路径。

## 3. 架构规则

### 3.1 分层

```text
HTTP route
  -> validation
  -> use case service
     -> transaction coordinator
     -> domain rules
     -> repositories
     -> infrastructure ports
  -> response mapper
```

约束：

- route 不直接执行 SQL。
- service 不接收 HTTP request/response 对象。
- repository 不读取 HTTP、日志、环境或业务当前日期。
- repository 不自行对调用者不透明的嵌套事务；复杂事务由 service 调用统一 transaction manager。
- external adapter 不写业务表。
- 文件写入如需要和 DB 一致，必须通过可恢复流程或明确的 outbox/状态记录协调。

### 3.2 事务

新增一个薄事务接口，不引入 ORM：

```js
withTransaction(db, callback, options = {})
```

要求：

- 使用当前 `BEGIN IMMEDIATE/COMMIT/ROLLBACK` 语义。
- 支持传入已持有事务的 repository 方法，禁止 repository 自行再次 `BEGIN`。
- service 在事务内完成业务写和 audit。
- 只在一个明确边界提交。

禁止：

- 在 transaction manager 之外再调用会自行 `BEGIN` 的旧 store 方法。
- 用 `SAVEPOINT` 掩盖职责混乱，除非未来确有嵌套用例。

### 3.3 读取

- GET 默认纯读取。
- 派生数据刷新改为明确命令或后台任务。
- 为兼容现有 `/api/dashboard` 行为，第一阶段可以保留“refresh derived state”副作用，但必须把它包在一个可命名的 `refreshDashboardProjections()` 用例中，并加回归测试。
- 迁移完成后再决定是否拆 `/api/dashboard` 的刷新副作用；未经用户批准不能改变前端行为。

### 3.4 错误

先保留当前响应契约：

- `{ error, details?, ...special }`
- 状态码和特殊 `code` 字段保持不变。

统一错误类型只作为内部机制：

```text
ValidationError -> 400
NotFoundError -> 404
ConflictError -> 409
UnsupportedMediaTypeError -> 415
PayloadTooLargeError -> 413
InfrastructureError -> 500 + 安全日志
```

HTTP mapper 负责输出旧 JSON。不能一次把所有错误都改成新格式。

## 4. 完整迁移顺序

### 阶段 0：审计与计划

状态：本次完成。

交付：

- `00-audit.md`
- `01-dependency-map.md`
- `02-api-inventory.md`
- `03-database-invariants.md`
- `04-refactor-plan.md`

风险：

- 文档与后续代码漂移。

验收：

- 源码依据完整，工作区无生产代码修改。

回滚：

- 删除本阶段新增文档；不影响运行。

### 阶段 1：测试保护

目标：

- 建立临时应用测试工厂。
- 为关键 API 建立基线快照/characterization。
- 为财务不变量建立失败注入测试。

建议先补：

1. `createTestContext()`：临时 DB、产品 fixture、trade/income inbox、固定 clock、logger、OCR stub。
2. `startTestServer()` 统一在 port 0 启动并在 `t.after` 清理。
3. 关键响应 schema 断言：
   - `/api/dashboard`
   - records 幂等/冲突
   - trade create/confirm/redeem
   - income upload/apply
   - evaluation apply/undo
   - proposal adopt/reject
   - backup/restore
4. 故障注入：
   - 产品收益写入后抛错。
   - daily record 写入后抛错。
   - inbox 状态更新前抛错。
   - OCR 超时/进程异常/空输出。
   - 自动 cycle 在一个阶段后抛错。
5. schema fixture：
   - 空库。
   - 旧 daily_records/cash_balance。
   - 旧 holdings。
   - 缺 review/trade/product 扩展列。
6. 恢复测试覆盖 WAL 和 pre-restore 完整性。

测试命令：

```powershell
node --test
node --experimental-test-coverage --test
```

暂不强制把 `npm test` 改成会重写生成物；是否将 pretest 拆开在阶段 1 决定。

风险：

- 测试本身写入真实路径。
- 用测试固化错误行为，掩盖产品缺陷。

应对：

- 断言临时 `R2_DB_PATH`、截图目录和 OCR stub。
- 把已知错误行为标成 characterization，不把它标成“正确”。

验收：

- 新测试全部通过。
- 测试前后 `git status` 无非预期用户数据/生成物变化。
- 没有使用 `data/r2_ledger.sqlite`。

回滚：

- 删除新增测试和 helpers，不影响生产代码。

### 阶段 2：应用启动与 HTTP 基础设施

目标：

- 创建 `server/app.js`、router、middleware、error mapper、response helpers。
- `server.js` 只装配 repository、app、server、jobs、shutdown。
- 先迁 HTTP 基础设施，不改业务实现。

动作：

1. 抽出 `createApp({ repository, services, clock, logger })`。
2. 抽出 `readJsonBody`、origin guard、sendJson/sendError、静态文件。
3. 将路由注册从巨型 `if` 链分批改为显式模块注册。
4. 保留所有路径、状态码、JSON 字段与错误文本。
5. 加应用启动/关闭测试和未知路由测试。

风险：

- 路由匹配顺序变化导致 `/api/trades/:id` 与 `/api/trades/inbox` 冲突。
- 统一错误 mapper 改变特殊 409。

验收：

- API 基线测试全部通过。
- 全部旧路径仍可调用。
- `server.js` 不再直接实现业务 SQL 或 OCR。
- 未知路由、跨站写和 JSON 错误与基线一致。

回滚：

- 保留旧 `createServer()` 适配器，切回原入口；新 app 不作为唯一入口。

### 阶段 3：低风险基础模块

顺序：

1. health/backups/static/research。
2. products 读取/刷新/分配。
3. review notes/product events。
4. notifications/inbox read state。
5. dashboard query facade。

动作：

- 先把这些域从 `server.js` 分支搬入模块 routes/service。
- repository 复用现有 store，不复制 SQL。
- 保留 dashboard 返回结构。

风险：

- 静态文件/SPA fallback。
- 备份返回字段。
- 通知 sync 的副作用。

验收：

- 对应 API 测试通过。
- 旧路由删除，不保留双重分发。
- 前端 build 通过。

回滚：

- 按模块恢复旧路由注册；store 不动。

### 阶段 4：账本、本金、产品收益

目标：

- 建立 capital、ledger、product-valuation 模块。
- 把 `lib/db.js` 中的本金/收益 repository 拆出。
- 统一本金默认日期为 `todayShanghai()`，但必须先在测试中记录当前行为；这可能是业务修正，需单独批准。

动作：

1. 建 `capital/repository.js`，迁移 `capital_settings`、`capital_events`、本金重算。
2. 建 `ledger/repository.js`，迁移 `daily_records` CRUD。
3. 建 `product-valuations/repository.js`，复用现有 store 或迁移 SQL。
4. 建 `income` 用例，但暂保留产品收益/账户收益/收件箱的两阶段状态。
5. 对历史重算先在 DB 副本执行。

风险：

- 本金重算损坏历史快照。
- 产品收益唯一键/审计行为改变。
- dashboard 产品对账改变。

验收：

- 账本/本金/产品收益全部回归通过。
- 历史数据行数、关键汇总、每日本金快照前后一致。
- 0 元、同额重复、异额冲突、未来日期错误保持。
- 旧 `db.js` 的重复 repository 分支删除。

回滚：

- 恢复旧 schema 不做结构变更。
- 路由切回旧 adapter。
- 使用阶段备份，不覆盖真实库除非用户明确恢复。

### 阶段 5：交易、OCR 与持仓（最高风险）

目标：

- `trades` 拥有交易、批次、收件箱、审计。
- OCR 和文件存储成为 infrastructure adapters。
- 纯业务规则进入 `trades/domain.js`。
- 明确事务和可恢复状态。

动作顺序：

1. 提取 `tradeKey`、状态转换、日期、金额、赎回匹配到 domain。
2. 将交易 CRUD 和 allocations 保留在单一事务。
3. 把 `getPortfolio()` 从“读时重建并写表”改为：
   - 首选：读已有 allocations。
   - 若需要重建，使用显式 `refreshPortfolio()` 命令和事务。
   - 为兼容旧行为，短期可让 GET 调用 refresh，但必须记录和测试。
4. 收件箱文件和 DB 插入设计：
   - 先计算 hash，插入 pending 占位记录/或使用可恢复 file record。
   - 再原子写临时文件并 rename。
   - OCR 结果更新同一记录。
5. apply 的全流程使用一个协调器；跨模块决策同步在交易提交后以可重试 outbox/状态执行。
6. 人工修正保留 `ocr_reference`、`vision`、`checks`。

必须测试：

- 同图并发上传。
- 文件写完但 DB 插入失败。
- trade create 成功但 updateInbox 失败。
- confirm 成功但 proposal reconcile 失败。
- 部分赎回与历史批次。
- OCR 超时、无输出、非零退出。
- 交易重试不重复入账。

风险：

- 持仓重建语义。
- 待确认交易进入持仓。
- 历史迁移 buy 仍 pending。
- FIFO 舍入差。

验收：

- 所有交易测试、故障注入测试通过。
- 交易后持仓摘要与旧实现逐字段一致。
- 任何重试最终只产生一笔正式交易。
- screenshot/trade/proposal/decision 关联可追溯。

回滚：

- 交易表不迁移则不需要 schema 回滚。
- 路由切回旧 `tradeStore`。
- 文件新流程失败时保留旧收件箱路径。

### 阶段 6：决策、提案、评估与复盘

目标：

- decisions、evaluations、reviews 分离。
- 自动规则与调度执行分离。
- 保留所有阈值、rating、rule_version。

动作：

1. 决策 repository 迁移。
2. 提案 state machine 与执行偏差逻辑迁移。
3. 评估纯规则保留在 `rules.js`，输入是只读 snapshot。
4. 评估命令把 decision + run + job + notification 放在同一事务，或使用可恢复 outbox。
5. 撤销和重新评估明确补偿语义。
6. 复盘草稿生成只读账本；确认写 note/draft 原子化。

风险：

- 自动覆盖人工评分。
- sync 在 GET 中生成提案。
- 消息状态和 proposal 状态不一致。
- 历史 rule_version 混用。

验收：

- 规则回归、提案 API、评估撤销全部通过。
- 人工结果保护保持。
- 失败不会污染原有效评估。
- 历史记录可追溯。

回滚：

- 旧 automation/decision store 保持只读兼容 adapter。
- 路由切回旧路径。

### 阶段 7：研究与其他模块

股票研究当前主要是静态报告和构建产物，不属于账本业务：

- 保留 `report/` 源文件。
- API 只需报告索引/静态文件服务。
- 外部研究/模型调用不进入交易服务。
- 不改变报告内容或投资结论。
- 如果现有静态方案清晰，仅做路由隔离，不做无收益重写。

### 阶段 8：定时任务、备份、日志和生命周期

目标：

- `operations/jobs.js` 管理任务注册。
- `server.js` 只调用 start/stop。
- 加入任务状态、租约、最大重试、超时和诊断。

动作：

1. 启动时标记遗留 `automation_runs.running` 为 interrupted/failed。
2. 为每个 job 明确：
   - 触发
   - 并发策略
   - 幂等键
   - 重试次数/退避
   - 超时
   - 关闭行为
3. 保护重复定时器注册。
4. 关闭时停止新任务、等待进行中任务、终止 OCR 子进程、checkpoint/关闭 DB。
5. `daemon.ps1` 优先发正常停止信号，超时后才强制杀死。
6. 恢复前用 SQLite backup API/`VACUUM INTO` 做一致快照。
7. 恢复后执行 `quick_check`、schema 和关键表校验。

验收：

- 实际启动/停止测试。
- 任务并发/失败/重试测试。
- 实际备份→恢复→启动→关键数据读取。
- 不把密钥、截图内容或 SQL 参数写入日志。

风险：

- 守护脚本杀死进程的行为是运维层，不只在 Node 内。
- 恢复真实库属于高风险外部操作，测试只在临时目录。

### 阶段 9：清理旧实现

只有所有模块迁移、集成测试通过后才允许：

- 删除 `server.js` 旧路由分支。
- 删除被替代的 `lib/db.js` 业务方法。
- 删除未调用的 store 导出。
- 删除重复 SQL、无效导入、过时注释。
- 清理重复的定时器注册。
- 验证无循环依赖。
- 搜索绕过 services 的直接写库路径。

禁止：

- 为了便于删除而删除兼容 API。
- 删除测试或放宽断言。
- 保留两套可写业务实现。

验收：

- `rg` 不存在旧函数调用。
- 模块依赖检查通过。
- 关键表所有写入都能从 service 调用链解释。

### 阶段 10：最终验证与交付

必须执行：

1. `node --test`
2. `node --experimental-test-coverage --test`
3. `npm run check`
4. `npm run build`
5. `npm run test:e2e`
6. API inventory 对比。
7. 临时 DB schema/迁移矩阵。
8. 备份恢复。
9. 服务启动、健康、信号关闭。
10. `npm audit --omit=dev` 或等价依赖检查（若有网络）。
11. 文件/目录残留检查。

如果某项不能运行，最终报告必须写明：

- 命令
- 失败/跳过原因
- 影响
- 建议人工验证方式

## 5. API 兼容策略

### 5.1 固定不变

- 路径。
- HTTP 方法。
- 成功状态码。
- JSON 顶层字段。
- 特殊 409 `code` 字段。
- Markdown/CSV/图片 Content-Type 和附件名。
- 前端对 `dashboard` 响应快照的依赖。

### 5.2 允许内部变化

- 路由由 `if` 链变显式 router。
- 输入校验函数位置。
- service/repository 名称。
- 事务协调方式。
- 日志结构。
- 测试辅助代码。

### 5.3 需要单独批准的变化

- 非法 JSON 从 500 改为 400。
- 超限请求从连接中断改为稳定 JSON 413。
- 默认日期从 UTC 改为上海。
- 表结构增加非空列/外键。
- 重复确认不再追加审计记录。
- `/api/dashboard` GET 不再刷新派生数据。

每个变化都要：

1. 先写 failing characterization test。
2. 记录旧/新响应。
3. 标明前端影响。
4. 给出回滚开关或 revert。
5. 作为独立提交。

## 6. 测试策略

### 6.1 Unit

纯函数和 domain：

- 日期
- 金额
- trade state transition
- FIFO allocation
- profit/return calculation
- evaluation rating
- proposal matching
- product allocation

### 6.2 Integration

临时 SQLite + repository + service：

- transactions
- migrations
- idempotency
- audit
- failure injection
- file metadata

### 6.3 HTTP

临时 DB + port 0：

- status/content-type/keys
- write origin
- JSON body rules
- special 409
- static fallback

### 6.4 E2E

保留现有 Playwright smoke，覆盖：

- 首页和 R2 页面加载。
- 交易/收益/评估/提案关键流程。
- 报告页静态路由。
- 字体下限。

### 6.5 不变量断言

每个财务用例至少断言：

```text
提交前快照
-> 执行一次
-> 断言期望状态
-> 重试同一输入
-> 断言无重复业务记录
-> 注入中途失败
-> 断言无不可恢复的半记录
-> 恢复后重试
-> 断言可收敛
```

## 7. 每个阶段的统一验收

- [ ] 相关旧测试通过。
- [ ] 新增集成/失败测试通过。
- [ ] API 行为无未经批准变化。
- [ ] 关键数据不变量未破坏。
- [ ] 没有新增重复业务实现。
- [ ] 没有遗留未解释的旧路由/重复 SQL。
- [ ] 变更范围单一、可审查。
- [ ] `progress.md` 已更新。
- [ ] 命令、结果、已知风险已记录。

## 8. 回滚原则

1. 每个阶段开始前记录 `git status` 和基线测试结果。
2. 不切换分支、不 reset、不删用户文件。
3. 结构迁移尽量通过“新旧 adapter 切换”回滚，而不是重写数据库。
4. schema 变化必须单独迁移、备份和回滚脚本。
5. 回滚只撤当前阶段，不撤销用户已有修改。
6. 回滚后必须重跑该阶段基线测试。

## 9. 提交与操作边界

- 用户未授权自动提交，本计划不自动 `git commit`。
- 每个阶段只准备变更、测试和审查说明。
- 不执行线上部署。
- 不触碰真实资金或真实账本写入。
- 不把个人数据库、截图、密钥或环境文件加入 Git。

## 10. 阶段 1 进入条件

阶段 0 文档经用户审查后，阶段 1 才开始。

阶段 1 第一项不是移动业务文件，而是：

1. 创建隔离测试上下文。
2. 固定关键 API 契约。
3. 写财务失败注入。
4. 写旧 schema fixture。
5. 确认所有测试不会写入真实数据库或截图目录。

只有这些保护建立后，才允许进入阶段 2。
