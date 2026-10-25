# 阶段 7：股票研究报告与静态索引隔离

> 历史快照：本文记录当时的重构、审计或验收结果，不代表当前实现或运行状态。当前事实以代码、`TODO.md`、运行接口和 [文档地图](../../README.md) 为准。

## 1. 完成范围

股票研究在当前系统中是静态文件、构建索引和前端只读模块，不使用账本 SQLite，也没有后端运行时模型调用。

本阶段按“优先保留清晰模块、不为拆分而拆分”的原则：

- 为研究报告资产建立独立运行时静态边界。
- 保留 `report/` 为唯一报告源文件。
- 保留 `src/data/stockReports.json` 和 `src/data/techmap.json` 为构建索引。
- 不新增重复 API。
- 不修改任何报告正文、结论、标题、摘要或日期。

## 2. 新模块

```text
server/modules/research/
  repository.js
  static.js
  service.js
```

职责：

- `repository.js`：只读加载报告索引和科技图谱索引。
- `static.js`：判断研究静态路径归属并委托现有静态服务。
- `service.js`：提供只读索引摘要与研究静态适配器。

研究模块不访问：

- R2 SQLite。
- 交易、收益、决策或评估 store。
- OCR。
- 外部网络或模型 API。

## 3. 静态路径归属

research 模块独占：

```text
/research/stocks/*
/research/media/*
/research/scripts/*
/research/techmap/*
```

仍由 SPA fallback 处理：

```text
/investment/research
/investment/research/:slug
/investment/tech-map
/research/tech-map
```

原因：

- 报告库、报告详情和科技图谱页面是 Vue 只读构建产物。
- `/research/*` 下归档文件是独立静态资源。
- 生命周期和缓存由现有 static service 保持，不复制文件流、gzip 或 path traversal 防护。

## 4. 研究结论不变

本阶段没有修改：

- `report/*.html`
- `src/data/stockReports.json`
- `src/data/techmap.json`
- `src/views/Investment*.vue`
- DCf、估值、评级或研究结论。

Git 状态中没有 `report/` 或研究数据文件变更。

## 5. 构建与发布边界

保留现有：

- `scripts/update-nav.ps1`
- `scripts/sync-stock-reports.ps1`
- `scripts/build-report-docs.mjs`
- `npm run research:publish`

研究生成流程继续在构建/发布期完成，不进入后端请求链。

## 6. 外部服务边界

当前后端研究模块**没有外部模型调用**，因此不需要引入超时、重试或熔断器。

报告生成阶段可能由 Codex/研究脚本在构建外完成，但生成结果只落为：

- 报告 HTML。
- 报告索引 JSON。
- Vue 文档/正文索引构建产物。

这些产物具有清晰边界，不应与 R2 业务服务混写。

## 7. 验证

新增：

- `test/unit/research-service.test.js`
- `test/integration/stage7-research.test.js`

验证：

- `/investment/research` SPA 正常返回。
- `/research/stocks/:file` 返回归档报告。
- `/research/scripts/report-nav.js` 正常返回。
- `/research/techmap/index.html` 正常返回。
- `/research/tech-map` 仍走 SPA，而非被静态资产误接管。
- `/api/research` 仍保持未知 API 404。
- 报告索引 count 与 reports 数一致。
- techmap 索引可读。

全量测试：

```text
tests 184
pass  184
fail  0
```

覆盖率：

```text
line   88.49%
branch 73.14%
funcs  87.47%
```

静态检查：

```powershell
npm run check
```

通过。

生产构建：

```powershell
npm run build
```

通过；仅有既有 `reportSearch` 大 chunk 警告。

## 8. 已知风险

1. 报告索引和 Vue 文档仍由构建脚本生成，阶段 8 可继续完善构建诊断。
2. 研究静态资产仍与 SPA 共用底层 static service，这是有意复用，不是业务耦合。
3. `/research` 根目录本身不是应用路由，也没有复制独立归档页到 `public/research/index.html`。
4. 生产服务未重启。

## 9. 回滚

回滚时：

1. 恢复 `server/app.js` fallback 为直接调用 static service。
2. 删除 research module。
3. 删除阶段 7 测试。
4. 重跑阶段 6 的 182 测试基线。
