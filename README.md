# 钱多多

定时任务运行安排（2026-11-05）：已核对 Codex 的 5 个定时任务均已启用，按任务复杂度分别配置模型和推理档位，沿用原日程。

钱多多是本地运行的个人财富工作台，统一承载银行 R2/PR2 记账、投资资料、股票调研和报告发布。前端使用 Vue 3 + TypeScript，后端使用 Node.js 24+ 与内置 SQLite。账本和原始截图只保存在本机。

- 使用与操作：[USAGE.md](USAGE.md)
- 环境初始化与分享：[SETUP.md](SETUP.md)
- Agent 执行规则：[AGENTS.md](AGENTS.md)
- 长期契约：[MEMORY.md](MEMORY.md)
- 定时任务：[codex-automations/README.md](codex-automations/README.md)
- Codex 切换模型供应商后，同步检查定时任务模型与旧会话恢复配置，避免引用已移除的供应商。

## 功能

- 理财模块包含收益概览、消息中心、每日记账、交易与持仓、选品与配置、复盘、决策与评估七个页面。
- 本金独立维护，交易由确认记录生成持仓；买入、赎回和切换必须关联决策与证据截图。交易与策略版本在同一事务内绑定，动作、产品、交易腿或金额不一致时整体回滚。
- 逐产品日收益是账户收益事实源，账户日总账在同一事务内重算；收益披露和缺口由消息中心统一提醒。
- 产品池、期限桶、持仓复核、决策提案、自动评估、月度五问和季度复盘均在应用内完成。
- R2 工作日巡检在周一至周五 21:00 运行，法定节假日静默跳过；正常运行每轮都报告结果，无需用户处理时也明确说明，不为例行结果新增消息中心事项。
- 投资模块包含每日市场简报、股票调研报告库和 A 股科技产业图谱。
- 支持浅色、深色和跟随系统主题；账本、报告和科技图谱使用同一套主题契约。
- 报告和科技图谱可生成独立的 GitHub Pages 公开静态站点，R2 数据不进入公开产物。

## 页面

| 模块 | 路由 | 主要内容 |
| --- | --- | --- |
| 收益概览 | `/ledger/overview` | 目标、收益、净值、自动复盘评分、截图入口和待办 |
| 消息中心 | `/ledger/inbox` | 待补事实、提醒、确认和深链；处理完成后自动清理 |
| 每日记账 | `/ledger/daily` | 成交/收益截图、例外补正、每日记录、本金 |
| 交易与持仓 | `/ledger/trades` | 当前持仓净值、交易收件箱、流水和结构 |
| 选品与配置 | `/ledger/products` | 初筛、资金配置、持仓复核、[策略设置](http://127.0.0.1:8765/ledger/products?section=settings)；旧 `/ledger/screening` 重定向 |
| 复盘 | `/ledger/review` | 收益归因、月度五问和季度复盘 |
| 决策与评估 | `/ledger/evaluation` | 三分区：提案、决策记录、评估与校准 |
| 每日市场简报 | `/investment/briefs` | 按日期查看早盘、午盘、收盘分析 |
| 调研报告库 | `/investment/research` | 报告筛选、全文检索和阅读 |
| A 股科技图谱 | `/investment/tech-map` | 脑图、树状和表格三种视图 |

`/` 和 `/ledger` 进入收益概览，`/investment` 进入调研报告库。

“选品与配置”用 `?section=screening|allocation|holdings` 定位分区，无 `section` 默认配置；“决策与评估”用 `?section=proposals|decisions|results`，结果区可加 `view=evaluations|calibration`。旧 `/ledger/screening`、`#holding-reviews`、`#events`、`view=performance`、`#proposals`、`#decisions`、`#automation`、`#calibration` 仍兼容。

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
npm run prod:install
npm run prod:uninstall
```

生产由当前用户 Windows 计划任务 `QianDuoDuo-Production` 独立托管：只在用户登录时通过无控制台的 `wscript.exe` 启动器隐藏运行一次，拉起 Supervisor 后退出，不执行定时健康巡检，也不会周期弹出 PowerShell。运行期间由 Supervisor 负责 Node 子进程异常退出后的递增退避重启。

`prod:deploy` 构建、测试、安装/更新计划任务并通过任务启动生产；`prod:install` 和 `prod:uninstall` 用于单独管理托管。`prod:stop` 写入持久停止意图后仍保留已安装任务，但登录任务不会拉起服务；`prod:start` 清除停止意图并通过计划任务启动。服务只监听 `127.0.0.1`。

只读验收和样本外观察：

```powershell
npm run yield:verify
npm run yield:observe
npm run yield:observe:review
```

生产文件：

- 守护脚本：`scripts/daemon.ps1`
- 独立登录托管：`scripts/production-host.ps1`
- 隐藏启动模板：`scripts/production-bootstrap-template.vbs`
- 部署脚本：`scripts/deploy-production.ps1`
- PID：`run/daemon.pid`、`run/server.pid`
- 托管状态：`run/host.json`、`run/host-state.json`、`run/supervisor.json`
- 停止意图：`run/host.stop`
- 日志：`logs/host.log`、`logs/daemon.log`、`logs/server-*.out.log`、`logs/server-*.err.log`

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
- 本金管理同时展示外部净投入和交易资金联动：资金核算基数 = 净投入 + 已核实到账的赎回盈亏。收益复投更新持仓成本，保持外部转入记录不变；未到账收益和持仓浮盈不计入复投资金。持仓外账面差额包含在途、待确认及预留，不代表银行可用余额。
- 当日持仓金额来自已确认且尚未赎回的买入成本；待确认交易和临时桥接本金不计入。
- 日收益率使用当日已确认持仓金额，不使用本金账户余额。
- `记录日参考净值`是当日本金加截至该日累计收益，只用于历史曲线和按日分析。
- 当前持仓净值优先使用范围明确的银行逐产品累计收益，基准日后完整披露的日收益按原精度续算；交易范围变化、披露缺口或合并收益跨越基准日时停止续算。无有效基准时回退账本推算，原银行累计、同期账本和差额分别保留。
- 逐产品日收益以万分之一元整数保存，支持两位或四位来源；账户日收益先汇总原始整数再生成分兼容值，累计和分析继续使用原始值。历史未知精度明确标注，银行累计不伪装成日收益；对账按收益归属日和工作日 T+N 处理。

收益披露 T+N 按工作日计数，跳过周末和中国大陆法定放假日（周末调休上班不计入）；收益日不计作第 1 日。最终披露日当天仍 waiting，次日仍缺才提示。周末收益沿用周一合并披露起点，再加产品工作日 T+N；覆盖只消除缺口，不改写金额归属。日历覆盖不足时日期仅为估算、保持待核，不据此判漏记。


自动评估按决策冻结的执行/评价版本分发：v9 决策使用冻结净收益契约，退出决策须同时满足：近7日总收益率与有效同份额近1月年化低于当前策略阈值（默认 0.04410959% 和 2.3%），且同一披露日近6月年化>近3月年化>近1月年化。三项同时满足后，已可赎份额自动生成待采纳退出提案，锁定份额保留到期退出意图；缺证据待核，等于阈值或窗口年化相等不触发，不继承旧 2.5%/2.8%/3.0% hurdle；legacy 决策保留原策略、原预测和原期限 hurdle。低置信度、证据不足或与手工评价冲突的结果进入待确认队列，可撤销。


## 每日市场简报

每日市场简报入口为 `/investment/briefs`，按需读取投资科学公开 API，不调用 Serenity，也不再自行采集、整理或生成日报。日期来自源站 `/api/daily-market-analyses/dates`；正文来自 `/api/daily-market-analyses/YYYY-MM-DD` 的 `analyses`，支持早盘（morning_brief）、午盘（midday_brief）、收盘（market_overview），只显示当天已发布报告对应的时段按钮；默认最新日期，优先收盘分析，当前或链接指定时段缺失时切换至当天最新可用时段并同步链接；当天没有报告时显示未发布状态。可用 `?date=YYYY-MM-DD&period=midday_brief` 深链定位。正文保持源站 Markdown 内容，通过 DOMPurify 安全渲染；标注来源和北京时间发布时间，未发布或接口失败明确显示并允许重试，不用旧本地稿伪装成功。后端固定主机转发，不携带 Cookie 或凭证，仅短时内存缓存，不写账本或研究报告。Codex 任务 `a` 已暂停；`market-briefs/*.md` 保留为历史归档，原八章模板只约束历史手工稿，不约束接口原文。简报不进入报告清单、独立报告库或 GitHub Pages。

## 股票研究与报告

股票、主题、产业链、候选对比和公司事件研究统一使用 `serenity-skill`。默认生成静态 HTML 报告并进入报告库；用户明确要求“只分析、不要生成文件”时才省略。

- 报告源文件：`report/*.html`
- 统一正文模板：`report/report-template.css`（v1，示例 `docs/templates/report-template-example.html`）
- 共享卡片样式：`scripts/report-cards.css`；独立归档页样式 `scripts/report-library.css`
- 独立归档：`research/index.html`
- 应用阅读页：`/investment/research/:slug`
- 报告清单：`src/data/stockReports.json`
- 构建产物：`src/data/reportDocs/`、`src/data/reportSearch.json`、`public/research/media/`

新报告在 `<head>` 引入 `report-template.css` 并加 `data-report-template="v1"`，正文使用 `rp-hero`、`rp-section`、`rp-table-wrap` 等模板类，根节点为 `body.rp-doc`。应用报告库、独立归档和悬浮导航共用 `.report-card` 卡片；历史报告未加模板标记时继续按原样式渲染。

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

## R2 选品与配置

“选品与配置”分初筛、配置和持仓复核三个分区：初筛按公开销售份额记录业绩、额度、期限和净值，正式候选表示同期限、同分类的研究顺序；配置和持仓复核使用各自冻结输入，不把公开净值当作个人收益。

持仓复核增加独立的收益预警：有效近 1 月年化默认在 2.15% 至不足 2.5%，且完整月份趋势或近 7 个自然日表现走弱时，优先列入观察。证据中展示含分红影响的区间年化及零/负收益披露次数；缺少累计净值、应有披露或跨长假时相应指标待核。2.5% 只是观察参数，不是退出底线或收益预测；退出使用近7日、近1月及6/3/1月年化递减的三项联合条件，主动换仓仍核验费用与空档。预警不单独生成退出提案或消息中心待办，详见[策略口径](docs/r2-product-screening-strategy.md)。

7 日表现按未舍入的区间总收益率比较，参考线精确计算为 `2.15%×7÷365`（约 0.04123288%，界面显示约 0.04%），严格小于时预警。零/负收益次数仅展示；单日贡献较高、其余披露日挂零但整周收益达标，不因此触发预警。

交易前只做公开数据可行性校验（配额/起购/递增/期限/持有期）并保留 decision_log 与截图留痕；赎回到账核验使用交易记录的 `arrival_date` 字段。

初筛与周配置快照分别刷新，数据库默认使用本机独立的 `data/r2_screening.sqlite`。启用后由工作台在北京时间周一至周五 09:30 采集，法定放假日跳过；当天 09:30 后启动时补跑当日尚未创建的定时批次。查看使用、备份与恢复方法见 [使用手册](USAGE.md#74-选品与配置)。

## 数据与接口

主要数据源：

- R2 账本：`data/r2_ledger.sqlite`
- 产品快照：`data/cmb_r2_*.csv`；开放候选池使用 `cmb_r2_universe-*.csv`，应用组合快照使用 `cmb_r2_snapshot-*.csv`，其中未开放记录仅用于查询展示。
- 市场简报：投资科学公开 API；`market-briefs/*.md` 为历史归档
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

## 2026-11-08 策略执行入口

<!-- r2-strategy-acceptance-2026-11-08 -->
v9 统一执行层巡检：通过原有运行日闸门后读取 GET /api/r2-strategy/status 与 GET /api/r2-strategy/workspace。mode=v9 时以该工作区的 allocation、monitoring、公开可行性校验（配额/起购/递增/期限/持有期）及 stale 为当前策略依据，旧 dashboard.holding_reviews 和 CSV 仅作 legacy 历史观察。stale=true、结果缺失或接口不可用时标注待重算/待核，不退回旧算法生成当前建议，不调用策略重算、初筛刷新或自动采纳。退出决策须同时满足：近7日总收益率与有效同份额近1月年化低于当前策略阈值（默认 0.04410959% 和 2.3%），且同一披露日近6月年化>近3月年化>近1月年化。三项同时满足后，已可赎份额自动生成待采纳退出提案，锁定份额保留到期退出意图；缺证据待核，等于阈值或窗口年化相等不触发；售罄、未入前三不构成强制退出。证据待核、预留/在途资金和约束冲突按当前状态解释，已有消息只引用不重复创建。入口为 /ledger/products?section=allocation、/ledger/products?section=holdings 和 /ledger/evaluation?section=proposals。历史决策按冻结版本评价，周快照仅保留独立研究快照，旧策略样本外观察与复核提醒已停用，不切换生产模式。交易前只做公开数据可行性校验并保留 decision_log 与截图，到账核验只读取交易记录的 arrival_date 字段。

### v9 策略设置与流动性配置

在「选品与配置 → 策略设置」修改选品、期限和集中度上限、流动性、退出、预警与换仓参数。保存后可重算当前策略，修改选品条件后先刷新初筛。初筛批次与已采纳决策保留当时的设置。

工作日巡检 `r2-2` 的正文第一行与卡片标题直接说明“有 N 项待办需要你处理”或“暂无待办，无需你处理”。有待办先列具体事项、动作、消息 ID 和入口，再写巡检状态；正常等待、低置信度评估和未到复核日的观察/稍后提醒不计待办。无法核实时明确写“巡检未完成，待办状态未核实”，不报 0 项。

工作日巡检 `r2-2` 对 v9 持仓近7日收益待核项执行 `node scripts/r2-weekly-nav-check.cjs`。按招行渠道和份额去重，报告公开净值的实际7个自然日区间、复算总收益率、当前退出阈值及待核原因。持仓复核页按需查询相同的公开来源，在七日标签显示参考值，展开可查看区间、阈值与正式策略待核原因。公开净值复算只用于展示和巡检，不参与正式退出判断，也不写入个人收益、对账事实、消息中心或交易提案。

当前建议以 GET /api/r2-strategy/workspace 为准。使用 effective_contract.bucket_caps_pct 读取中期、长期上限，使用 result.allocation.bucket_limits 读取实际策略占用和超限，字段缺失标记待更新。现金需求以 cash_needs 的付款日为准，旧区间末日标注估算。过期、契约不匹配、缺结果或接口异常时标注待核。当前配置与持仓动作仅使用 v9 工作区，CSV 与样本外结果标明各自的证据和冻结版本。r2-2、r2-3 原运行日闸门和财务事实巡检继续适用。

R2 自动任务停用同步：旧策略样本外观察已按用户要求停用：`r2-4` 为 `PAUSED`，周快照不再自动采集 TD-YIELD-002 样本或触发参数复核；日常/周五巡检不创建或重开单窗口高分、667828A 排名及4/8样本里程碑提醒。历史规格、cohort、台账和报告保留，仅在用户明确恢复后重新启用。当前 v9 策略、收益对账、公开初筛与产品快照更新继续运行。
