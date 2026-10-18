# 钱多多工作区记忆

更新时间：2026-10-19  
用途：记录长期有效的约束、当前架构和运行方式；具体选品方法以 `r2-wealth-management` skill 为准。

## 1. 约束

- 只处理银行 R2/PR2 理财，不碰股票、基金、杠杆、借款和信用卡资金。
- 应急金必须在 R2 资金之外；年化 3% 是进取目标，不是保本或收益承诺。
- 单只产品 25%–30% 以内，新品单只不超过 10%；无流动性仓时短桶不低于 30%。
- 不替用户下单；额度、费率、风险等级和赎回规则以招行 App 与产品说明书为准。

## 2. 应用与架构

- 工作区：`D:\codex\钱多多财富工作台`（统一承载 R2 理财、股票调研与 A 股科技图谱）。
- 旧路径 `D:\codex\R2理财` 已停用（仅剩 Codex 占用的 `.git` 元数据）；迁移前副本在 `D:\codex\_archive\R2理财-pre-rename-2026-10-18`。
- 钱多多是本地个人财富工作台，左侧导航分为“理财”和“投资”两组，均可折叠；理财下为“R2 收益账本”，投资下为“科技全景图”和“调研报告”。分组折叠状态保存在浏览器 localStorage。
- 本地生产页：`http://127.0.0.1:8765`；开发页：`http://127.0.0.1:5173`。
- 前端：Vue 3 + Vite + TypeScript + Pinia + Vue Router；后端：Node.js 24+、内置 `node:sqlite`。
- 首页页面在 `src/views/DashboardView.vue`，组件在 `src/components/`，状态在 `src/stores/dashboard.ts`，接口封装在 `src/api/client.ts`。
- 本金独立管理：首次初始化起始本金和日期，后续用转入/转出维护；收益记录不单独填写本金，由本金账户自动带入。
- `cash_balance` / “R2 流动性仓”已移除，数据库、API、页面和 CSV 均不包含。
- 产品池默认由 `scripts/fetch-cmb-r2-snapshot.cjs` 自动更新（招行理财产品统一查询平台公开接口：R2、开放中、代销；移动端 R2 货架核对展示年化）；页面“刷新快照”会重新解析 `data/` 下日期最新的 CSV，不登录账户、不抓取实时额度。
- 快照选择：`R2_PRODUCT_CSV` 优先；否则扫描 `data/cmb_r2_products*.csv`，按文件名中的 `YYYY-MM-DD` 倒序，同日期按 `mtime` 倒序；刷新接口每次重新解析并整表替换 `products`。`product_snapshot_date` 是产品 `data_date` 的最大值，不是文件名日期。
- 观察池评分：`0.45×3M + 0.30×6M + 0.25×1Y`；若 `1M < 3M - 0.5` 再扣 0.08；每个期限桶取最高分一只，CSV 的 `score` 列不参与应用排序。
- 投资模块默认进入股票调研报告库 `/investment/research`；A股科技图谱在 `/investment/tech-map`，旧地址 `/research/tech-map` 自动跳转；图谱数据快照日期为 2026-09-16。
- 股票调研已并入本工作区：源报告在 `report/`，独立报告库归档页在 `research/index.html`，应用内副本在 `public/research/stocks/`，报告清单在 `src/data/stockReports.json`。
- 新增或修改报告后执行 `npm run research:publish`，会更新导航、同步副本与清单、构建并重启生产服务；旧目录 `D:\codex\股票调研serenity` 已归档，不再使用。
- 报告详情路由为 `/investment/research/:slug`（不带 `.html`）；报告由 Vue 直接渲染，无 iframe。`scripts/build-report-docs.mjs` 会生成 `src/data/reportDocs/`、`src/data/reportSearch.json` 和 `public/research/media/`，这些都是构建产物，不要手工编辑。阅读页顶部有返回报告库和可搜索切换器，左侧目录可折叠并高亮当前章节；无底部悬浮条，另支持阅读进度、`←/→` 切换报告和正文全文检索。
- 报告新增约束：只允许静态 HTML（禁止脚本、内联事件、`javascript:`）；每篇必须自带 `<style>`；图片在构建期转 WebP；股票代码需进入 `keywords` 才能联动科技图谱；当前约 90 ms/篇、检索索引约 25 KB/篇，50 篇以上需重新评估索引拆分。
- 科技图谱数据和组件：`src/data/techmap.json`、`src/data/techmap.ts`、`src/components/techmap/`、`src/styles/techmap.css`。`public/research/techmap/` 只作原始静态资料归档。
- 股票调研报告与 A 股科技资料必须与 R2 账本隔离：不进入收益账本、产品池排序或选品结论，不构成投资建议。
- 复盘接口：`GET /api/review/workspace`；`POST/PUT/DELETE /api/review/decisions|holdings|events`；`PUT /api/review/notes/:month`；`PUT /api/review/quarterly/:quarter`；`GET /api/review/export?month=YYYY-MM`。

### 投资页原则

- 脑图、树状、表格三种视图都使用原生 Vue；保留搜索、缩放、折叠、打印、全屏和 `?view=canvas|tree|table` 切换。
- 内容优先：页面铺满侧栏之外的主区域，避免卡片套卡片、厚重边框和阴影。
- 脑图保持单列层级排布：门类 → 子行业 → 方向 → 代表公司；不要重排节点或改成左右分翼。空间不足时扩大画布窗口，而不是缩小内容。
- 桌面端脑图默认 100%；移动端树状和表格使用页面自然滚动。
- 修改脑图连线时，SVG 坐标必须与节点世界坐标同步（包括 `viewBox`），避免整体平移导致连线错位。

## 3. 数据口径

- 数据库：`data/r2_ledger.sqlite`；备份目录：`data/backups/`。
- 每日记录字段：`date`、`principal`、`daily_pnl`、`action`、`notes`。
- 本金表：`capital_settings`（起始本金/日期）、`capital_events`（转入/转出流水）。
- 账户净值 = 当日本金 + 累计收益。
- 日收益率 = 当日收益 ÷ 当日本金。
- 月收益率 = 当月累计收益 ÷ 当月平均本金。
- 月度评级：低于 0.16% 不及格；0.16% 及格；0.20% 良好；0.25% 优秀；0.30% 卓越。
- 复盘区：日卡显示当日收益、月累计、操作与备注；周卡按周一至周日统计本周收益、记录天数、连续负收益和操作次数；月卡显示年化、最大回撤、负日占比、最好/最差单日、目标进度、环比和记录完整度。月中只显示“进行中”和参考区间，月末且满 28 天、20 条记录后才落最终评级。
- 复盘工作台：首页 `ReviewWorkspace` 提供决策日志、持仓结构、产品事件、月度五问、季度复盘五个标签页；数据表为 `decision_log`、`holdings`、`product_events`、`review_notes`、`quarterly_notes`，由 `lib/review-store.js` 管理。
- 持仓快照用于单只/单发行方集中度、日开+30 天内占比、未来 12 个月到期阶梯和已到期提醒；期限 0 天表示日开，不生成到期日。月度复盘可用 `GET /api/review/export?month=YYYY-MM` 导出 Markdown，月度结论会同步显示在复盘区历史月份。
- 导出 CSV：`date,principal,daily_pnl,action,notes`。

### 复盘工作台口径

- 决策日志事后评价四类：流程正确结果好、流程正确结果差、流程错误结果好、流程错误结果差；另有“待评估”。“流程错误，结果好”单独标黄。
- 持仓集中度：单只超过 30% 警告；多发行方时单发行方超过 50% 警告；单银行 mandate 可 100%；日开 + 30 天内低于 30% 警告；到期日早于今天算已到期。
- 期限桶：日开、1–30 天、31–100 天、100 天以上、未填期限；期限 0 天表示日开，不生成到期日。
- 月度五问按 `YYYY-MM` 保存，季度清单按 `YYYY-Qn` 保存；月度结论和“下月只改一件事”会显示在复盘区历史月份，并带“已复盘”标记。
- 时间轴按日/周/月/季判断：日记录缺失优先高亮；周五起高亮周检查；上月五问在 5 日后未填标“待补”；上季清单在季度首周后未填标“待补”。
- Markdown 导出包含月度指标、目标进度、环比、决策日志、产品事件、五问、结论和当前持仓快照；持仓是导出时快照，不是月末快照。

## 4. 运行与测试

- 生产守护：`npm run prod:deploy`；日常使用 `prod:status`、`prod:start`、`prod:stop`、`prod:restart`。
- 手动前台：双击 `start.bat`，执行构建后启动 `8765` 服务。
- 开发模式：双击 `start-dev.bat` 或运行 `npm run dev:all`；Vite 页面为 `5173`。
- `dist/` 只会在 `npm run build`、`npm start` 或 `start.bat` 时更新。
- Node.js 要求 24+；启动脚本支持 PATH 未刷新时回退到 `C:\Program Files\nodejs`。
- 检查与测试：`npm run check`、`npm test`；测试必须使用临时 SQLite，不得清空正式库。
- 复盘工作台已有 39 项测试通过；`npm run test:e2e` 还会检查 5 个标签页、4 个时间轴节点和 5 个月度问题。
- 生产日志在 `logs/`，守护器和 Node 的 PID 在 `run/`。

## 5. 当前数据与 Git

- 2026-10-18 已按用户要求清空正式库：收益记录 0 条、本金账户未初始化、无转入/转出流水。
- 2026-10-19 产品快照已扩到 19 只（原 14 只 + 5 只推荐产品），由公开接口自动生成。
- 2026-10-19 已完成复盘第一档（日/周/月指标与提醒）、第二档（决策日志、持仓、产品事件、月度五问/季度清单）和第三档（时间轴、结论按月留痕、Markdown 导出）。
- 2026-10-19 正式库已初始化本金 30,000 元（起始日 2026-10-18），已录入 6 笔持仓合计 30,000 元和 1 条「3%策略组合」决策；收益记录仍为 0 条，六笔买入均为交易进行中、待确认份额。
- 清理前的完整演示数据保留在 `data/backups/r2_ledger-2026-10-18.sqlite`（30 条记录、本金 50,000、累计收益 +158.00）。需要恢复时先 `npm run prod:stop`，再 `npm run db:restore -- 2026-10-18`，最后 `npm run prod:restart`。
- 本金已初始化，后续通过转入/转出维护；每日收益在产生实际收益后录入，不用买入/赎回动作代替收益记录。
- 产品快照：`data/cmb_r2_products-2026-10-19.csv`（19 只；自动任务每周一 08:30 生成；服务按文件名日期选最新，刷新接口会重新解析最新文件，可用 `R2_PRODUCT_CSV` 覆盖）；CSV 额外包含 `max_drawdown_pct`、`negative_days_pct`、`history_months`、`fee_bps`、`liquidity_days`、`next_open_date`。
- 当前观察池：19 只中 18 只 ready；1Y 中位 1.815%、3M 中位 1.47%、6M 中位 1.555%；应用 watchlist 为 120026A（短）、120056A（中）、13328D（长）。
- 2026-10-19 新增推荐产品：120026A（14 天，1Y 2.76%）、120056A（90 天，1Y 2.85%）、17356D（90 天，1Y 2.75%）、13328D（180 天，1Y 3.70%）、17318K（180 天，1Y 3.59%）。13328D/17318K 的 3M 约 2.88%/2.41%，6M 约 2.40%/2.33%，最大回撤约 0.15%/0.08%；13328D 的 1Y 高于其 1.60%–2.60% 基准区间，不能线性外推。
- 3 万 target3 配置（30/35/35）：107320A 3,000 + 120026A 6,000 + 120056A 7,500 + 17356D 3,000 + 13328D 7,500 + 17318K 3,000；加权 1M/3M/6M/1Y = 2.28%/1.95%/2.14%/3.00%，固定费率 36.5bp。1Y 历史输入贴近 3%，但 3M/6M run-rate 未达 3%，不是未来收益承诺。
- 公开数据源：`POST https://finprod.paas.cmbchina.com/api/prod/queryProdList`，条件 `type=PN/isOwn=C/isPublic=Z/status=1/riskLevel=R2/crossFinance=Z`；`pastPerf.tqilstw4z3` 的 A/B/C/D/F = 1M/3M/6M/1Y/成立以来；`zchrCst+chrmn2+chrsal` 为固定费率，`begdat` 为下一开放日，`buynfq` 为起购金额。签名从公开页面捕获，不硬编码。
- 定时任务 `R2产品快照每周更新`（自动化 ID `r2`）每周一 08:30 运行 `scripts/fetch-cmb-r2-snapshot.cjs`，直接拉取公开接口并写 CSV/刷新应用；不登录账户、不抓实时额度，额度、赎回到账和可买状态仍需在招行 App 当日复核。
- 数据备份：启动时自动写入 `data/backups/r2_ledger-YYYY-MM-DD.sqlite`，保留 45 天；`npm run db:list|db:backup|db:restore` 可手动查看、备份和恢复。
- Git 分支：`main`；`dist/`、`node_modules/`、`.env` 和 SQLite 文件均被 Git 忽略。
