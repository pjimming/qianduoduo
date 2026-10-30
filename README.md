# 钱多多

钱多多是本地运行的个人财富工作台，统一承载银行 R2/PR2 记账、投资资料、股票调研和报告发布。前端使用 Vue 3 + TypeScript，后端使用 Node.js 24+ 与内置 SQLite。账本和原始截图只保存在本机。

- 使用与操作：[USAGE.md](USAGE.md)
- 环境初始化与分享：[SETUP.md](SETUP.md)
- Agent 执行规则：[AGENTS.md](AGENTS.md)
- 长期契约：[MEMORY.md](MEMORY.md)
- 定时任务：[codex-automations/README.md](codex-automations/README.md)

## 功能

- 理财模块包含收益概览、消息中心、每日记账、交易与持仓、产品与配置、复盘、决策与评估七个页面。
- 本金独立维护，交易由确认记录生成持仓；买入、赎回和切换必须关联决策与证据截图。
- 逐产品日收益是账户收益事实源，账户日总账在同一事务内重算；收益披露和缺口由消息中心统一提醒。
- 产品池、期限桶、持仓复核、决策提案、自动评估、月度五问和季度复盘均在应用内完成。
- 投资模块包含每日市场简报、股票调研报告库和 A 股科技产业图谱。
- 支持浅色、深色和跟随系统主题；账本、报告和科技图谱使用同一套主题契约。
- 报告和科技图谱可生成独立的 GitHub Pages 公开静态站点，R2 数据不进入公开产物。

## 页面

| 模块 | 路由 | 主要内容 |
| --- | --- | --- |
| 收益概览 | `/ledger/overview` | 目标、收益、净值、截图入口和待办 |
| 消息中心 | `/ledger/inbox` | 待补事实、提醒、确认和深链 |
| 每日记账 | `/ledger/daily` | 成交/收益截图、例外补正、每日记录、本金 |
| 交易与持仓 | `/ledger/trades` | 当前持仓净值、交易收件箱、流水和结构 |
| 产品与配置 | `/ledger/products` | 产品池、配置、持仓复核、额度与事件 |
| 复盘 | `/ledger/review` | 日/周/月评分、月度五问和季度复盘 |
| 决策与评估 | `/ledger/evaluation` | 决策日志、提案、自动评估和预测校准 |
| 每日市场简报 | `/investment/briefs` | 按日期读取收盘简报 |
| 调研报告库 | `/investment/research` | 报告筛选、全文检索和阅读 |
| A 股科技图谱 | `/investment/tech-map` | 脑图、树状和表格三种视图 |

`/` 和 `/ledger` 进入收益概览，`/investment` 进入调研报告库。

## 技术架构

- 前端使用 Vue 3 Composition API、Vite、TypeScript、Pinia 和 Vue Router。
- 后端是模块化单体：`server.js` 管理生命周期，`server/app.js` 装配应用，业务域位于 `server/modules/`，基础设施位于 `server/infrastructure/`。
- HTTP 路由统一在 `server/http/routes.js` 登记；业务写入由 service 管理事务，SQLite repository/adapter 复用 `lib/*-store.js`。
- R2 页面按需加载 Dashboard 分区，避免每次切换页面下载完整快照。
- OCR 适配器位于 `server/infrastructure/ocr/`；截图原图、交易、收益、审计和运行状态保存在本地。
- 后端数据可信链保留事实、证据、修订和审计之间的关联。
- R2 财务口径见 [MEMORY.md](MEMORY.md)，完整 API 参考见 [USAGE.md](USAGE.md#14-api-参考)。

## 启动

要求 Node.js 24 或更高版本。

```powershell
npm install
```

日常生产模式双击 `start.bat`，或运行：

```powershell
npm start
```

页面为 `http://127.0.0.1:8765`，数据库为 `data/r2_ledger.sqlite`。

开发模式双击 `start-dev.bat`，或运行：

```powershell
npm run dev:all
```

开发页为 `http://127.0.0.1:5173`。Vite 将 `/api` 代理到 `8765`，前后端文件变化会相应热更新或重启。

也可以分终端启动：

```powershell
npm run server
npm run dev
```

## 生产守护

首次部署或发布新版本：

```powershell
npm run prod:deploy
```

日常运维：

```powershell
npm run prod:status
npm run prod:start
npm run prod:restart
npm run prod:stop
```

登录自启只执行一次 `daemon.ps1 -Action start`；Supervisor 负责当前运行期间 Node 子进程异常退出后的重启。`prod:stop` 同时停用登录自启，`prod:start` 重新启用。服务只监听 `127.0.0.1`。

只读验收和样本外观察：

```powershell
npm run yield:verify
npm run yield:observe
npm run yield:observe:review
```

生产文件：

- 守护脚本：`scripts/daemon.ps1`
- 部署脚本：`scripts/deploy-production.ps1`
- PID：`run/daemon.pid`、`run/server.pid`
- 日志：`logs/daemon.log`、`logs/server-*.out.log`、`logs/server-*.err.log`

## 环境变量

复制 `.env.example` 为 `.env`，按需配置：

```dotenv
VITE_API_BASE_URL=
VITE_API_PROXY_TARGET=http://127.0.0.1:8765
```

- `VITE_API_BASE_URL`：生产 API 前缀；留空表示与页面同源。
- `VITE_API_PROXY_TARGET`：开发服务器代理目标。
- `R2_TRADE_INBOX_DIR`：成交截图归档目录。
- `R2_OCR=0`：关闭本地 OCR，截图仍可归档并人工校正。

`R2_*` 是 Node 服务环境变量，不写入 Vite 使用的 `.env`。

## 记账与评估

- `起始本金`是进入账本时已有的 R2 本金；`起始日期`之前的记录不纳入收益、缺记、完整度或目标。
- 转入/转出只改变本金，不计当日收益，并按日期重算本金快照。
- 当日持仓金额来自已确认且尚未赎回的买入成本；待确认交易和临时桥接本金不计入。
- 日收益率使用当日已确认持仓金额，不使用本金账户余额。
- `记录日参考净值`是当日本金加截至该日累计收益，只用于历史曲线和按日分析。
- 当前持仓净值是未赎回确认持仓本金加逐产品累计收益；银行市值对照不再作为工作台功能展示。
- 逐产品收益按分保存，账户日收益由当日产品合计物化；对账按收益归属日和披露 T+N 处理。

自动评估按买入日、持有期和到期/赎回三个阶段执行，默认组合目标 3%，期限 hurdle 为短期 2.5%、中期 2.8%、长期 3.0%。低置信度、证据不足或与手工评价冲突的结果进入待确认队列，可撤销。

## 每日市场简报

- 入口：`/investment/briefs`，可用 `?date=YYYY-MM-DD` 定位。
- 源文件：`market-briefs/YYYY-MM-DD.md`，只列出实际存在的日期。
- 内容固定为市场概览、风格与板块、关键事件、报告库联动、下一交易日关注和一句话结论。
- Codex 任务 `a` 每天 18:00 检查交易日；数据、构建和健康检查通过后提交当天简报及本次接口目录增量并推送 upstream。
- 已用接口保存在 `codex-automations/market-brief-api-catalog.md`；新接口验证、参数化和去重后追加。
- 简报不进入 R2 账本、报告清单或 GitHub Pages。

## 股票研究与报告

股票、主题、产业链、候选对比和公司事件研究统一使用 `serenity-skill`。默认生成静态 HTML 报告并进入报告库；用户明确要求“只分析、不要生成文件”时才省略。

- 报告源文件：`report/*.html`
- 独立归档：`research/index.html`
- 应用阅读页：`/investment/research/:slug`
- 报告清单：`src/data/stockReports.json`
- 构建产物：`src/data/reportDocs/`、`src/data/reportSearch.json`、`public/research/media/`

发布命令：

```powershell
npm run research:publish
```

命令会重建导航、清单、Vue 文档、检索索引和媒体，执行构建并重启本地服务。页面需要同时通过浅色/深色、桌面/移动和质量闸门后再提交。

GitHub Pages：

```powershell
npm run pages:build
```

公开站点只包含报告库、全部源报告、报告导航和科技图谱三视图。入口为 `https://pjimming.github.io/qianduoduo/research/`。

## A 股科技图谱

入口为 `/investment/tech-map`，数据来自 `src/data/techmap.json`，提供脑图、树状和表格视图。图谱属于 A 股产业资料，不进入 R2 账本或产品配置。

## 数据与接口

主要数据源：

- R2 账本：`data/r2_ledger.sqlite`
- 产品快照：`data/cmb_r2_*.csv`
- 市场简报：`market-briefs/*.md`
- 调研报告：`report/*.html`
- 科技图谱：`src/data/techmap.json`

完整 API、请求字段和返回口径统一维护在 [USAGE.md](USAGE.md#14-api-参考)，避免 README 与代码各维护一份。

## 备份与测试

服务启动时生成当天 SQLite 备份，默认保留最近 45 份：

```powershell
npm run db:list
npm run db:backup
npm run db:restore -- YYYY-MM-DD
```

常用验证：

```powershell
npm test
npm run check
npm run test:e2e
node --experimental-test-coverage --test
npm audit --omit=dev
```

测试使用临时 SQLite 和受控目录，不读写正式账本。
