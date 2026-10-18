# 钱多多工作区记忆

更新时间：2026-10-18  
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
- 产品池是本地静态 CSV 快照；页面“刷新快照”只重新读取本地文件，不抓取招行实时数据。
- 投资模块默认进入股票调研报告库 `/investment/research`；A股科技图谱在 `/investment/tech-map`，旧地址 `/research/tech-map` 自动跳转；图谱数据快照日期为 2026-09-16。
- 股票调研已并入本工作区：源报告在 `report/`，独立报告库归档页在 `research/index.html`，应用内副本在 `public/research/stocks/`，报告清单在 `src/data/stockReports.json`。
- 新增或修改报告后执行 `npm run research:publish`，会更新导航、同步副本与清单、构建并重启生产服务；旧目录 `D:\codex\股票调研serenity` 已归档，不再使用。
- 报告详情路由为 `/investment/research/:slug`（不带 `.html`）；报告由 Vue 直接渲染，无 iframe。`scripts/build-report-docs.mjs` 会生成 `src/data/reportDocs/`、`src/data/reportSearch.json` 和 `public/research/media/`，这些都是构建产物，不要手工编辑。阅读页顶部有返回报告库和可搜索切换器，左侧目录可折叠并高亮当前章节；无底部悬浮条，另支持阅读进度、`←/→` 切换报告和正文全文检索。
- 报告新增约束：只允许静态 HTML（禁止脚本、内联事件、`javascript:`）；每篇必须自带 `<style>`；图片在构建期转 WebP；股票代码需进入 `keywords` 才能联动科技图谱；当前约 90 ms/篇、检索索引约 25 KB/篇，50 篇以上需重新评估索引拆分。
- 科技图谱数据和组件：`src/data/techmap.json`、`src/data/techmap.ts`、`src/components/techmap/`、`src/styles/techmap.css`。`public/research/techmap/` 只作原始静态资料归档。
- 股票调研报告与 A 股科技资料必须与 R2 账本隔离：不进入收益账本、产品池排序或选品结论，不构成投资建议。

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
- 导出 CSV：`date,principal,daily_pnl,action,notes`。

## 4. 运行与测试

- 生产守护：`npm run prod:deploy`；日常使用 `prod:status`、`prod:start`、`prod:stop`、`prod:restart`。
- 手动前台：双击 `start.bat`，执行构建后启动 `8765` 服务。
- 开发模式：双击 `start-dev.bat` 或运行 `npm run dev:all`；Vite 页面为 `5173`。
- `dist/` 只会在 `npm run build`、`npm start` 或 `start.bat` 时更新。
- Node.js 要求 24+；启动脚本支持 PATH 未刷新时回退到 `C:\Program Files\nodejs`。
- 检查与测试：`npm run check`、`npm test`；测试必须使用临时 SQLite，不得清空正式库。
- 生产日志在 `logs/`，守护器和 Node 的 PID 在 `run/`。

## 5. 当前数据与 Git

- 2026-10-18 已按用户要求清空正式库：收益记录 0 条、本金账户未初始化、无转入/转出流水；产品观察池保留 14 只，来自本地 CSV 快照。
- 清理前的完整演示数据保留在 `data/backups/r2_ledger-2026-10-18.sqlite`（30 条记录、本金 50,000、累计收益 +158.00）。需要恢复时先 `npm run prod:stop`，再 `npm run db:restore -- 2026-10-18`，最后 `npm run prod:restart`。
- 打开应用后进入首次本金初始化流程；真实记录从初始化本金后开始录入。
- 产品快照：`data/cmb_r2_products_2026-10-18.csv`（服务自动选用 `data/` 下日期最新的快照，可用 `R2_PRODUCT_CSV` 覆盖）；近 1 年历史年化中位数约 1.62%，与 3% 目标有明显缺口。
- 数据备份：启动时自动写入 `data/backups/r2_ledger-YYYY-MM-DD.sqlite`，保留 45 天；`npm run db:list|db:backup|db:restore` 可手动查看、备份和恢复。
- Git 分支：`main`；`dist/`、`node_modules/`、`.env` 和 SQLite 文件均被 Git 忽略。
