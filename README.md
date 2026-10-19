# 钱多多

钱多多是一个本地运行的个人财富工作台，左侧分为“理财”和“投资”两个模块。理财模块是 R2 每日收益账本，投资模块包含股票调研报告库与 A 股科技产业图谱。前端使用 Vue 3 + Vite + TypeScript，后端继续使用 Node.js 内置 HTTP 与 SQLite。数据只保存在本机，不上传账户信息。

> 第一次使用？先读 [使用手册（USAGE.md）](USAGE.md)：包含日常操作、R2 与投研流程、三个配套 skill 的用法和常用命令。

> 要把项目分享给其他人？按 [环境初始化与分享指南（SETUP.md）](SETUP.md) 重建 skill、Codex 定时任务和应用设置；不要复制个人账本、成交截图或 API Key。

## 功能

- 左侧菜单分为“理财”和“投资”两组并支持折叠：理财下是 R2 收益账本，投资下是科技全景图与调研报告。
- 本金作为独立账户管理：首次进入初始化起始本金，后续用转入/转出维护；每日收益记录自动读取该日适用的本金。
- 记录每日收益、操作与备注；收益表单不再要求填写本金或 R2 流动性仓。
- 自动计算日收益率、累计收益、账户净值、净值指数、最大回撤和近 7/30/90 日年化。
- 绘制累计收益曲线，以及每日收益柱状图和收益率折线；累计收益曲线不随本金变化调整。
- 自动复盘：日卡显示当日收益、月累计、操作与备注；周卡按周一至周日统计本周收益、记录天数、连续负收益和操作次数；月卡显示年化、最大回撤、负收益天数占比、最好/最差单日、目标进度、环比和记录完整度。月中只显示“进行中”和参考区间，月末且满 28 天、20 条记录后才落最终评级。
- 复盘工作台：决策日志、交易流水、交易收件箱、持仓结构、产品事件、自动评估、月度五问、季度复盘八个标签页；含日/周/月/季时间轴、集中度与到期阶梯、Markdown 月度导出。
- 自动评估：买入日检查流程与期限桶，持有期按月检查组合收益/流动性/产品事件，到期或赎回按实际年化与期限 hurdle 评价；高置信度自动写入，低置信度进入待确认队列，可撤销并恢复原评价。
- 自动复盘：本地服务每 5 分钟巡检到期、待确认、对账、评估和草稿；月度/季度草稿自动汇总并预填五问，通知按事件去重，Codex 判断队列持久保存。
- 交易流水是持仓的唯一事实源：买入生成批次，赎回按批次先进先出匹配并计算已实现收益；待确认交易单独显示，不提前进入持仓、期限阶梯和流动性比例。
- 交易收件箱支持本地拖入招行成交截图：每日巡检以视觉识别读取原图（多笔总览自动按行切分），Windows 本地 OCR 只做金额与代码的交叉校验，冲突时拒绝写入；原图只保存在 `data/trade-inbox/`，不上传银行。
- 支持修改、删除记录，支持导出台账 CSV。
- 每日记录支持 10/20/50/全部条数、上一页/下一页和页码快速跳转；点击日期、当日收益、日收益率、本金、账户净值表头即可切换排序和升降序。
- 展示带数据日期、来源提示和风险边界的 R2 产品观察池；默认按近 1 年收益率降序，支持按近 1/3/6/12 月收益率切换升序或降序。

## 技术栈

- Vue 3，Composition API，`<script setup lang="ts">`
- Vite + TypeScript
- Pinia
- Vue Router
- Node.js 24+、内置 `node:sqlite`

前端目录：

```text
src/
  api/            API 请求封装
  components/     页面组件
  composables/    格式化、图表布局、Toast 等复用逻辑
  router/         Vue Router
  stores/         Pinia 全局状态
  styles/         全局样式
  types/          TypeScript 类型
  views/          路由页面
```

## 启动

要求 Node.js 24 或更高版本（使用内置 `node:sqlite`）。

首次使用先安装依赖：

```powershell
npm install
```

日常直接双击 `start.bat`。脚本会自动构建前端并启动 `http://127.0.0.1:8765`，这是稳定的生产模式。

需要修改 Vue、TypeScript 或 CSS 并自动热更新时，双击 `start-dev.bat`，或运行：

```powershell
npm run dev:all
```

开发模式页面为 <http://127.0.0.1:5173>。如果 `8765` 后端尚未运行，脚本会同时用 `node --watch` 启动后端；Vue/CSS 修改由 Vite HMR 即时更新，`server.js`、`lib/` 修改会自动重启后端。

也可以手动分两个终端启动：

```powershell
# 终端 1：启动 API 和 SQLite 后端
npm run server

# 终端 2：启动 Vite 开发服务器
npm run dev
```

打开 <http://127.0.0.1:5173>。Vite 会把 `/api` 代理到 `http://127.0.0.1:8765`。手动启动后端时，`server.js` 修改后需要重启后端。

生产构建与启动：

```powershell
npm run build
npm run server
```

或使用 `npm start` 一次完成构建和服务启动。数据库文件在 `data/r2_ledger.sqlite`。

## 生产守护部署（Windows）

首次部署或发布新版本时运行：

```powershell
npm run prod:deploy
```

脚本会依次执行生产构建、回归测试、后台守护进程启动和健康检查，并尝试注册计划任务 `QianDuoDuo-Production`。该任务在用户登录后启动，并每 5 分钟检查一次守护进程是否存活。如果当前用户没有创建计划任务的权限，脚本会自动把启动快捷方式安装到当前用户的 Startup 目录。

日常运维命令：

```powershell
npm run prod:status
npm run prod:start
npm run prod:restart
npm run prod:stop
```

- 生产地址：`http://127.0.0.1:8765`
- 守护脚本：`scripts/daemon.ps1`
- 部署脚本：`scripts/deploy-production.ps1`
- PID 文件：`run/daemon.pid`、`run/server.pid`
- 日志目录：`logs/`（`daemon.log` 记录守护事件，`server-*.out.log` / `server-*.err.log` 记录 Node 输出）
- 服务只监听 `127.0.0.1`；`prod:stop` 会停止并暂时禁用自动巡检，`prod:start` 会重新启用。

## 环境变量

复制 `.env.example` 为 `.env`，按需修改：

```dotenv
VITE_API_BASE_URL=
VITE_API_PROXY_TARGET=http://127.0.0.1:8765
```

- `VITE_API_BASE_URL`：生产环境 API 前缀；留空表示与页面同源。
- `VITE_API_PROXY_TARGET`：Vite 开发服务器的 API 代理目标。
- `R2_TRADE_INBOX_DIR`：成交截图归档目录，默认 `data/trade-inbox/`。
- `R2_OCR=0`：关闭本地 OCR；截图仍会归档，可手工填写交易字段。

`R2_*` 是 Node 服务进程的环境变量，不写入 Vite 使用的 `.env`；需要时在启动脚本或系统环境变量中设置。

## 已安装的 npm 包

运行时依赖：

- `vue`
- `pinia`
- `vue-router`

开发依赖：

- `vite`
- `@vitejs/plugin-vue`
- `typescript`
- `vue-tsc`
- `@types/node`

项目没有通过 CDN 引入第三方库，也没有 jQuery 插件。

## 记账口径

- `起始本金`：进入账本时已有的 R2 本金，不含累计收益和组合外应急金。
- `转入/转出`：只改变本金，不计入当日收益；系统会按日期重算历史记录中的本金快照。
- `当日本金`：起始本金 + 该日期及之前的累计转入 − 累计转出，由本金账户自动计算。
- `当日收益`：当天收益金额，亏损填负数。
- `账户净值`：当日本金 + 至今累计收益。
- `日收益率`：当日收益 ÷ 当日本金。
- `月收益率`：当月累计收益 ÷ 当月平均本金；当前未结束月份标记为“月中参考”。
- 每日记录不包含 `R2 流动性仓` / `cash_balance`。

月度评级标准：低于 0.16% 为不及格，0.16% 为及格，0.20% 为良好，0.25% 为优秀，0.30% 及以上为卓越。月份不满 28 个自然日或记录少于 20 条时只标记“样本不足/进行中”，不参与最终评级。

页面右上角导出的 CSV 字段为 `date,principal,daily_pnl,action,notes`，可直接用于技能的 `review.py`；缺少 `cash_balance` 时按“无流动性仓”处理。

## 复盘工作台

首页“自动复盘”下方是复盘工作台，包含八个标签页：

- **决策日志**：记录买入、赎回、切换或观察的理由、预期、实际结果和事后评价。事后评价分四类，其中“流程错误，结果好”会被单独标黄，因为它最容易让人误以为流程有效。
- **交易流水**：记录交易日期、确认日期、买入/赎回/切换、产品、金额、份额、状态、关联决策和备注。赎回支持部分赎回，并按买入批次先进先出匹配；到账金额与赎回本金的差额计入已实现收益。已撤销交易保留原始记录和修改留痕。
- **交易收件箱**：拖入 PNG/JPEG/WebP 成交截图后进入人工校正；一张图含多笔时可用 `node scripts/split-trade-rows.mjs <图片> <输出目录>` 自动按行切分。视觉写入走 `POST /api/trades/inbox/:id/vision-apply`，接口会用本地 OCR 的金额与代码做交叉校验，两者冲突、产品未收录或找不到匹配交易时一律 409 拒绝，转人工确认。同一图片按 SHA-256 去重，同一笔业务按交易日期、类型、产品、金额和状态去重；截图显示“已确认”时会把同字段的待确认交易直接匹配并确认，避免迁移记录重复入账。已处理或已忽略的原图默认在 180 天后清理，业务字段和流水保留。
- **持仓结构**：持仓由已确认买入批次自动推导，不再手工维护快照；自动计算单只/单发行方集中度、日开+30 天内占比、未来 12 个月到期阶梯和已到期提醒。期限 0 表示日开，不生成到期日。
- **产品事件**：记录费率、经理、底层、赎回规则、额度等变化，可标记“待复核/已处理”；高影响且待复核的事件会单独提示。
- **自动评估**：按买入日、持有期月度、到期/赎回三个节点生成评估。买入日检查理由、预期、期限桶、流动性、单只上限；持有期只看组合级收益，因为目前没有逐产品每日净值；到期/赎回用批次本金、持有天数、到账金额计算实际年化。评估记录规则版本、证据、置信度和写入前后快照，可撤销。
- **月度五问 / 季度复盘**：按周期保存五问或六问答案、结论和“下月只改一件事”。月度结论会同步显示在月度评分卡的历史月份里，选中有“已复盘”标记的月份即可查看。
- **时间轴**：按日、周、月、季显示当前该做哪一层；优先高亮当天记录，其次是周五开始的周检查、月度五问和季度清单。

待确认、可撤单的交易只计入“待确认金额”，确认后才按确认日校准起息和到期日并进入已确认持仓。对账视图会提示缺少截图、截图金额或代码与流水不一致、待确认时间过长、赎回到账金额缺失和未处理截图。

评估默认把 3% 当作组合进取目标；单只结果按期限 hurdle 判断：短期限 2.5%、中期限 2.8%、长期限 3.0%，可在“自动评估 → 评估设置”中修改。置信度默认达到 75% 才自动写入，低置信度、到账金额缺失或与手工评价冲突时停在待确认队列。所有自动评估都可以撤销，交易流水不会被自动删除。

本地服务启动时补跑一次巡检，之后默认每 5 分钟运行；可在设置中调整间隔。截图歧义、评估复核和复盘总结会进入“Codex 判断队列”，桌面端未运行也不会丢失。已注册每日 21:00 的 Codex 定时任务“钱多多R2每日巡检（含队列处理）”，先处理判断队列再做账本巡检；队列为空且无异常时保持安静。

月度复盘可在“月度五问”标签页一键导出 Markdown，内容包含月度指标、目标进度、环比、决策日志、产品事件、五问、结论和当前持仓快照。导出的持仓是导出时的当前快照，不是月末快照。

## 产品观察池边界

产品区不是实时行情，也不是买入建议。应用先加载 `data/cmb_r2_universe-YYYY-MM-DD.csv` 普通可买候选池（2026-10-19 为 432 只），再按评分、期限桶、本金、已确认持仓、待确认买入、流动性下限、未来现金流和逐只额度动态决定买什么、买多少。产品数量不再固定；目标金额、期限桶金额、未分配金额和额度状态会一起展示。完整候选池可在“查看全部产品”中筛选。当前规则剔除美元、私行/私银/私享/尊享/企享/专属/私募、成立不足 12 个月和缺 1M/3M/6M/1Y 历史的产品，并对 1Y 明显高于 6M 的前视偏差扣分。实时额度仍需在招行 App 核验；公开 CSV 缺失时只给分配上限并标记“额度未核验”。

全量池由 `npm run r2:refresh-all`（`scripts/fetch-cmb-r2-all.cjs`）刷新：脚本读取招行理财产品统一查询平台公开接口，生成 `cmb_r2_all-*.csv`（全量原始）、`cmb_r2_universe-*.csv`（普通可买候选池）和 `cmb_r2_selected-*.csv`（研究观察池，不含资金分配），并刷新应用。也可以用 `R2_PRODUCT_CSV` 指定候选池路径。页面“刷新快照”会重新解析 `data/` 下日期最新的 universe CSV，找不到时回退到旧的 `cmb_r2_products*.csv`。

购买前必须以招行 App、产品说明书和当日公告为准。R2/PR2 不等于保本，历史年化不代表未来收益。

## 研究资料模块

### 股票调研报告库

- 入口：`/investment/research`，是左侧“投资”的默认页面；`/investment` 也会跳转到这里。
- 内容：13 篇股票、产业链与板块调研报告，按调研日期倒序排列；支持元数据筛选、正文全文检索（命中后跳到对应章节）、研究优先级标签。
- 详情：`/investment/research/:slug`，报告由 Vue 直接渲染（无 iframe），打开即为报告正文；顶部提供返回报告库和可搜索的报告切换器，左侧目录可折叠并随滚动高亮当前章节，另支持阅读进度、`←/→` 切换报告、打印和打开独立 HTML。
- 源文件：报告统一放在本工作区 `report/`；独立报告库归档页为 `research/index.html`。
- 数据：`src/data/stockReports.json` 由同步脚本从 `report/` 生成，包含标题、日期、分类、摘要、关键词和研究优先级。
- 应用内文档：`src/data/reportDocs/<slug>.json` 保存正文与作用域化 CSS，`src/data/reportSearch.json` 是正文检索索引，`public/research/media/` 存放从报告里外置并转为 WebP 的图片；三者都由 `scripts/build-report-docs.mjs` 生成，不要手工编辑。
- 归档：独立 HTML 副本在 `public/research/stocks/`，报告导航脚本在 `public/research/scripts/report-nav.js`；同样是生成物。
- 发布：新增或修改报告后，在根目录运行 `npm run research:publish`。该命令会更新导航清单、同步应用副本与清单，并完成构建和本地生产服务重启。
- 边界：报告内容为公开信息研究整理，不构成投资建议，也不进入 R2 收益账本、产品池排序或选品结论。

**新增一篇报告的成本与约束**

- 仍然只需在 `report/` 放一个 HTML，然后执行 `npm run research:publish`；目录、全文检索、图片 WebP 化、导航和图谱联动都会自动生成。
- 报告必须是静态 HTML：不能包含 `<script>`、内联事件（如 `onclick`）或 `javascript:` 链接，否则发布会在转换阶段报错。
- 每篇需自带 `<style>`；图片会被抽取并转为 WebP（质量 88，`sharp` 不可用时保留原图）。
- 科技图谱只识别 `keywords` 里的股票代码；只在正文出现的代码，用 `<!-- rpnav-keywords: 002414 -->` 补充。
- 当前 13 篇：报告转换约 1.2 秒、完整发布约 10 秒、生成物约 128 KB/篇；检索索引约 25 KB/篇，报告数量到 50 篇以上时需要重新评估索引拆分。

### A股科技图谱

- 入口：`/investment/tech-map`，可从报告库页或左侧“投资”进入；旧地址 `/research/tech-map` 会自动跳转。
- 内容：A股科技全景图，包含脑图、树状和表格三种原生 Vue 视图；静态快照为 2026-09-16，覆盖 8 大门类、40 个子行业、156 个细分方向和 750 家代表公司。
- 数据与组件：数据在 `src/data/techmap.json`，类型和统计在 `src/data/techmap.ts`，视图组件在 `src/components/techmap/`，共享样式在 `src/styles/techmap.css`。
- 交互：脑图支持滚轮/按钮缩放、拖拽、逐级展开、搜索定位和适应屏幕；树状支持逐级折叠、全部展开和只留骨架；表格支持门类筛选、方向/公司搜索。三种视图均支持打印当前视图，页面支持全屏查看和 `?view=canvas|tree|table` 视图切换。
- 布局：采用紧凑标题、顶部视图切换栏和全高内容区；桌面端三种视图填满剩余视口，移动端树状与表格使用页面自然滚动。
- 边界：该模块是 A 股产业资料，不属于 R2 理财产品，不进入收益账本、产品池排序或选品结论，也不构成投资建议。
- 归档：`public/research/techmap/` 保留原始静态 HTML，仅作资料来源归档，运行时不加载。
- 更新：更新 `src/data/techmap.json` 中的快照，并同步核对类型、统计和 `test/techmap.test.mjs` 的数量断言；数据日期与风险边界不得随意改变。

## 数据与接口

- `GET /api/dashboard`：记录、指标、本金账户、窗口汇总和产品观察池。
- `GET /api/review/workspace`：复盘工作台数据（决策、交易流水、收件箱、自动推导持仓、事件、五问、季度清单、持仓汇总、对账和时间轴）。
- `GET /api/automation/workspace`：自动评估、通知、草稿、任务队列、设置和调度状态。
- `POST /api/automation/run`：立即运行一次本地自动化巡检。
- `PUT /api/automation/settings`：修改目标年化、期限 hurdle、流动性/单只上限、置信度门槛和巡检间隔。
- `POST /api/evaluations/:id/apply|undo`：人工确认或撤销一条评估。
- `POST /api/notifications/:id/read|unread|resolve`、`POST /api/notifications/read-all`：处理提醒。
- `POST /api/automation/jobs/:id/resolve`：标记 Codex 判断任务完成、跳过或失败。
- `GET/POST /api/review/drafts/:type/:period/generate|confirm`：读取、生成或确认月度/季度复盘草稿。
- `GET/POST /api/trades`：读取交易总览或新增交易。
- `PUT /api/trades/:id`：修改交易并写入审计留痕。
- `POST /api/trades/:id/confirm|cancel`：确认或撤销交易。
- `GET /api/trades/:id/audit`：读取单笔交易的修改留痕。
- `GET/POST /api/trades/inbox`：读取收件箱或上传成交截图（JSON Base64，单张不超过 10 MB）。
- `PUT /api/trades/inbox/:id`：保存人工校正后的识别字段。
- `POST /api/trades/inbox/:id/apply|ignore`：生成/匹配交易或忽略截图。
- `POST /api/trades/inbox/:id/vision-apply`：按视觉识别的字段写入，并用 OCR 金额/代码交叉校验；冲突、产品未收录或无匹配交易时返回 409。
- `GET /api/trades/inbox/:id/image`：读取本地归档截图。
- `POST /api/trades/inbox/prune`：清理 30–3650 天前已处理或已忽略的原图。
- `POST/PUT/DELETE /api/review/decisions`：决策日志的增改删。
- `POST/PUT/DELETE /api/review/holdings`：兼容旧接口，实际写入或撤销买入交易，持仓仍由流水推导。
- `POST/PUT/DELETE /api/review/events`：产品事件的增改删。
- `PUT /api/review/notes/:month`：保存指定月份的月度五问。
- `PUT /api/review/quarterly/:quarter`：保存指定季度的复盘清单。
- `GET /api/review/export?month=YYYY-MM`：导出指定月份的 Markdown 复盘。
- `POST /api/capital/init`：首次初始化起始本金。
- `PUT /api/capital/init`：调整起始本金，并重算历史本金快照。
- `POST /api/capital/events`：记录转入或转出。
- `DELETE /api/capital/events/:id`：删除一笔转入或转出。
- `POST /api/products/refresh`：重新读取本地产品 CSV，替换当前产品快照。
- `GET /api/backups`：列出本地数据库备份。
- `POST /api/backups`：立即生成当天备份（每天启动时也会自动生成一次）。
- `POST /api/records`：新增每日记录。
- `PUT /api/records/:date`：修改指定日期记录。
- `DELETE /api/records/:date`：删除指定日期记录。
- `GET /api/export.csv`：导出台账 CSV。

服务默认只监听 `127.0.0.1`，不要把它直接暴露到公网。需要换端口时可设置 `PORT` 环境变量。

写接口只接受同源请求和 `application/json`，避免浏览器里的其他网页直接改动本地账本。

## 数据备份

服务每次启动会在 `data/backups/` 生成当天的 `r2_ledger-YYYY-MM-DD.sqlite`，默认保留最近 45 份。也可以手动操作：

```powershell
npm run db:list
npm run db:backup
npm run prod:stop
npm run db:restore -- 2026-10-18
npm run prod:restart
```

恢复前会自动保留一份 `pre-restore-*.sqlite`；服务运行中会拒绝恢复。

## 测试

```powershell
npm test
npm run check
npm run test:e2e
```

`npm test` 覆盖 API、SQLite、本金快照、指标计算、交易流水与批次匹配、收件箱去重、OCR 文本解析、自动评估、手工评价保护、撤销回滚、复盘草稿、通知去重、产品排序、静态资源响应和科技图谱快照完整性；`npm run check` 会执行 Vue TypeScript 检查和 Node.js 语法检查。`npm run test:e2e` 会用本机 Chrome/Edge 跑一遍报告检索、报告直达（无 iframe）、目录、键盘切换、首页账本、交易流水、收件箱和自动评估，运行前会自动构建。
