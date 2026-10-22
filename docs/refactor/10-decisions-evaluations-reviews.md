# 阶段 6：决策、提案、评估与复盘

## 1. 完成范围

以下域已从 legacy 迁出：

- 决策 CRUD。
- 决策提案读取、采纳和拒绝。
- 自动评估 workspace、运行、设置、人工 apply/undo 和任务处理。
- 产品事件 CRUD。
- 月度五问和季度复盘清单。
- 复盘草稿读取、生成和确认。
- Markdown 月度复盘导出。

通知 REST 状态接口已在阶段 3 迁入 notifications 模块；本阶段没有恢复或复制通知实现。

## 2. 新模块

```text
server/modules/
  decisions/
    validation.js
    repository.js
    service.js
    routes.js

  proposals/
    repository.js
    service.js
    routes.js

  evaluations/
    repository.js
    service.js
    routes.js

  reviews/
    validation.js
    export.js
    repository.js
    service.js
    routes.js
```

## 3. 规则与阈值兼容

迁移时保持：

- 决策动作和评级枚举。
- 必填理由、预期、失效条件、证据日期和验证日期。
- 期限桶策略版本与决策 bucket 规则。
- `evaluation_at` 只允许 `buy_day/holding/maturity`。
- 自动设置的所有数值范围。
- 每日日开目标固定 0%。
- 原有 rating、rule_version、阈值、置信度和评估规则。

没有修改产品策略、资产配置规则或历史评分。

## 4. 跨表事务

新增共享事务协调器：

```text
server/infrastructure/database/transaction.js
```

以下用例现在显式使用事务：

- 采纳/拒绝提案。
- 评估 apply。
- 评估 undo。
- 删除决策并解除提案/丢弃待评估。
- 确认复盘草稿。

### 故障注入验证

新增 `test/integration/stage6-transactions.test.js`：

1. `decision_proposals` 更新失败：
   - 提案保持 pending。
   - 不产生孤立决策。
2. `evaluation_runs` 更新失败：
   - 决策 rating 保持“待评估”。
   - actual_result 保持空。
3. `review_drafts` 更新失败：
   - 不生成复盘 note。
   - 草稿保持 draft。

三个场景均通过。

## 5. 自动评估

`evaluations` 模块负责：

- `GET /api/automation/workspace`
- `POST /api/automation/run`
- `PUT /api/automation/settings`
- `POST /api/evaluations/:id/apply`
- `POST /api/evaluations/:id/undo`
- `POST /api/automation/jobs/:id/resolve`

实现仍调用现有 `automation-store`，保留：

- 评估历史 `evaluation_runs`
- rule_version
- 人工结果保护
- 待确认任务
- 评估撤销
- 通知生成

## 6. 提案

`proposals` 模块负责：

- `GET /api/decision-proposals`
- `POST /api/decision-proposals/:id/adopt`
- `POST /api/decision-proposals/:id/reject`

采纳只创建待执行决策，不创建交易；拒绝和过期的现有语义不变。

## 7. 复盘

`reviews` 模块负责：

- 产品事件增改删。
- 月度五问。
- 季度清单。
- 月/季草稿读取、生成和确认。
- Markdown 导出。

Markdown 生成函数整体移至 `reviews/export.js`，没有改写文案、表格或指标口径。

## 8. Legacy 清理

`server/http/legacy-app.js` 中已删除：

- `/api/automation/*`
- `/api/decision-proposals/*`
- `/api/evaluations/*`
- `/api/review/decisions/*`
- `/api/review/events/*`
- `/api/review/notes/*`
- `/api/review/quarterly/*`
- `/api/review/drafts/*`
- `/api/review/export`
- 决策/事件/复盘笔记校验、Markdown 导出、评估同步函数和相关常量。

legacy 目前仅剩收益截图流程和未知 API 404。

## 9. 验证

```powershell
node --test
```

结果：

```text
tests 182
pass  182
fail  0
```

覆盖率：

```text
line   88.41%
branch 73.10%
funcs  87.36%
```

验证：

```powershell
npm run check
npm run build
```

均通过；Vite 仅保留既有大 chunk 警告。

## 10. 已知风险

1. 自动评估规则仍主要由 `lib/automation-store.js` 持有，本阶段迁移的是 HTTP/service/repository 边界。
2. dashboard GET 仍会同步提案和消息中心，保留阶段 0 记录的历史副作用。
3. 自动 cycle 失败仍可能留下已完成的非事务性批次，阶段 8 继续处理任务恢复。
4. 收益截图仍由 legacy adapter 处理。
5. 生产进程未重启，未触碰真实评估或复盘数据。

## 11. 回滚

本阶段无 schema 变化。回滚：

1. 恢复 `server/app.js`、`server/http/legacy-app.js` 和 route manifest。
2. 恢复 `package.json check`。
3. 删除 decisions/proposals/evaluations/reviews 模块和事务测试。
4. 重跑阶段 5 的 179 测试基线。
