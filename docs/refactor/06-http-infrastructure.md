# 阶段 2：应用启动与 HTTP 基础设施

## 1. 完成结果

原来的 `server.js` 从 3,557 行降为 15 行，只负责：

- 导入应用与生命周期模块。
- 保持原有模块导出兼容。
- 作为主模块时调用 `startServer()`。

业务路由仍使用单一兼容 adapter，但没有复制出第二套业务实现。后续按域迁移时，只需从 legacy adapter 删除对应分支并在 `API_ROUTE_PATTERNS` 替换 handler。

## 2. 新目录与职责

```text
server.js
  入口、兼容导出、启动

server/
  app.js
    应用工厂；绑定已有 repository 并返回 HTTP Server

  lifecycle.js
    打开数据库、启动维护、调度器、HTTP listen、ready、stop、信号处理

  jobs/
    automation-scheduler.js
      自动评估启动延迟、轮询、防重入、停止

  http/
    legacy-app.js
      当前全部 API 的唯一兼容处理实现

    router.js
      精确路径/正则路径匹配，fallback 分发

    routes.js
      69 个显式 method + path 模式注册清单

    response.js
      JSON/error 响应、安全响应头

    errors.js
      统一捕获异常到旧错误响应

    static.js
      MIME、CSP、gzip、缓存、SPA fallback、路径穿越防护

    middleware/
      json-body.js
      origin.js
```

文件规模：

| 文件 | 行数 |
| --- | ---: |
| `server.js` | 15 |
| `server/app.js` | 17 |
| `server/lifecycle.js` | 142 |
| `server/http/legacy-app.js` | 3,298 |
| `server/http/routes.js` | 102 |
| `server/http/router.js` | 78 |
| `server/http/static.js` | 127 |
| `server/jobs/automation-scheduler.js` | 77 |

`legacy-app.js` 仍较大，这是阶段 2 的兼容 adapter；阶段 3–7 将按业务域逐步替换，而不是长期保留两份实现。

## 3. 路由注册

`server/http/routes.js` 的 `API_ROUTE_PATTERNS` 是当前显式 API 注册清单：

- 69 个 method + path 模式。
- 覆盖原 `server.js` 中全部 API 路径条件。
- 同一正则内的动作如 `read|unread|snooze|unsnooze`、`adopt|reject`、`generate|confirm` 保持原组合。
- 精确路径和正则路径都经过 `Router.match()`。
- 未知 API 仍落到 legacy 404 `接口不存在`。
- 静态资源、favicon 和 SPA fallback 仍由 fallback 处理，行为未变。

新增测试：

- 路由清单 method/path 不重复。
- 关键 exact、regex 和 action 路由可匹配。
- 错误方法不会错误匹配。

## 4. 中间件和响应

已抽出：

- `readJsonBody()`：保留 64 KB 默认上限、20 MB 图片请求上限调用方式、415 和现行错误文本。
- `isAllowedOrigin()`：保留跨站写入拒绝。
- `sendJson()` / `sendError()`：保留 JSON、长度、Cache-Control 和安全头。
- `handleCaughtError()`：保留原 `statusCode` 和错误 message 映射。
- 静态服务：保留 gzip、HEAD、CSP、hash 资源 immutable 缓存与 no-cache。

本轮没有修正非法 JSON 500、超限连接中断或 500 错误文本暴露问题；这些属于阶段 1 已记录的兼容行为。

## 5. 生命周期

`startServer()` 现在位于 `server/lifecycle.js`：

1. 打开数据库。
2. 默认执行每日备份、旧备份清理和截图清理。
3. 创建 automation scheduler。
4. 通过应用工厂创建 HTTP Server。
5. listen 并提供 `ready` Promise。
6. 返回 `{ server, repository, ready, stop }`。

`stop()`：

- 幂等。
- 停止启动延迟和轮询定时器。
- 关闭 HTTP Server。
- 关闭 repository。
- 可移除 SIGINT/SIGTERM handler。
- 支持测试禁用进程级 handler。

兼容说明：

- 原模块仍导出 `startServer()`。
- 默认仍绑定 `127.0.0.1:8765`。
- `PORT=0` 现在可用于测试，默认生产行为不受影响。
- 启动日志改为使用实际监听端口，生产固定端口时输出不变。

## 6. 自动化调度器

从 `startServer()` 中抽出：

- 启动延迟。
- 60 秒轮询。
- `scheduler_minutes` 门槛。
- `automation_enabled`。
- 防重入。
- `stop()` 清理。

与原实现相比的内部改进：

- 保存 startup timer，关闭时一并清除。
- 调度器级 `running` 防止 timer 与手动 run 重入。
- 定时器停止后不再启动新 cycle。

没有改变评估阈值、业务执行内容或 API。

## 7. 测试与验证

### 全量测试

```powershell
node --test
```

结果：

```text
tests  172
pass   172
fail   0
```

覆盖率：

```text
line   88.88%
branch 73.77%
funcs  90.12%
```

新增阶段 2 测试：

- 应用工厂绑定既有 repository。
- 生命周期模块使用 port 0 启动、健康检查和 stop。
- 生命周期不注册不需要的进程信号 handler。
- 自动调度器启动一次、运行 cycle、stop。
- Router 清单和规则匹配。

### 静态检查

```powershell
npm run check
```

结果：通过。

`check` 脚本已加入全部新增 `server/` 文件。

生产前端构建 `npm run build` 通过；Vite 仅保留既有的大 chunk 警告。

### API 兼容

原有 API/服务测试全部通过，包括：

- dashboard。
- 本金、账本、产品分配。
- 交易确认和部分赎回。
- 交易/收益截图。
- 产品收益。
- 决策、提案、评估、复盘。
- 静态文件、压缩、缓存和 HEAD。
- 备份和恢复。

## 8. 风险与剩余工作

1. `legacy-app.js` 仍同时包含路由参数校验和业务调用；阶段 3 起按域迁移。
2. 路由清单已显式化，但当前所有条目仍指向同一个 legacy handler。这是过渡状态，不是最终模块边界。
3. `createServer()` 仍通过 legacy app 创建；后续会改成 Router 直接注册域 routes。
4. 服务器启动错误尚未在 ready 拒绝时自动关闭 repository；属于阶段 8 生命周期加固。
5. 现有真实生产进程没有重启，因此 `http://127.0.0.1:8765` 上运行的仍是审计前版本；本轮仅通过隔离端口验证新代码。

## 9. 回滚

若阶段 2 需要回滚：

1. 将 `server/http/legacy-app.js` 恢复为入口文件内容。
2. 恢复原 `startServer()` 和原 `package.json check`。
3. 删除新增 `server/` 模块。
4. 保留/回滚测试和文档。

本阶段未改数据库 schema，不需要数据回滚。
