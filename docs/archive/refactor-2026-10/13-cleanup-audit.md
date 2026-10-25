# 阶段 9：旧实现、重复逻辑与依赖清理

> 历史快照：本文记录当时的重构、审计或验收结果，不代表当前实现或运行状态。当前事实以代码、`TODO.md`、运行接口和 [文档地图](../../README.md) 为准。

## 1. Legacy 清理

`server/http/legacy-app.js` 已删除。

所有 69 个 API route pattern 现在都由模块路由注册；`createRequestHandler()` 在启动时强制校验：

```text
API_ROUTE_PATTERNS - migrated routes = 0
```

如未来新增 route 却未注册 handler，应用会直接启动失败，不会静默返回 404。

同一 method/path 重复注册也会启动失败。

## 2. 收益截图最后兼容模块

剩余收益截图流程已迁入：

```text
server/modules/income/
  repository.js
  service.js
  routes.js
```

原有行为保留：

- sha256 截图去重。
- OCR 失败仍保存 pending。
- 置信度达标后自动入账。
- 日期同金额幂等。
- 日期异金额不覆盖，产生 confirmation。
- 多产品收益拆分、对账和缺失产品提示。
- apply override、ignore、prune 和 image。

已知限制：`lib/db.js:applyIncomeScreenshot()` 的“产品收益 → 账户收益 → 收件箱状态”仍未共享同一事务。现有 characterization 测试明确固定了该风险，本阶段没有把业务修复混入清理。

## 3. 模块直接 SQL

扫描：

```text
server/modules/**/*.js
server/infrastructure/**/*.js
```

未发现 `db.prepare()`、`db.exec()` 或直接 `INSERT/UPDATE/DELETE`。

数据访问仍集中在现有 `lib/*-store.js` / `lib/db.js` 的稳定实现中，由模块 repository adapter 调用。

## 4. 循环依赖

对 `server/` 和 `lib/` 的相对 `require()` 图进行 DFS：

```text
NO_REQUIRE_CYCLES
```

## 5. 重复实现检查

已删除/消除：

- 旧 `legacy-app.js`。
- 旧 `registerRoutes()` fallback 注册器。
- 旧 `report-nav` 以外的研究运行时重复 API。
- dashboard payload 的旧副本。
- 交易、决策、评估、复盘校验的旧副本。
- 交易/OCR 图片解码旧副本。
- 收益截图旧 handler。

保留的兼容再导出：

| 文件 | 原因 |
| --- | --- |
| `server.js` | 保持脚本/测试/外部 require 兼容 |
| `lib/ocr.js` | 保持旧 import 兼容，实际实现已移到 infrastructure |
| `server/app.js` 部分导出 | 保持 `createServer`、`resolveProductCsv` 等旧测试接口 |

这些不是两套业务实现，只是转发导出。

## 6. 业务模块越权

已确认模块不直接执行 SQL。仍存在的受控跨域读取/编排：

- Dashboard 查询门面读取多个域。
- Income service 通过 repository adapter 调用 `applyIncomeScreenshot()`。
- Trades service 通过 repository adapter 同步提案和自动评估。
- Product valuations 读取 portfolio 做对账。

这些依赖已显式通过 repository/query facade 注入，不再隐藏在全局 HTTP handler。

## 7. 读取副作用

仍保留并已记录的既有行为：

- `GET /api/dashboard` 会刷新交易 allocations、决策提案和消息中心。
- `getWorkspace()` 会推进 snooze/提案执行状态。

这是现有前端状态语义；本阶段没有擅自改为纯只读。

## 8. 未验证行为变化

未发现未记录的 API 路径、方法或响应字段变化。

有测试覆盖的改进：

- 并发同图上传只产生一条收件箱记录。
- 交易 apply 与收件箱状态原子提交。
- 提案、评估、草稿确认跨表事务。
- WAL 一致安全恢复。
- scheduler 重试和中止。

仍保留的既有风险：

- Income screenshot apply 跨表非原子。
- 自动 cycle 为同步长操作，timeout 不能硬中断。
- 数据库没有外键。
- Dashboard GET 有写入副作用。
