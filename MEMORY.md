# 钱多多工作区记忆

更新时间：2026-10-24

用途：记录长期有效的约束、架构与数据口径和运行契约；具体选品方法以 `r2-wealth-management` skill 为准。

记忆边界：`TODO.md`、Git、代码、数据库、运行接口和当次测试输出是时效性事实的来源。`MEMORY.md` 禁止记录待办是否完成、当前优先级、阻塞项、剩余任务编号、正在开发/待发布/待验证状态、当前实现暂不支持的能力、当前测试数量或覆盖率、当前服务/数据库/报告数量等会随开发或运行变化的内容；标注“截至日期 + 来源”也不构成豁免。这里只保留长期约束、架构与数据口径、运行契约和仍有决策价值的历史事实。

## 1. 约束

- 只处理银行 R2/PR2 理财，不碰股票、基金、杠杆、借款和信用卡资金。
- 应急金必须在 R2 资金之外；年化 3% 是进取目标，不是保本或收益承诺。
- 单只产品 25%–30% 以内，新品单只不超过 10%；无流动性仓时短桶不低于 30%。
- 本项目新增日开目标固定为 0%，`target3` 固定为短期 30% / 中期 35% / 长期 35%。现有日开持仓只保留为真实持仓和迁移事实，不追溯删除、不补记为 0，也不作为短桶流动性达标依据；`r2-wealth-management` skill 的通用可选 `--cash-pct` 能力保留，但本工作区不启用。
- 不替用户下单；额度、费率、风险等级和赎回规则以招行 App 与产品说明书为准。
- 交易、决策与截图必须完整绑定：任何买入、赎回、切换交易（包括待确认、手工录入和截图入账）都必须关联 `decision_id` 和能够证明该笔业务的原始交易截图 `screenshot_id`；决策至少包含原因、预期、策略及期限口径、证据日期、验证日期和失效条件。提交前预览页不算成交截图，只记交易流水、持仓或本金变化也不算完成。一张图包含多笔订单时，必须先拆分单笔截图、逐笔核对并分别绑定，禁止把同一张多笔总览图直接绑定到多笔交易；原总览图只保留历史证据，必须标记为 `ignored` 并清空 `trade_id`、`duplicate_of`，不参与逐笔对账。
- 持有起点统一使用交易确认日 `confirm_date`：买入/切换在状态变为“已确认”后才进入持仓；未确认交易只占额度，不算持有。持仓批次、持有天数、期限、到期日和逐产品归档均不得从发起交易的 `trade_date` 起算；赎回持有终点同样优先使用赎回确认日。
- 持仓复核的 schema 与类型契约不包含 `idle_days`、`compare_horizon_days`、旧设置列 `min_gain_amount`、`term_warning`、`idle_cost`；`holding_review_settings` 保存赎回/到账 T+N、候选申购确认 T+N、费用、下一赎回开放日、备注和核验日期。涉及账本、交易、逐产品收益、审计或正式决策记录等事实数据的删除，仍必须先单独确认目标、影响和恢复方式。

## 2. 应用与架构

- 工作区：`D:\codex\钱多多财富工作台`（统一承载 R2 理财、股票调研与 A 股科技图谱）。
- 旧路径 `D:\codex\R2理财` 已停用（仅剩 Codex 占用的 `.git` 元数据）；迁移前副本在 `D:\codex\_archive\R2理财-pre-rename-2026-10-18`。
- 钱多多是本地个人财富工作台，左侧导航分为“理财”和“投资”两组，均可折叠；理财下按“收益概览、消息中心、每日记账、交易与持仓、产品与配置、复盘、决策与评估”排列，投资下为“科技全景图”和“调研报告”。分组折叠状态保存在浏览器 localStorage。
- 主题契约：`public/theme-init.js` 在首屏前读取 `qianduoduo:theme:v1` 和系统偏好，`useTheme.ts` 统一管理浅色、深色、跟随系统三种模式、系统外观变更监听与持久化，`theme.css` 最后加载并提供浅色/深色语义色板。界面必须使用语义颜色和主题变量，不得把固定白底或只适合浅色的文字色写进新组件。
- 本地生产页：`http://127.0.0.1:8765`；开发页：`http://127.0.0.1:5173`。
- 前端：Vue 3 + Vite + TypeScript + Pinia + Vue Router；后端：Node.js 24+、内置 `node:sqlite`。
- 后端为模块化单体。`server.js` 只负责应用工厂和生命周期入口；`server/app.js` 装配 HTTP 应用，`server/lifecycle.js` 管理启动、维护任务、调度器、优雅关闭和数据库关闭；HTTP、域用例和基础设施分别位于 `server/http/`、`server/modules/`、`server/infrastructure/`。API pattern 在启动时强制校验已注册且无重复，未知 API 继续返回 404 `{"error":"接口不存在"}`。
- 后端模块按域拆为 capital、dashboard、data-trust、decisions、evaluations、income、ledger、notifications、operations、product-valuations、products、proposals、research、reviews、trades；`server/modules/` 和 `server/infrastructure/` 不直接写 SQL，仍通过 repository adapter 调用现有 `lib/*-store.js`。旧 `server/http/legacy-app.js` 已删除，不再保留两套 HTTP 业务实现。
- Dashboard 读取契约：`GET /api/dashboard` 保留完整兼容响应；`GET /api/dashboard/sections?include=...` 与 `/api/dashboard/{summary|overview|ledger|trades|products|evaluation|inbox}` 提供同一只读快照的分区视图，兼容聚合与分区由同一查询快照选择器生成，不形成两套业务读模型；`GET /api/review/workspace` 和 `GET /api/inbox` 同样只读。决策提案、提醒生命周期和消息中心持久化状态通过 `POST /api/dashboard/refresh`、服务启动、后台巡检或写操作完成后的显式投影更新。投影使用事务，不得重新把持久化写入塞回 GET。
- 自动化执行契约：`automation cycle` 在独立 worker 中运行，主进程统一管理硬超时、防重入、终止和中断恢复；手动运行、后台调度及交易/决策写后评估共用同一 runner，不得在请求或调度线程直接执行长 cycle。
- 子 Agent 运行契约：`npm run agent:brief` 校验任务简报并建立仅 2 分钟有效的 reservation，同一 Agent 类型同时只允许一个待派发 reservation，可用 `npm run agent:reservation:cancel` 取消未声明占用；简报必须声明带时区硬截止、工具预算、40%/70% 检查点、80% 收口和 `recursion_allowed=false`。`.codex/config.toml` 的 `SubagentStart`、`PreToolUse`、`SubagentStop` hooks 调用 `scripts/agent-guard.mjs`；无有效 reservation 时 fail-closed，运行截止取简报绝对截止与角色预算中更早者。`PreToolUse` 禁止返回 `additionalContext` 或任何进入对话的检查点消息，40%/70% 只记录状态供 `agent:status` 读取；达到 80%、预算或截止边界后冻结全部工具，并拒绝子 Agent 递归。派发后 30 秒内必须确认运行状态含准确 `taskId` 且 `briefVerified=true`；否则立即中断并要求重启会话。主 Agent 使用 5–10 分钟有界等待，最终仅接受准确 TASK_ID、逐字目标复述和四项收口；每个 Agent 结束或异常终止后执行 `npm run agent:cleanup`；继续工作必须使用新 `TASK_ID`。
- 预测校准契约：AI/平台提案把结构化预测冻结在正式决策的 `review_meta.predictions`，实际结果写入 `review_meta.prediction_results` 并复用正式交易、产品收益事实和事实修订链；预测修订只能追加版本，月度校准通过 `/api/calibration/monthly` 按类型和置信度汇总，待验证、未执行和失效不计入命中率。
- SQLite schema、迁移版本、数据量、外键和完整性检查结果以代码、迁移脚本、运行接口和数据库查询为准；本文件不保存这些会变化的快照。
- 财富数据可信度 v1 的长期契约是保留 `schema_migrations`、`evidence_assets`、`evidence_events`、`fact_revisions`、`fact_evidence_links` 证据链，并在收益/交易收件箱维护 `evidence_id`、`workflow_state`、`selected_event_id`、`state_version` 和 `last_request_id`。迁移状态与执行过程只查迁移系统及 `docs/architecture/data-trust/lineage-design.md`、`docs/architecture/data-trust/schema-migration-plan.md`；生产运行时 DDL 固定放在 `server/modules/data-trust/migrations/`，`docs/` 只保留设计、方案和归档说明，不得成为服务启动依赖。
- 文档分类、权威顺序和归档规则以 `docs/README.md` 为准；任务交接随任务放入 `docs/tasks/active/` 或 `docs/tasks/archive/`，不得再写入 `docs/analysis/`。
- `R2_DATA_TRUST_MODE` 默认 `shadow`；新写入在生产中同步维护旧字段投影和证据/修订链。生产启动使用 `migrationPolicy=require`，迁移未完成时拒绝启动；测试和临时库可自动迁移。`R2_DATA_TRUST_MODE=off` 是逻辑热回滚模式，保留新增表与历史数据。
- 收益截图的产品收益、账户收益、修订、证据链接和收件箱状态必须由共享 `BEGIN IMMEDIATE` 事务提交；并发或重复 apply 应收敛到同一正式事实。
- 财务与运维风险的待办状态只查工作区根目录 `TODO.md`；本文件只记录必须长期保持的约束，不复制任务编号、优先级、完成情况或阻塞状态。
- R2 页面在 `src/views/r2/`：`R2LayoutView` 统一加载数据，`InboxView`、`OverviewView`、`DailyEntryView`、`TradesView`、`ProductsView`、`ReviewView`、`EvaluationView` 七个子页；页面外壳在 `src/components/r2/`，样式在 `src/styles/r2-pages.css` 与 `src/styles/inbox.css`。`/` 和 `/ledger` 都重定向到 `/ledger/overview`。
- R2 路由：`/ledger/overview` 收益概览、`/ledger/inbox` 消息中心、`/ledger/daily` 每日记账、`/ledger/trades` 交易与持仓、`/ledger/products` 产品与配置、`/ledger/review` 复盘、`/ledger/evaluation` 决策与评估。`R2LayoutView` 按页面请求 `/api/dashboard/sections` 的对应分区，store 深合并分区并保留共享状态；页面首屏不下载完整 `/api/dashboard`，写接口继续返回完整 Dashboard 兼容响应。
- R2 顶部悬浮分区导航已移除；左侧 sidebar 是唯一的跨页分区入口。页面内的 `R2SectionIndex` 只做当前页锚点（如复盘页的日周月评分 / 复盘节奏 / 月度五问 / 季度复盘），不重复承载跨页导航。
- R2 卡片规范：每个模块用主题卡片包起来，浅色主题为暖白、深色主题为石墨青灰；卡片头固定为“英文小标签 + 中文标题 + 一行说明 + 右侧操作”，统计标签放在标题下方；产品页使用 `product-module-card`，复盘页使用 `review-module-card`。内层子卡片不再叠加厚重阴影，避免卡片套卡片。
- 收益概览：压缩 hero 与 KPI 高度，两个图表在所有宽度下单列全宽排列（桌面高 340px、移动端 300px），待办入口放到图表下方；图表宽度随主内容区铺满，优先保证数据可读性。
- R2 页面按查看频率排序：交易与持仓为“当前已确认持仓净值 → 当前持仓 → 产品收益 → 交易流水 → 交易收件箱”；产品与配置为“配置目标与期限桶 → 当前持仓 vs 同桶候选 → 特殊事项”；复盘为“日周月评分 → 复盘节奏 → 月度五问 → 季度复盘”；决策与评估为“决策日志 → 自动评估”。异常事项即使位于后部，也在页头保留计数和深链。
- 全应用除股票报告阅读页外，都在页面滚动后显示右下角回到顶部悬浮球；报告详情继续使用阅读器自身顶部的回到顶部按钮，不重复加全局悬浮球。
- 产品与配置页：配置目标与期限桶、观察名单、当前持仓 vs 同桶候选、分配假设、额度核验、风险边界、产品事件分别为主题模块卡；目标产品卡片不展示，产品金额与交易建议由决策模块承接，但底层 `watchlist`、额度数据和提案逻辑继续保留。观察名单卡片和“查看全部产品”表格行共用 `ProductDetailDialog`，查看收益快照、产品信息、研究评分、当前配置、额度和分配原因。研究池的产品代码、产品名称、发行方均为可模糊搜索的多选下拉，期限和数据深度同样支持多选；同字段选项按 OR、不同字段按 AND 过滤，各搜索框只匹配本字段，产品代码按连续字符匹配且不混用名称或期限数字。每个下拉底部提供当前筛选结果全选/取消全选，取消全选同时清空对应搜索词；所有下拉点击筛选区外空白处或按 Esc 收起。候选池打开详情时暂时收起，避免嵌套 `<dialog>`；关闭后恢复筛选、排序、滚动位置和原产品焦点。
- 持仓复核页面支持按全部、建议替换、观察、继续持有、到期/开放窗口筛选；搜索框点击后展开持仓下拉，空输入时列出当前持仓，输入实时缩小结果，选择候选后按产品代码筛选。支持方向键、回车、Esc 与点击外部关闭；Esc 只收起下拉，不清空搜索词。移动端下拉根据可用空间自动向上或向下展开。
- 持仓复核视觉规范：候选卡使用主题分层卡，首选项以细绿色顶边强调；顶部显示产品、代码、发行方、数据日与结论，随后用 4 个 KPI 展示参考年化及年化差、切换后预计多赚与门槛、盈亏平衡、有效计息与统一比较期。T+N 使用独立横向规则条，`estimated` 用暖色、`verified` 用绿色；次级事实、当前/候选双轨收益条、逐条判断依据、待核项和右下操作区依次排列，避免四列表格底部出现空白单元。赎回与费用表单使用主题分段布局，右上显示核验状态，字段按 4 列均衡排布，动态门槛跨 2 列，长备注使用可换行文本域，底部以口径标签和主按钮收尾。移动端 KPI 为 2 列、表单为 1 列，产品名必须换行且页面不得横向溢出；所有信息文字不低于 12px。
- 复盘页：日周月评分、复盘节奏、月度五问、季度复盘为四张主题模块卡；页内索引在页面标题下方；月度/季度默认折叠，折叠头显示英文标签、标题和保存进度；`ReviewNotesPanel` 内部不再重复标题。
- 交易收件箱和收益收件箱默认只显示待处理截图，已处理原图折叠；每日记账的例外维护表单仍保留手工修正能力。
- 收益账本与自动复盘的阅读字号下限为 **12px**：功能性文字、辅助说明、状态标签、分页、日历图例、备注、按钮、产品详情弹窗和全部产品弹窗内的筛选/排序/代码都不得低于 12px；关键数据 12.5–13px，卡片标题 13–14px。自动复盘左栏由“每日复盘 + 每周检查 + 最近可记日”组成，最近可记日最多显示 7 天，起始较晚时按实际可记天数显示；卡片自适应填满左栏剩余高度，点击日期可直接补记或修改。
- 行情涨跌色固定为上涨/正收益用绿色系、下跌/负收益用红色系；该语义色与界面强调色分离，修改主题强调色时不得反转或覆盖涨跌含义。
- 本金独立管理：首次初始化起始本金和日期，后续用转入/转出维护；收益记录不单独填写本金，由本金账户自动带入。
- 本金起始日口径：`capital_settings.initial_date` 之前的日期不属于收益账本，不计收益、不计缺记、不计记录完整度和目标进度，也不能补记。复盘日历显示“起始日前”并禁用点击；日/周/月统计和评级只从起始日起算；起始月可记录天数不足 28 天时不落最终评级；上月/上季若完全早于起始日，时间轴显示“未纳入复盘”，即使存在旧笔记也不标为待补或已完成。记账表单和接口均拒绝起始日前的收益记录。
- 收益起算口径：买入/认购日不等于产品收益日。订单已提交但仍在确认中、尚未取得产品份额的日期，不写 0 元收益记录，不计入收益期、缺记、记录完整度或年化分母；交易流水和决策日志仍保留原买入日期。收益账本从账户首批产品份额确认并开始计息之日起算；多产品分批确认时不把后确认产品追溯计入更早日期。具体起算日只查 `capital_settings.initial_date`。
- 收益录入口径：`product_daily_valuations` 是收益唯一事实源，`daily_records` 是逐日账户总账的物化投影。每个 `yield_date` 的账户日收益必须等于该日全部产品收益按分汇总；产品新增、修正、迟到补录、批量重放和删除都在同一事务内按最终集合重算，不得增量加减。收益日期允许不晚于今天；`reporting_date = today - max(当前持仓 yield_lag_days)`，没有持仓时才回退 1 天，只用于日常缺记提醒。一条产品记录可带 `covered_yield_dates`，明确其合并收益覆盖的日期；覆盖只消除那些日期的产品来源缺口，金额仍只计入自身 `yield_date`，不得为覆盖日补 0、均分或复制金额。没有产品明细不得独立生成账户收益；银行页面账户金额仅作可选核对。0 元是有效收益值，用户或银行页面明确确认无收益时必须写入 0 元产品记录。
- `cash_balance` / “R2 流动性仓”输入字段已移除，数据库、API、页面和 CSV 不保存闲置现金余额。期限 0 天的日开产品仍是真实产品持仓，但本项目新增目标固定为 0%。
- 产品池默认由 `npm run r2:refresh-all`（`scripts/fetch-cmb-r2-all.cjs`）刷新：拉取招行公开全量 R2 池，生成 `cmb_r2_all-*.csv`、`cmb_r2_universe-*.csv`（普通可买候选池）和 `cmb_r2_selected-*.csv`（当前精选池）；页面“刷新快照”会重新解析日期最新的 universe CSV。旧脚本 `fetch-cmb-r2-snapshot.cjs` 仅保留作兼容。
- 快照选择：`R2_PRODUCT_CSV` 优先；否则扫描 `data/cmb_r2_universe*.csv`，找不到时回退 `data/cmb_r2_products*.csv`，均按文件名中的 `YYYY-MM-DD` 倒序、同日期按 `mtime` 倒序；刷新接口每次重新解析并整表替换 `products`。`product_snapshot_date` 是产品 `data_date` 的最大值，不是文件名日期。
- 普通可买研究池：人民币 `currency_code=10`、公募 `pub_prv=A`、R2/PR2、开放中、非私行/私银/私享/尊享/企享/专属/私募、期限可解析。按收益证据分为完整 1Y、缺 1Y 的 6M 档、仅 3M、仅 1M 新品观察和无有效收益五档；候选数量与期限分布只查当前产品 API 或 CSV。
- “期限调整参考年化”按 `cash`、`short`、`medium`、`long` 分桶：cash `1M 70% + 3M 30%`，short `1M 20% + 3M 50% + 6M 30%`，medium `3M 50% + 6M 30% + 1Y 20%`，long `3M 20% + 6M 40% + 1Y 40%`。各桶只使用指定窗口；缺失窗口按剩余权重重新归一化，全部缺失返回 `reference_yield_status=unavailable`，数值为 `null`；0 是有效收益。`weighted_yield_pct` 是参考年化的兼容别名。
- 动态配置规则（`r2-dynamic-v4`）：观察/选择评分以期限调整参考年化为基础；若 `1M < 3M - 0.5` 扣 `0.08`，前视扣分采用 B 方案，short/medium 在 `1Y - 6M > 1pp`、long 在 `>1.5pp` 时扣 `min(0.25, (gap-threshold)×0.15)`，成立满 18/24 个月加 `0.015/0.03`。输出统一保留 4 位小数并采用半值远离 0，桶内排序使用对外暴露的 4 位选择评分。完整 1Y 档沿用当前单只上限；缺 1Y 的 6M 档与仅有 3M 档均按单只 10%、同类合计 20% 限制；仅有 1M 的产品只作新品观察，不自动分配；cash 不评分、不排名、不分配；无有效收益产品只展示。产品数量按本金、已确认持仓、待确认买入、期限桶目标、短期桶下限、未来 0–3/3–6/6–12 个月现金流、单只/底层策略上限和逐只额度共同决定目标金额。发行方不参与筛选、分配、买入门槛、决策提案或自动评估。
- 目标单只金额默认为本金的 10%，最低 1 万元、最高 25 万元；仍受单只 25%–30%、同一底层策略 50% 和期限桶规则约束。发行方金额与占比只展示当前持仓状态，不设上限、不触发警告，也不阻止买入。额度缺失时标记“额度未核验”，不假装可买；待确认买入占用单只、底层策略和期限桶额度但不进入已确认持仓。
- 产品区可调整本金、期限桶、短期桶下限、现金流假设和逐只额度，保存后即时重算；日开新增额度固定 0%，不能编辑。`data/cmb_r2_selected-*.csv` 只是研究观察池，不代表资金分配结果。
- 持仓复核（`r2-holding-review-v7`）：逐只读最新快照，只用同风险档、同期限桶的候选，不再按最短持有天数拆子类；当前和候选参考年化调用 `lib/yield-policy.js` 的同一期限调整算法，并返回 `yield_status`、`yield_reason`、可用窗口和归一化权重。期限桶统一比较期固定为短 30 天、中 100 天、长 360 天，写入 `lib/holdings-review.js` 的 `BUCKET_COMPARISON_DAYS` 常量；日开持仓映射到短期限桶。收益、费用后差额与盈亏平衡统一使用复利折算：`本金 × [(1 + 参考年化)^(天数 / 365) - 1]`。
- 切换等待与到期续作分开：本次切换到目标产品时，等待天数 `W = 当前产品赎回确认 T+N + 当前产品到账 T+N + 候选产品申购确认 T+N`。候选申购确认默认T+1；遇到特殊产品时按产品代码单独覆盖为T+0/T+2/T+3等。等待期不计收益，候选有效计息天数固定为 `H-W`。产品到期后的自动续作空档为0，不重复扣。当前产品任一T+N未核验时，暂按赎回T+1、到账T+0、候选申购T+1估算，接口和页面同时标 `switch_wait_status=estimated` 与“估算”；真实核验后标 `verified`，估算值不得冒充已核验事实。
- 替换门槛：年化差 ≥0.15pp；候选按 `H-W` 有效天数、扣赎回费和申购费后的净多赚按 `max(1 元, 未赎回成本本金 × 0.10% × 桶统一比较期 / 90 天)` 动态计算。候选年化高于盈亏平衡 +0.05pp；且不恶化风险、流动性与单只占比。只满足部分条件为“观察”，否则“继续持有”；额度或赎回规则未核验时仍可给“建议替换”，但必须标“执行前核对”，估算等待期不能把 `execution_ready` 置为真。
- 可执行性优先于经济性：固定期限/持有期产品在到期前处于锁定期时，即使候选更优，也不能标“建议替换”；结论必须是“继续持有（锁定期）”，候选标“到期后可替换”，决策日志用 `观察` + `planned_action=replace_at_maturity`。只有已到期、已到赎回开放日，或日开且可赎回时，才能标“建议替换”并写 `切换` 决策。
- 赎回口径逐产品保存：赎回确认 T+N、到账 T+N、候选申购确认 T+N、赎回费/申购费、下一赎回开放日、备注与核验日期。T+N 只用于计算本次切换等待期，等待期不计收益；旧的空档和比较期限字段已从库中删除。公开快照的 `next_open_date` 是申购开放日，不得冒充赎回开放日。
- 替换决策写入决策日志时必须带：证据日期、事后验证日期、当前/候选代码、快照日期、当前/候选 `yield_status` 与可用窗口、桶统一比较期限、切换等待天数、有效计息天数、到期续作0天空档、费用、盈亏平衡、预计差额和理由；产品页“记录替换决策”会生成 `review_meta`，决策日志展示并可按验证日复核。
- `calculateSwitch()` 已统一为复利折算，当前收益、候选净收益、切换差额和盈亏平衡使用同一日数口径；若 `H-W<=0`，盈亏平衡为空且不给出可执行替换结论。页面、决策日志和消息中心保留等待天数、`verified/estimated` 状态与来源。
- 投资模块默认进入股票调研报告库 `/investment/research`；A股科技图谱在 `/investment/tech-map`，旧地址 `/research/tech-map` 自动跳转；图谱数据日期只查图谱数据源。
- 股票调研已并入本工作区：源报告在 `report/`，独立报告库归档页在 `research/index.html`，应用报告清单在 `src/data/stockReports.json`；报告数量和日期以发布清单为准。`public/research/stocks/` 与 `public/research/scripts/report-nav.js` 已退役，不得重新生成或托管。
- 股票、个股、主题、产业链、候选公司对比和公司事件研究默认直接生成 HTML 报告；快速扫描和事件更新也不例外，不再以对话文本作为默认最终交付物。每次新增或修改报告后执行 `npm run research:publish`，更新独立归档导航与报告清单、构建 Vue 文档并重启生产服务；用户明确要求“只分析、不要生成文件”时除外。旧目录 `D:\codex\股票调研serenity` 已归档，不再使用。
- 股票、主题和产业链研究只使用 `serenity-skill`。标准报告固定为六段：一页结论、产业链与瓶颈地图、候选公司与证据阶梯、市场叙事与拥挤度、催化剂与验证登记、退出与监控；价格资金结构放在市场叙事章内，五个财务红灯附在候选证据末尾。股票研究不运行 DCF、EPV、EVA、PVGO、M-Score 或目标价，不以“高估”自动作为退出结论。
- 报告库按 `publishedAt`（发布/更新到报告库的时间）倒序，调研日期作为次级排序；更新时间优先取报告中的 `<!-- rpnav-published: YYYY-MM-DD HH:mm -->`，缺失时沿用已生成导航清单中的发布时间，再回退文件修改时间。
- 报告详情路由为 `/investment/research/:slug`（不带 `.html`）；报告由 Vue 直接渲染，无 iframe。`scripts/build-report-docs.mjs` 会生成 `src/data/reportDocs/`、`src/data/reportSearch.json` 和 `public/research/media/`，这些都是构建产物，不要手工编辑。阅读页顶部有返回报告库、可搜索切换器和打印按钮，不再提供“原文”或静态 HTML 出口；左侧目录可折叠并高亮当前章节，无底部悬浮条，另支持阅读进度、`←/→` 切换报告和正文全文检索。应用静态层只托管 `/research/media/` 与 `/research/techmap/`，`/research/stocks/*` 和 `/research/scripts/*` 不受支持。
- 报告新增约束：只允许静态 HTML（禁止脚本、内联事件、`javascript:`）；每篇必须自带 `<style>`；图片在构建期转 WebP；股票代码需进入 `keywords` 才能联动科技图谱；索引随报告数增长，达到 50 篇以上需重新评估拆分方式，实际体积和耗时只查构建输出。
- GitHub Pages 公开归档只发布 `research/index.html`、`scripts/report-nav.js`、全部 `report/*.html` 和 `public/research/techmap/{index,tree,table}.html`，由 `scripts/build-pages-site.mjs` 白名单构建并通过 `.github/workflows/deploy-pages.yml` 部署。公开入口预期为 `https://pjimming.github.io/qianduoduo/research/`。
- Pages Artifact 必须拒绝 `data/`、R2 账本/截图、账户事实、API/服务端代码、Vue 构建物和白名单外文件；个人估值证据目录属于本机数据，不进入 Git。
- 股票研究不维护 DCF、估值假设、财务模型或专用检查器；HTML 源文件只沿用独立归档导航、清单和 Vue 文档构建脚本。历史报告保留为旧方法档案，不用新规则回写。
- 科技图谱数据和组件：`src/data/techmap.json`、`src/data/techmap.ts`、`src/components/techmap/`、`src/styles/techmap.css`。`public/research/techmap/` 只作原始静态资料归档。
- 股票调研报告与 A 股科技资料必须与 R2 账本隔离：不进入收益账本、产品池排序或选品结论，不构成投资建议。
- `r2-wealth-management` skill 的唯一权威目录、运行目录和 Git 工作树均为 `C:\Users\Administrator\.codex\skills\r2-wealth-management`，不再维护 D 盘或其他镜像。远程为 `https://github.com/pjimming/r2-wealth-management.git`；版本以 `SKILL.md` 为准，维护说明见该目录 `README.md`。上传时排除 `scripts/__pycache__/` 和 `.pyc`，并在该目录直接提交、推送；应用仓库不内嵌 skill。
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
- 首页“已确认持仓净值”由当前未赎回确认持仓本金加逐产品累计收益派生；待确认买入、临时桥接本金、已赎回产品和账户外资金都不计入。银行持仓市值快照只用作对照证据，不参与净值主值计算；没有银行快照也照常显示派生净值。推算值与同期银行对照值相差不超过 ¥0.01 时视为分位舍入差异，超过才提示不一致。
- 每日记录中的 `net_value` 是“记录日参考净值”= 该日本金 + 截至该日累计收益，只用于历史账本曲线和按日收益分析，不等于当前持仓市值。
- 逐产品收益按分保存和汇总，不保留四位小数；推算净值与银行对照值之间允许 ¥0.01 的四舍五入差异，不生成异常、不反向拆分公司收益、不改写任一产品事实。超过 ¥0.01 才进入来源、时点或缺口核查。
- 日收益率 = 当日收益 ÷ 当日已确认持仓金额；“已确认持仓金额”按交易确认日汇总当日未赎回的已确认买入成本，待确认交易和临时桥接本金不进入收益率分母。
- 月收益率 = 当月累计收益 ÷ 当月平均已确认持仓金额。
- 月度评级：低于 0.16% 不及格；0.16% 及格；0.20% 良好；0.25% 优秀；0.30% 卓越。
- 复盘区：日卡显示当日收益、月累计、操作与备注；周卡按周一至周日统计账本期内收益、记录天数、连续负收益和操作次数；月卡显示年化、最大回撤、负日占比、最好/最差单日、目标进度、环比和记录完整度。月中只显示“进行中”和参考区间；自本金起始日起可记录天数满 28 天且账本期内达到 20 条记录、月份结束后才落最终评级。
- 每日记账页的 `QuickEntryPanel` 只保留两个主入口（成交截图、收益截图），手工收益与特殊事项收进“例外情况”折叠区；下方是每日记录表和本金账户。交易收件箱、交易流水、持仓移到交易与持仓页；产品事件移到产品与配置页；决策日志移到决策与评估页；月度五问/季度复盘移到复盘页并默认折叠为摘要。决策/事件/五问等数据表由 `lib/review-store.js` 管理，评估/通知/草稿由 `lib/automation-store.js` 管理。
- 消息中心由 `lib/inbox-center.js` 动态聚合并持久化状态，统一承接决策提案、交易/收益截图、待确认交易、对账、评估、产品事件、持仓复核、复盘草稿和平台提醒。消息只保存状态与深链，不复制交易或账本事实；源事项消失后自动归档。持仓复核的“建议替换”若已有活动决策提案，只展示提案消息，不重复生成普通替换提醒。多条自动评估若标题、摘要、动作和证据状态完全相同，只生成一张带决策数量的汇总卡；不同证据缺口或评估结论仍分开显示。
- `r2-2` / `r2-3` 中需要用户补事实或最后确认、且平台不能自行处理的事项，必须通过 `POST /api/inbox/confirmations` 写入消息中心；请求使用确定性的 `dedupe_key`，支持 `action|reminder|system`、`info|warn|urgent`、站内 `action_url` 和可选 `due_at`。逐产品收益待补事项使用 `metadata.product_income_requirement={product_code,yield_date}`，对应 `product_daily_valuations` 事实出现后由消息中心投影自动关闭；兼容旧键 `agent-confirmation:<yield_date>:<product_code>-income-missing`。Codex 回复卡片只作摘要，不能替代消息中心持久化。
- 收益截图由 `lib/income-store.js` 保存原图、`lib/income-parser.js` 解析可选账户核对值、覆盖区间与多产品明细。日期和至少一条产品明细明确时即可入账：产品事实写入 `product_daily_valuations`，并在同一事务内按产品合计创建或更新 `daily_records`；没有明确产品明细时不生成账户总账。截图中的账户金额仅用于差异核对，产品汇总才是权威值。产品级记录按 `(product_code, yield_date)` 去重；对账按收益归属日聚合，以该日应持有产品的最大 `yield_lag_days` 生成 `final_disclosure_date`。最终披露日当天仍为 `waiting`，次日仍缺才转为 `missing-product-details`；连续日期且缺口集合相同的项目合并为一条消息。已到账产品先计入账户总账，后续产品到账时自动重算。同日确认赎回但尚无收益归属证据的产品列入 `same_day_redeemed_product_codes`，提示确认当日是否计息，不得直接定性漏记。`missing-account-total` 已退役；`mismatch` 只表示账户投影内部完整性漂移，必须审计修复，不要求用户补账户总额。0 元产品收益必须由用户或银行页面明确确认，不得推断为 0 或视为赎回。人工修正写入 `product_daily_valuation_audit`，并追加 `human_corrected` 证据事件。成交截图按 OCR 状态确认；交易落库后先匹配已采纳决策提案，只有无法匹配时才建立 `decision_status=incomplete`、`execution_status=unplanned` 的计划外决策。
- 逐产品收益 T+N 和来源只查 `product_yield_settings`。截图在 T+N 到账前未出现属于正常情况，不提示补图；到账后仍缺明细才按产品收益缺口处理。
- `/api/dashboard` 的 `workspace.product_valuation_summary` 提供产品数、持有/已赎回数、最新档案日和当前持仓最大 T+N；`product_valuation_summaries` 提供每只产品的累计个人收益、档案/持有天数、负收益天数、最差单日与状态；`product_valuation_reconciliation` 按 `yield_date` 返回 `waiting / missing-product-details / matched / mismatch`，并附 `expected_product_count`、`covered_product_codes`、`missing_product_codes`、`same_day_redeemed_product_codes`、`max_yield_lag_days`、`final_disclosure_date`、`waiting_product_codes`、`is_final`、`account_projection_status` 和 `account_projection_reason`。`account_pnl` 是产品汇总投影；本金未初始化、收益日早于起始日或本金为 0 时 `account_projection_status=pending`，差额保持 `null`，不得误报 mismatch。兼容字段 `missing_account_total` 如需保留只能恒为 0，界面不展示。完整逐日历史通过 `/api/product-valuations?product_code=...` 按需读取，避免 dashboard 随时间无限膨胀。
- `workspace.current_holdings_valuation` 是首页和交易与持仓页的当前持仓净值契约：主值为确认持仓本金加逐产品收益档案，另附逐产品组成、收益截止日、覆盖缺口和银行对照结果。银行快照头与逐产品明细仍保存在 `holding_valuation_snapshots`、`holding_valuation_items`，只作为对照证据；`GET/POST /api/holding-valuations` 读取派生净值并追加快照，写入必须事务化、幂等。银行持仓截图通过 `/api/holding-valuations/evidence` 保存为 `bank-statement` 证据，并以 `evidence_id` 绑定快照。
- 持仓结构不再手工维护快照，而是由交易流水推导。
- 交易流水是持仓唯一事实源：`lib/trade-store.js` 管理 `trade_transactions`、`trade_allocations`、`trade_inbox`、`trade_audit`、`app_meta`；已确认买入生成批次，赎回/切换按先进先出匹配批次并计算已实现盈亏。页面中的“未赎回成本本金”= 已确认买入金额 − 已匹配赎回本金，不是余额或当前市值。待确认买入只占额度，待确认赎回不改持仓，均不进入未赎回成本、期限桶和流动性比例。
- 交易收件箱支持本地拖入 PNG/JPEG/WebP；每日巡检以视觉识别原图为准，`scripts/split-trade-rows.mjs` 负责把多笔总览按行切分；`server/infrastructure/ocr/` 调用 `scripts/ocr-image.ps1` 使用 Windows 自带 OCR（zh-Hans-CN），只用于金额与代码的交叉校验，`lib/ocr.js` 仅保留兼容导出，OCR 子进程纳入服务关闭生命周期。`POST /api/trades/inbox/:id/vision-apply` 在冲突时返回 409 拒绝写入。`lib/trade-parser.js` 解析日期、类型、状态、代码、产品、金额、份额和期限。图片按 SHA-256 去重，业务字段按交易日期+类型+产品代码+金额+状态去重；原图默认保存在 `data/trade-inbox/`。已处理/已忽略且未被正式事实引用的原图才会进入 180 天自动清理，已被事实引用的证据永久保留。
- 决策提案由 `lib/decision-proposal-store.js` 管理 `decision_proposals`。可分配资金大于 0 时按目标产品生成买入提案；持仓复核达到 `replace` 时生成换仓提案。待采纳提案有证据日、有效期、置信度和预期交易腿；采纳才生成正式决策并标记 `lifecycle_status=accepted`、`execution_status=pending`，拒绝或过期不生成决策。已采纳但无交易时可取消，已有交易关联时不能直接取消。
- 截图/手工交易落库后会先按已采纳提案的交易方向、产品代码、金额容差和有效期匹配：完全匹配时自动关联原决策；金额差异在最大 20%（至少 1 元）内视为调整并记录；方向/产品不匹配或金额超差则不绑定，自动转成 `execution_status=unplanned` 的计划外决策。执行审计同时检查交易腿、金额、成交截图和 R2/PR2 风险等级，交易确认后把决策更新为 `execution_status=confirmed`。
- 2026-10-19 决策：截图识别采用方案 A（视觉优先、OCR 交叉校验），不做纯视觉，也不默认接入云端 OCR；理由是本机 OCR 布局丢失导致金额误读，而视觉能按行列正确还原。代价是截图会进入模型推理，OCR 本身仍留在本机。
- 旧 `holdings` 表仅作迁移与兼容输入；旧数据迁移状态只查数据库迁移记录。`/api/review/holdings` 兼容接口写入/撤销买入交易。
- 持仓汇总用于最大单只成本占比、短期流动性（7–30 天成本占比）、现有日开金额与占比、未来 12 个月到期阶梯和到期未赎回提醒；`buckets.short`/`short_bucket_ratio_pct` 表示评分桶 1–30 天，`short_ratio_pct`/`short_liquidity_ratio_pct` 表示 7–30 天流动性子集，现有日开不抵作该流动性。发行方名称、金额和占比只展示当前持仓状态，不参与限制或提醒。页面中的“未赎回成本本金”= 已确认买入金额 − 已匹配赎回本金，不是账户余额或当前市值。期限 0 天表示日开，不生成到期日。月度复盘可用 `GET /api/review/export?month=YYYY-MM` 导出 Markdown，月度结论会同步显示在复盘区历史月份。
- 决策日志新增 `strategy_version`、`target_annualized`、`bucket_plan`、`evaluation_at`；`bucket_plan` 默认 `{short: 30, medium: 35, long: 35, cash: 0, max_single}`，评估时点默认 `buy_day,holding,maturity`。旧库由 `migrateDecisionColumns` 自动补列；所有决策写入都会移除日开目标，`r2-3pct-v1` / target3 固定为 30/35/35，单只上限 30%。旧库由 `daily_open_zero_policy_v1` 自动归一一次。
- 决策日志另有 `evidence_date`、`verify_date`、`invalidation_condition`、`review_meta`；`review_meta.decision_completeness` 由服务端按理由、预期、证据日、验证日和失效条件计算。占位理由、`待补充：` 文本、空日期或空失效条件均视为不完整；不完整决策不能通过买入日流程检查。替换决策仍把当前/候选代码、快照日、比较期限、切换等待及核验状态、有效计息、费用、盈亏平衡和预计差额写入 `review_meta`。
- 持仓复核口径保存在 `holding_review_settings`（按 `product_code`）：赎回确认/到账 T+N、候选产品申购确认 T+N、赎回费/申购费、下一赎回开放日、备注、核验日期。实际比较期固定为 `BUCKET_COMPARISON_DAYS` 的短/中/长 `30/100/360` 天，候选申购确认默认T+1并可逐只覆盖，`W` 按当前产品赎回/到账和候选产品申购确认共同计算，有效计息为 `H-W`；门槛由持仓本金、桶比较期和 90 天基准动态计算。计算逻辑在 `lib/holdings-review.js`，版本为 `r2-holding-review-v7`。
- 自动评估规则版本为 `r2-eval-v2`：买入日先检查决策完整性，再检查期限桶（默认容差 10pp）、单只上限、短期桶下限和日开新增额度 0%；持有期仍做组合级月度评估，短桶流动性只看 7–30 天，现有日开单列，逐产品每日收益只作为个人持有表现档案，短样本不直接生成稳定年化结论；到期/赎回按批次本金、加权持有天数、到账金额计算实际年化。结果按期限 hurdle 判断，默认短 2.5%、中 2.8%、长 3.0%，组合目标默认 3%。
- 自动评估去重：同一决策、同一 `buy_day` 阶段、同一规则版本只保留最新一条待确认评估。交易或决策日期校正后，旧待确认评估自动标记为 `undone`，对应任务以 `skipped` 关闭、提醒标记已处理；历史记录保留，不物理删除。
- 评估置信度默认 75% 才自动写入；低置信度、金额缺失、决策证据不完整或与手工评价冲突时进入 pending 队列，并存 `automation_jobs`。结果未知或建议评价仍为“待评估”时，`forceApplyRun` 拒绝人工空确认。写入记录 `evaluation_runs.previous_*`/`applied_*` 快照，可撤销；单产品评估与组合决策评估分 scope 保存。
- 自动评估界面默认按“决策/交易 + 阶段”只展示最新有效结论，排除 `undone` 和旧规则版本重复项；完整审计历史需主动展开。买入日只显示流程检查结论，持有期和到期/赎回才显示结果结论；每条当前结论带 `evidence.next_update` 说明下一次自动更新时间。
- 本地自动化由 `server/jobs/automation-scheduler.js` 在服务启动后 250ms 补跑一次，之后按 `scheduler_minutes`（默认 5 分钟）巡检：收件箱、到期、对账、评估、月度/季度草稿、通知去重。调度器提供失败重试、指数退避、停止清理和执行状态；启动时会把中断的自动任务标记为失败。任务、通知、草稿、自动化运行日志都在 SQLite，服务重启不丢。超时、中断和重试边界以代码及 `TODO.md` 为准，不在本文件保存当前支持程度。
- 月度/季度草稿自动汇总收益、目标差距、流程正确/错误数、评估 pending、产品事件、持仓和异常；草稿不会自动写成正式复盘，需在“月度五问/季度复盘”采用并确认。
- Codex 定时任务的名称、运行时间、模型和完整提示词只查 `codex-automations/` 与本机实际任务定义。任务职责是先处理 `screenshot_review`、`income_screenshot_review`、`evaluation_review`、`monthly_summary`、`quarterly_summary`，再读取 `decision_proposals` 并按 `meta.reporting_date` 巡检已披露收益、逐产品收益档案与账户/产品对账；`meta.reporting_date` 已按当前持仓最大 T+N 推算。产品-only 截图会按产品合计自动形成账户总账；等待期只提示覆盖未齐，不要求补账户总额；`missing-account-total` 已退役，只有最终缺产品或投影完整性异常进入行动项。产品缺失不写 0。任务只能提醒用户采纳/拒绝提案，不得代替用户决定、创建交易或下单。
- 导出 CSV：`date,principal,daily_pnl,action,notes`。

### 复盘与评估口径

- 决策日志事后评价四类：流程正确结果好、流程正确结果差、流程错误结果好、流程错误结果差；另有“待评估”。“流程错误，结果好”单独标黄。
- 持仓结构按未赎回成本计算：单只超过 30% 警告；短期流动性子集（7–30 天）低于 30% 警告；发行方占比只展示，不生成参考上限、警告、消息中心提醒或买入阻断；现有日开单独提示迁移事实，不计入 7–30 天流动性；到期日早于今天且尚未赎回的批次提示“到期未赎回”。
- 期限桶：日开、1–30 天、31–100 天、101 天以上、未填期限；期限 0 天表示日开，不生成到期日。
- 月度五问按 `YYYY-MM` 保存，季度清单按 `YYYY-Qn` 保存；月度结论和“下月只改一件事”会显示在复盘区历史月份，并带“已复盘”标记。
- 时间轴按日/周/月/季判断：日记录缺失优先高亮；周五起高亮周检查；上月五问在 5 日后未填标“待补”；上季清单在季度首周后未填标“待补”。
- Markdown 导出包含月度指标、目标进度、环比、决策日志、产品事件、五问、结论和当前持仓快照；持仓是导出时快照，不是月末快照。

## 4. 运行与测试

- 生产守护：`npm run prod:deploy`；日常使用 `prod:status`、`prod:start`、`prod:stop`、`prod:restart`。
- 守护脚本通过 `run/server.stop` 请求 Node 优雅关闭，超时才强杀；关闭流程会停止调度器、终止活动 OCR 子进程、关闭 HTTP Server 和数据库。进程和健康状态一律以实时 `prod:status` 为准，不在本文件保存固定 PID 或一次性验收结论。
- Node 服务由 Supervisor 以前台子进程方式托管，Node 自写 `run/server.pid`，Supervisor 使用 `$LASTEXITCODE` 记录退出码。登录自启优先使用单次任务 `QianDuoDuo-AutoStart`，权限不足时使用当前用户 Startup 快捷方式；它只负责在用户登录时执行一次 `daemon.ps1 -Action start`，不得增加周期重复、健康巡检或外部 Watchdog 循环。`prod:stop` 停用自启，`prod:start` 重新启用。
- 手动前台：双击 `start.bat`，执行构建后启动 `8765` 服务。
- 开发模式：双击 `start-dev.bat` 或运行 `npm run dev:all`；Vite 页面为 `5173`。
- `dist/` 只会在 `npm run build`、`npm start` 或 `start.bat` 时更新。
- Node.js 要求 24+；启动脚本支持 PATH 未刷新时回退到 `C:\Program Files\nodejs`。
- 检查与测试：`npm run check`、`npm test`；测试必须使用临时 SQLite，不得清空正式库。
- 测试通过数量、覆盖率、构建结果、生产重启和健康检查结果只写当次交付说明；本文件不保存测试快照。
- `npm run test:e2e` 的具体覆盖范围随改动扩展，以测试代码和当次运行输出为准。
- 生产日志在 `logs/`，守护器和 Node 的 PID 在 `run/`。

## 5. 数据存储与 Git

账户本金、交易、收益、持仓、复盘状态、产品筛选结果和市场快照都是时效性事实，只从数据库、API、CSV 或当次分析中读取；本文件不保存个人账本快照、产品池数量或一次性回测结果。可长期保留的原则是：历史收益快照不等于未来收益，任何时点都不能把研究观察池或 1Y 快照直接当作目标达成证据。

- 公开数据源：`POST https://finprod.paas.cmbchina.com/api/prod/queryProdList`，条件 `type=PN/isOwn=C/isPublic=Z/status=1/riskLevel=R2/crossFinance=Z`；`pastPerf.tqilstw4z3` 的 A/B/C/D/F = 1M/3M/6M/1Y/成立以来；`zchrCst+chrmn2+chrsal` 为固定费率，`begdat` 为下一开放日，`buynfq` 为起购金额。签名从公开页面捕获，不硬编码。
- 数据备份：启动时自动写入 `data/backups/r2_ledger-YYYY-MM-DD.sqlite`，保留 45 天；`npm run db:list|db:backup|db:restore` 可手动查看、备份和恢复。
- 钱多多应用 Git 仓库：远程 `https://github.com/pjimming/qianduoduo.git`，分支 `main`；`dist/`、`node_modules/`、`.env` 和 SQLite 文件均被 Git 忽略。
- R2 skill Git 仓库：本地 `C:\Users\Administrator\.codex\skills\r2-wealth-management`，远程 `https://github.com/pjimming/r2-wealth-management.git`，分支 `main` 跟踪 `origin/main`；该仓库根目录同时是 Codex 实际加载的 skill 目录，包含 `SKILL.md`、`README.md`、`agents/`、`assets/`、`references/` 和 `scripts/`。修改后直接在该目录验证、提交和推送，不再复制到其他路径维护第二份。

## 6. 自动化任务

- `r2`：运行 `scripts/fetch-cmb-r2-all.cjs`，刷新全量/五档研究池/精选 CSV 并调用刷新接口；检查 `products.stats.evidence_counts`、`reference_status_counts`、可评分数、期限调整参考年化和 10%/20% 证据上限。额度仍需在招行 App 当日核验。
- `r2-2`：先处理 Codex 判断队列（截图视觉优先、多笔图按行切分，OCR 只做金额/代码交叉校验），再巡检决策提案、已披露收益记录、逐产品收益与对账、待确认交易、到期、自动评估和复盘节点；产品-only 收益截图按产品合计形成账户总账，对账只处理最终缺项或投影完整性异常，等待期内保持安静。替换候选写明证据档位、缺失窗口、`yield_status` 和单只 10% 闸门，参考年化按期限桶窗口重新归一化。产品仪表盘字段为 `workspace.product_valuation_*`。今日收益未披露不算缺记，无异常保持安静。
- `r2-3`：检查决策提案、记录完整度、逐产品个人表现、账户/产品对账、单只与期限桶结构、流动性、证据档位暴露、到期阶梯和下周动作；6M/3M 候选执行单只 10%、同类合计 20%，现有持仓不追溯判违规。替换与结构卡读取 `yield_status/yield_reason` 和期限调整参考年化。发行方金额与占比只展示，不判越线；个人产品表现只作观察证据，不换算稳定年化。对账只报告最终缺产品或投影完整性异常，等待到账不写用户例外。只在有风险/待办时发周卡。`r2-2`/`r2-3` 都不得代替用户采纳、拒绝或取消提案。
- `r2-4`：周一产品快照后按冻结的样本外观察规格追加幂等周样本。固定 cohort、5–10 天数据日间隔、覆盖率与内部不变量闸门必须先通过；少于 4 个只保持 collecting，4–7 个仅在预注册异常时复核，达到 8 个里程碑也须复核并请用户决定。超过周窗口进入 `cadence_broken`，台账完整性问题进入 `ledger_invalid`，不得静默跳过、回填或自行改基线。参数复核必须继续使用同一固定 cohort；排名稳定性和披露收益代理不等于真实经济结果，任何观察都不得自动修改正式权重、排名、目标或提案。
- 定时任务的完整提示词、模型配置和跨机器复现步骤见 `codex-automations/README.md`；从零初始化与分享清单见 `SETUP.md`。本机实际定义在 `%USERPROFILE%\.codex\automations\<id>\automation.toml`，不要把该目录原样分享给他人。
- 分工：事实层可由自动化维护；判断层由 Codex 起草证据、用户确认后落库；禁止下单/赎回/转账、删除记录、覆盖手工评价或对外发送。
