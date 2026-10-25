# API 基线清单

> 历史快照：本文记录当时的重构、审计或验收结果，不代表当前实现或运行状态。当前事实以代码、`TODO.md`、运行接口和 [文档地图](../../README.md) 为准。

> 阶段 2 更新：原路由实现已迁至 `server/http/legacy-app.js`；本文行号保留阶段 0 基线。当前显式 method/path 注册清单位于 `server/http/routes.js`，共 69 个模式。  
> 阶段 3 更新：health、backups、dashboard/workspace、products、inbox、notifications 和静态资源已迁出 legacy。  
> 阶段 4 更新：capital、records/CSV、product valuations/yield settings 已迁出 legacy。  
> 阶段 5 更新：trades、trade inbox、holdings compatibility 和交易 OCR 已迁出 legacy。  
> 阶段 6 更新：decisions、proposals、evaluations、reviews/drafts 和通知相关自动流程已迁出 legacy；仅剩收益截图流程仍由 legacy adapter 处理。  
> 阶段 7 更新：研究报告索引和 `/research/*` 静态资产已由独立 research 模块隔离，未新增 API。  
> 阶段 8 更新：任务调度、关闭、备份恢复和日志属于运维基础设施，不改变 HTTP API。

## 1. 契约总则

源码基线：`server.js` 提交 `b41dbc9`，审计日期 2026-10-22。

### 1.1 请求

- JSON API 使用 `application/json; charset=utf-8`；非 JSON Content-Type 返回 415。
- JSON 请求体默认上限 64 KB；成交/收益截图上传上限 20 MB，解码后的图片本体上限 10 MB。
- 写请求必须同源：`Origin.host` 必须等于 `Host`，或没有 Origin 且 `Sec-Fetch-Site != cross-site`；否则 403。
- 图片上传 JSON 形状：

```json
{
  "filename": "capture.png",
  "mime": "image/png",
  "data": "data:image/png;base64,..."
}
```

也接受不带 data URL 前缀的 Base64、`image` 字段和 `original_name` 字段。

### 1.2 响应

普通 JSON 成功响应：

```json
{ "...": "API 特定字段" }
```

普通 JSON 错误：

```json
{
  "error": "可展示给用户的错误",
  "details": "可选"
}
```

特殊冲突响应可能增加：

```json
{
  "error": "OCR 参考金额与视觉识别金额不一致，请人工确认后重试",
  "code": "OCR_AMOUNT_MISMATCH",
  "ocr_amount": 1000,
  "vision_amount": 1100,
  "checks": []
}
```

公共响应头：

- `Cache-Control: no-store`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: SAMEORIGIN`
- `Referrer-Policy: no-referrer`

### 1.3 前端消费方式

`src/api/client.ts` 的 `apiRequest()`：

- 默认 `cache: no-store`。
- 对 GET 也发送 `Content-Type: application/json`。
- 总是尝试解析 JSON。
- 非 2xx 时抛出 `Error(payload.error || 请求失败（status）)`。

前端依赖许多写接口返回新的完整 `dashboard`。迁移时仅保持“路径和字段名”不够，还必须在同一响应中提供同结构的 dashboard。

## 2. 系统、dashboard 与备份

| 行 | 方法 | 路径 | 成功状态与关键响应 | 关键错误 |
| ---: | --- | --- | --- | --- |
| 1347 | GET | `/favicon.ico` | 204 空响应 | — |
| 1353 | GET | `/api/health` | 200 `{ok, time}` | — |
| 1358 | GET | `/api/backups` | 200 `{dir, backups[]}` | 500 |
| 1364 | POST | `/api/backups` | 201 `{file, date, created, backups[]}`；当天已有则 `created:false` | 500 |
| 1371 | GET | `/api/dashboard` | 200 完整 dashboard：`meta, records, summary, windows, review, workspace, automation, capital, products, decision_proposals, inbox_center` | 500 |

`GET /api/dashboard` 会刷新交易 allocations、决策提案和消息中心，不能用普通只读查询假设验证。

## 3. 本金与产品配置

| 行 | 方法 | 路径 | 成功状态与关键响应 | 关键错误 |
| ---: | --- | --- | --- | --- |
| 1376 | POST | `/api/capital/init` | 201 `{dashboard}` | 400 校验；409 已初始化 |
| 1396 | PUT | `/api/capital/init` | 200 `{dashboard}` | 400；404 未初始化 |
| 1420 | POST | `/api/capital/events` | 201 `{event, dashboard}` | 400 日期/金额/余额不足 |
| 1438 | DELETE | `/api/capital/events/:id` | 200 `{deleted:true, dashboard}` | 400；404 |
| 1454 | POST | `/api/products/refresh` | 200 `{refreshed, dashboard}` | 400/500 文件或 CSV 错误 |
| 1463 | PUT | `/api/products/allocation` | 200 `{settings, dashboard}` | 400 |
| 1564 | PUT | `/api/holding-reviews/:productCode` | 200 `{setting, dashboard}` | 400；弃用字段/非法范围 |

本金输入：

- POST/PUT init：`initial_principal > 0`，`initial_date` 合法且不晚于今天。
- POST event：`{event_date, event_type: deposit|withdraw, amount, note}`。

产品分配 patch 可含：

- `principal_override`
- `liquidity_floor_pct`
- `max_single_pct`
- `max_issuer_pct`
- `target_slice_pct`
- `cashflow_0_3 / cashflow_3_6 / cashflow_6_12`
- `bucket_targets`
- `quota_by_code`
- `daily_open_target_pct` 只能等于固定值 0

## 4. 复盘 workspace 与消息中心

| 行 | 方法 | 路径 | 成功状态与关键响应 | 关键错误 |
| ---: | --- | --- | --- | --- |
| 1659 | GET | `/api/review/workspace` | 200 `{workspace}` | 500 |
| 1666 | GET | `/api/inbox` | 200 `{inbox_center}` | 500 |
| 1675 | POST | `/api/inbox/confirmations` | 201 `{notification, inbox_center, dashboard}` | 400 dedupe/title/message/category/level/severity/action URL/due date |
| 1756 | POST | `/api/inbox/read-all` | 200 `{inbox_center, dashboard}` | 500 |
| 1766 | POST | `/api/inbox/:id/read` | 200 `{item, inbox_center, dashboard}` | 400；404 |
| 1766 | POST | `/api/inbox/:id/unread` | 同上 | 同上 |
| 1766 | POST | `/api/inbox/:id/snooze` | 同上；body `{until:YYYY-MM-DD}` | 400；404 |
| 1766 | POST | `/api/inbox/:id/unsnooze` | 同上 | 400；404 |

`POST /api/inbox/confirmations` 是 Codex 定时任务向消息中心写入待确认事项的正式入口。`dedupe_key` 必须为 3–160 位字母、数字、冒号、下划线或连字符。

## 5. 自动化、提案、评估、通知和复盘草稿

| 行 | 方法 | 路径 | 成功状态与关键响应 | 关键错误 |
| ---: | --- | --- | --- | --- |
| 1795 | GET | `/api/automation/workspace` | 200 `{automation}` | 500 |
| 1802 | GET | `/api/decision-proposals` | 200 `{decision_proposals, dashboard}` | 500 |
| 1811 | POST | `/api/decision-proposals/:id/adopt` | 200 `{result:{proposal,decision}, dashboard}` | 400；404 |
| 1811 | POST | `/api/decision-proposals/:id/reject` | 200 `{result:{proposal}, dashboard}` | 400；404；已有交易时拒绝 |
| 1845 | POST | `/api/automation/run` | 200 成功或 500 失败：`{ok, run_id, summary?, error?, automation, dashboard}` | 失败仍返回自动化 workspace |
| 1858 | PUT | `/api/automation/settings` | 200 `{settings, automation}` | 400 范围/固定策略 |
| 1925 | POST | `/api/evaluations/:id/apply` | 200 `{evaluation, automation, dashboard}` | 400 无明确结论；404 |
| 1963 | POST | `/api/evaluations/:id/undo` | 200 `{evaluation, automation, dashboard}` | 400；404 |
| 1988 | POST | `/api/notifications/read-all` | 200 `{notifications[]}` | 500 |
| 1995 | POST | `/api/notifications/:id/read` | 200 `{notification}` | 404 |
| 1995 | POST | `/api/notifications/:id/unread` | 200 `{notification}` | 404 |
| 1995 | POST | `/api/notifications/:id/resolve` | 200 `{notification}` | 404 |
| 2011 | POST | `/api/automation/jobs/:id/resolve` | 200 `{job, automation}` | 400 非法 status；404 |
| 2041 | GET | `/api/review/drafts/monthly/:YYYY-MM` | 200 `{draft}` | 400 非法周期 |
| 2041 | GET | `/api/review/drafts/quarterly/:YYYY-QN` | 200 `{draft}` | 400 |
| 2041 | POST | `/api/review/drafts/monthly/:YYYY-MM/generate` | 200 `{draft, automation}` | 400 |
| 2041 | POST | `/api/review/drafts/quarterly/:YYYY-QN/generate` | 200 `{draft, automation}` | 400 |
| 2041 | POST | `/api/review/drafts/monthly/:YYYY-MM/confirm` | 200 `{draft, note, dashboard}` | 400 draft 不存在 |
| 2041 | POST | `/api/review/drafts/quarterly/:YYYY-QN/confirm` | 200 `{draft, note, dashboard}` | 400 |

自动设置允许：

- `target_annualized`
- `hurdle_short / hurdle_medium / hurdle_long`
- `liquidity_floor_pct`
- `single_product_cap_pct`
- `bucket_tolerance_pp`
- `auto_confidence_threshold`
- `scheduler_minutes`
- `automation_enabled`
- `notifications_enabled`
- `auto_confirm_reviews`
- `rule_version`
- `strategy_version`
- `daily_open_target_pct` 固定为 0

## 6. 收益截图与逐产品收益

| 行 | 方法 | 路径 | 成功状态与关键响应 | 关键错误 |
| ---: | --- | --- | --- | --- |
| 2094 | GET | `/api/income/inbox` | 200 `{inbox[]}` | 500 |
| 2101 | POST | `/api/income/inbox/prune` | 200 `{removed, threshold, inbox[]}` | 400 保留天数 30–3650 |
| 2120 | POST | `/api/income/inbox` | 新图 201；重复图 200。含 `inbox, record, duplicate, auto_applied, apply_error, saved_valuations, valuation_conflicts, missing_product_codes, reconciliation, income_conflict, income_ignored, ocr, dashboard` | 400 图片格式/内容；500 OCR 后异常 |
| 2233 | GET | `/api/income/inbox/:id/image` | 200 图片二进制；`no-store` | 404 |
| 2264 | POST | `/api/income/inbox/:id/apply` | 200 `{inbox, record, duplicate, matched_existing, ignored, overwritten, conflict, saved_valuations, valuation_conflicts, missing_product_codes, reconciliation, dashboard}` | 400 日期/金额/产品；404 |
| 2320 | POST | `/api/income/inbox/:id/ignore` | 200 `{inbox, dashboard}` | 404 |
| 2340 | GET | `/api/product-valuations` | 无 `product_code`：`{valuations, ...workspace}`；有 `product_code`：`{detail}` | 400；500 |
| 2363 | GET | `/api/product-yield-settings` | 200 `{settings[]}` | 500 |
| 2372 | PUT | `/api/product-yield-settings/:code` | 200 `{setting, dashboard}` | 400 代码/延迟/来源/核验日期 |
| 2394 | POST | `/api/product-valuations` | 新值 201；同日同产品不同值 200 并带 `conflict`。`{valuation, conflict, notification_id, dashboard}` | 400 日期/到账日/金额 |
| 2443 | PUT | `/api/product-valuations/:id` | 200 `{valuation, conflict, dashboard}` | 400；404 |

收益截图 apply 的 body 可覆盖：

```json
{
  "date": "YYYY-MM-DD",
  "daily_pnl": 0,
  "action": "无操作",
  "notes": "",
  "products": [
    {
      "product_code": "120056A",
      "product_name": "示例产品",
      "yield_date": "YYYY-MM-DD",
      "credit_date": "YYYY-MM-DD",
      "daily_pnl": 0,
      "holding_amount": 10000,
      "confidence": 95
    }
  ]
}
```

## 7. 交易流水

| 行 | 方法 | 路径 | 成功状态与关键响应 | 关键错误 |
| ---: | --- | --- | --- | --- |
| 2504 | GET | `/api/trades` | 200 `{overview, inbox[]}` | 500 |
| 2512 | POST | `/api/trades` | 201 `{trade, overview, dashboard}` | 400 校验；400 决策不存在；409 重复交易 |
| 2552 | POST | `/api/trades/:id/confirm` | 200 `{trade, overview, dashboard}` | 400 日期/状态；404；409 重复确认 |
| 2599 | POST | `/api/trades/:id/cancel` | 200 `{trade, overview, dashboard}` | 400；404 |
| 2632 | GET | `/api/trades/:id/audit` | 200 `{audits[]}` | 404 |
| 2645 | PUT | `/api/trades/:id` | 200 `{trade, overview, dashboard}` | 400；404；409 |
| 2700 | POST | `/api/trades/inbox/prune` | 200 `{removed, threshold, inbox[]}` | 400 |
| 2724 | GET | `/api/trades/inbox` | 200 `{inbox[], overview}` | 500 |
| 2732 | POST | `/api/trades/inbox` | 新图 201；重复图 200。`{inbox, duplicate, ocr, overview}` | 400 图片；500 OCR 后异常 |
| 2785 | GET | `/api/trades/inbox/:id/image` | 200 图片二进制；`no-store` | 404 |
| 2816 | POST | `/api/trades/inbox/:id/apply` | 200 `{inbox, trade, matched, duplicate, overview, dashboard}` | 400；404；409 |
| 2870 | POST | `/api/trades/inbox/:id/vision-apply` | 200 `{inbox, trade, checks, vision:true, overview, dashboard}` | 400；404；409 `OCR_AMOUNT_MISMATCH` / `OCR_CODE_MISMATCH` / `UNKNOWN_PRODUCT_CODE` / `NO_MATCHING_TRADE` |
| 2866 | POST | `/api/trades/inbox/:id/ignore` | 200 `{inbox, overview}` | 404 |
| 3030 | PUT | `/api/trades/inbox/:id` | 200 `{inbox, overview}` | 400；404 |

交易输入关键字段：

- `trade_date`
- `confirm_date`
- `trade_type: buy|redeem|switch`
- `status: pending|confirmed|cancelled`
- `product_code`, `product_name`, `issuer`, `risk_level`
- `amount`, `settlement_amount`, `shares`
- `term_days`, `maturity_date`
- 切换目标产品字段
- `decision_id`, `notes`

业务约束：

- 交易金额 > 0。
- `confirm_date` 不早于交易日，不晚于今天。
- `confirmed` 交易有确认日；非 confirmed 会清空确认日。
- 确认日决定期限起算和持仓起点。
- `pending` 不影响正式持仓。

## 8. 决策、兼容持仓、事件、笔记与导出

| 行 | 方法 | 路径 | 成功状态与关键响应 | 关键错误 |
| ---: | --- | --- | --- | --- |
| 3057 | POST | `/api/review/decisions` | 201 `{decision, dashboard}` | 400 必填证据/策略/日期 |
| 3073 | PUT | `/api/review/decisions/:id` | 200 `{decision, dashboard}` | 400；404 |
| 3095 | DELETE | `/api/review/decisions/:id` | 200 `{deleted:true, dashboard}` | 404；409 已关联未撤销交易 |
| 3126 | POST | `/api/review/holdings` | 201 `{holding, dashboard}` | 400 |
| 3141 | PUT | `/api/review/holdings/:id` | 200 `{holding, dashboard}` | 400；404 |
| 3162 | DELETE | `/api/review/holdings/:id` | 200 `{deleted:true, dashboard}` | 404 |
| 3175 | POST | `/api/review/events` | 201 `{event, dashboard}` | 400 |
| 3190 | PUT | `/api/review/events/:id` | 200 `{event, dashboard}` | 400；404 |
| 3211 | DELETE | `/api/review/events/:id` | 200 `{deleted:true, dashboard}` | 404 |
| 3224 | PUT | `/api/review/notes/:YYYY-MM` | 200 `{note, dashboard}` | 400 回答数量/长度 |
| 3243 | PUT | `/api/review/quarterly/:YYYY-QN` | 200 `{note, dashboard}` | 400 |
| 3260 | GET | `/api/review/export?month=YYYY-MM` | 200 `text/markdown` 附件，`r2-review-YYYY-MM.md` | 400 月份 |

`/api/review/holdings` 是兼容接口：

- POST 创建 confirmed 买入交易。
- PUT 修改对应交易。
- DELETE 撤销对应交易。
- 响应中的 `holding` 是交易映射出的兼容视图，不是旧 `holdings` 表的新记录。

决策必填：

- `date`
- `product_name`
- `action: 买入|赎回|切换|观察`
- `reason`
- `expectation`
- `invalidation_condition`
- `evidence_date`
- `verify_date`
- `strategy_version`
- `target_annualized`
- `bucket_plan`
- `evaluation_at`

## 9. 账户收益

| 行 | 方法 | 路径 | 成功状态与关键响应 | 关键错误 |
| ---: | --- | --- | --- | --- |
| 3302 | POST | `/api/records` | 新记录 201；同日同额 200 duplicate；同日异额 200 conflict。含 `{record, duplicate, changed, conflict, dashboard}` | 400 未初始化/日期/金额；唯一约束 |
| 3377 | PUT | `/api/records/:YYYY-MM-DD` | 200 `{record, dashboard}` | 400 修改日期/输入；404 |
| 3412 | DELETE | `/api/records/:YYYY-MM-DD` | 200 `{deleted:true, dashboard}` | 404 |
| 3423 | GET | `/api/export.csv` | 200 `text/csv; charset=utf-8`，带 BOM，文件名 `r2-daily-log-YYYY-MM-DD.csv` | 500 |

账户收益幂等语义：

- 同日期金额差 ≤ ¥0.005 视为相同。
- 同日期不同金额不覆盖原记录，返回 conflict 并创建确认提醒。
- 0 元是有效账户收益。

## 10. 兜底与静态内容

| 行 | 条件 | 行为 |
| ---: | --- | --- |
| 1262–1329 | 非 API GET/HEAD | 从 `dist/`（存在时）或 `public/` 提供文件；无扩展名找不到时回退 `index.html` |
| 1282 | 解码路径失败 | 400 |
| 1273 | 路径穿越 | 403 |
| 1282/1292 | 静态文件不存在 | 404 `{error:"页面不存在"}` |
| 1316 | HTML | 加 CSP；可压缩资源按 `Accept-Encoding` gzip |
| 1318 | 带 hash 的 assets/research media | 一年 immutable 缓存 |
| 3436 | 未匹配 `/api/` | 404 `{error:"接口不存在"}` |
| 3441 | 非 API 非 GET/HEAD | 405 `{error:"请求方法不支持"}` |
| 3450 | 未捕获异常 | 若 `error.statusCode` 存在使用之，否则 500；返回异常 message |

## 11. HTTP 契约中的已确认缺口

1. `/api/income/inbox/:id/image` 和 `/api/trades/inbox/:id/image` 外层条件只匹配 `GET`，内部虽有 `HEAD` 分支，实际 HEAD 不会进入该路由。
2. 非法 JSON 抛出的错误没有 `statusCode`，当前返回 500，而不是 400。
3. 超过大小上限时先 `request.destroy()`，客户端可能收到连接中断而不是稳定的 JSON 413。
4. 未捕获 500 返回底层 `error.message`，可能泄露内部路径或 SQL 信息。
5. 各写接口的 400/409/404 判断直接写在路由分支内，缺少统一业务错误映射；迁移时不得只按状态码文本搜索，必须按接口锁定响应。

这些行为在阶段 1 先以 characterization test 固定；若决定修正，应作为独立兼容变更记录。
