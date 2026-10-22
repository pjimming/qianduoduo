# 阶段 3：低风险基础模块迁移

## 1. 完成范围

本阶段完成以下域的 HTTP/业务门面迁移：

- 健康检查。
- 数据库备份列表与创建。
- dashboard 查询门面。
- review workspace 查询。
- 产品 CSV 刷新、分配设置和持仓复核设置。
- 消息中心读取、确认项写入、消息状态。
- notifications 读取状态。
- 静态资源、favicon、SPA fallback。

迁移后，上述路径不再存在于 `server/http/legacy-app.js`。

## 2. 新增模块

```text
server/
  config.js
    运行根目录、dist/public、静态根目录、默认数据库

  modules/
    dashboard/
      service.js
      routes.js

    operations/
      service.js
      routes.js

    products/
      product-csv.js
      service.js
      routes.js

    notifications/
      service.js
      routes.js
```

## 3. 路由所有权

| 路径 | 新所有者 |
| --- | --- |
| `GET /api/health` | `operations` |
| `GET /api/backups` | `operations` |
| `POST /api/backups` | `operations` |
| `GET /api/dashboard` | `dashboard` |
| `GET /api/review/workspace` | `dashboard` |
| `POST /api/products/refresh` | `products` |
| `PUT /api/products/allocation` | `products` |
| `PUT /api/holding-reviews/:code` | `products` |
| `GET /api/inbox` | `notifications` |
| `POST /api/inbox/confirmations` | `notifications` |
| `POST /api/inbox/read-all` | `notifications` |
| `POST /api/inbox/:id/read` | `notifications` |
| `POST /api/inbox/:id/unread` | `notifications` |
| `POST /api/inbox/:id/snooze` | `notifications` |
| `POST /api/inbox/:id/unsnooze` | `notifications` |
| `POST /api/notifications/read-all` | `notifications` |
| `POST /api/notifications/:id/read` | `notifications` |
| `POST /api/notifications/:id/unread` | `notifications` |
| `POST /api/notifications/:id/resolve` | `notifications` |
| `/favicon.ico` | app fallback |
| 非 API 静态文件与 SPA fallback | app + static service |

## 4. Dashboard 查询门面

新增：

```js
createDashboardQueryService(repository, { todayProvider })
  -> getDashboard(today?)
  -> getWorkspace(today?)
```

`getDashboard()` 是原 `server.dashboardPayload()` 的唯一实现，包含：

- 账户收益与指标。
- 本金与产品分配。
- 交易和持仓 overview。
- 产品观察池。
- 持仓复核。
- 收益收件箱摘要。
- 逐产品收益 workspace。
- 自动评估 workspace。
- 决策提案同步。
- 消息中心同步。

兼容语义：

- 仍保留 GET 时刷新派生提案和消息中心的现有副作用。
- 未在本阶段改成纯只读，避免前端状态变化。
- `server/app.js` 和 legacy 未迁移路由现在共享同一 dashboard query service。
- 未迁移的本金、交易、收益、评估路由返回 dashboard 时不再调用 legacy 内部复制逻辑。

## 5. 产品模块

迁移内容：

- 产品 CSV 最新快照发现。
- 产品刷新。
- 分配设置范围、额度结构和期限桶校验。
- 单产品持仓复核规则。

兼容细节：

- `resolveProductCsv()` 仍优先读取 `R2_PRODUCT_CSV`。
- 刷新失败仍走 500，不改成新的 400。
- 业务校验错误仍返回原 400 文案。
- 只有 `statusCode=400` 的校验错误被转换为 400；repository 意外异常继续 500。
- 成功响应仍带完整 `dashboard`。

## 6. 通知与消息中心

迁移内容：

- 确认项字段、dedupe key、URL、日期校验。
- 写入 `agent_confirmation` notification。
- inbox read/unread/snooze/unsnooze。
- notification read/unread/resolve 与 read-all。

兼容细节：

- 确认项仍返回 201 和 `{notification, inbox_center, dashboard}`。
- inbox 操作仍返回 `{item, inbox_center, dashboard}`。
- notification 单项操作仍返回 `{notification}`。
- 404 和 400 文案保持。
- `saveNotification()` 的基础设施异常不会再被误映射为 400。

## 7. 静态资源

静态资源从 legacy request handler 移到 app fallback：

- `/favicon.ico` 204。
- 非 API GET/HEAD 使用 static service。
- 非 API 其他方法 405。
- `/api/*` 未匹配继续进入 legacy API 404。
- app 在路由前统一执行写请求同源保护。

原静态测试继续通过：

- CSP。
- gzip。
- `Vary`.
- HEAD。
- hash 资源 immutable。
- research media。

## 8. Legacy 清理

已经从 `server/http/legacy-app.js` 删除：

- health/backups 分支。
- dashboard 分支。
- products refresh/allocation 分支。
- holding-review 分支。
- review workspace 分支。
- inbox 全部分支。
- notifications 全部分支。
- favicon、静态文件、405 和 SPA fallback。

仍留在 legacy 的域：

- capital。
- records/ledger。
- trades、trade inbox、product valuations、income。
- decisions、proposals、evaluations、drafts、review CRUD/export。
- automation workspace/run/settings/jobs。

## 9. 验证

全量测试：

```powershell
node --test
```

结果：

```text
tests 174
pass  174
fail  0
```

覆盖率：

```text
line   88.69%
branch 73.41%
funcs  89.98%
```

新增阶段 3 测试：

- dashboard query service 的 today/reporting date/workspace 契约。
- health 与备份模块。
- products 固定日开额度校验和成功响应。
- dashboard/workspace API。
- inbox confirmation 和消息中心读取。
- notifications read-all。
- 静态首页与 favicon。
- 未知 API 404。

静态检查：

```powershell
npm run check
```

结果：通过，已包含全部新增模块。

## 10. 已知风险

1. Dashboard 仍是带写入副作用的查询门面，阶段 4/6 再评估是否拆 command。
2. `legacy-app.js` 仍是剩余业务域的唯一适配层，不能在本阶段删除。
3. 产品刷新/备份的 `500` 行为被保留，没有顺手修改 HTTP 错误语义。
4. 真实生产进程未重启；本阶段通过临时端口测试。
5. 数据库 schema 未变化，不需要迁移或恢复。

## 11. 回滚

本阶段未改 schema。回滚方式：

1. 从 Git diff 恢复 `server/app.js`、`server/http/legacy-app.js`、`server/http/routes.js`。
2. 删除新增 modules/config。
3. 恢复上一版 `package.json check` 和测试。
4. 重跑阶段 2 的 172 个测试基线。
