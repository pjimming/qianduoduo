Method: dual-agent baseline (A: UI-AUDIT-20261106-03 · B: UI-AUDIT-20261106-04), followed by a desktop verification pass

# 钱多多前端设计与技术审计

2026-11-06 · 工作区基线 `2406de2`。范围为七个理财入口、三个投资入口和一篇应用内报告阅读页。按用户确认的实际使用场景，审计与验收聚焦桌面。

## 结论

**设计特异性有基础，系统一致性尚未通过。** 已确认持仓净值、披露归属日、异常待办、同桶复核和图谱到报告的联动均源于真实任务。需要调整的是视觉和操作顺序。当前概览首屏先突出标语和 3% 目标，异常入口排在图表及归因之后。页面间的状态色、字号、控件和反馈由多套 CSS 及局部规则控制。

优先处理三类问题：

1. **操作意图和数据归属**。取消拒绝对话框仍提交，删除确认默认聚焦危险按钮，切换简报时日期短暂指向旧正文。对应 A01、A02、B01。
2. **两项首批页面的阅读顺序**。收益概览把最新收益、已确认持仓净值、截至日和异常放到首屏，产品与配置先显示期限桶差额、未分配原因及同桶比较入口。对应 O01–O03、P01、P03。
3. **桌面可读性和键盘**。图谱与报告存在低于字号下限的文字，报告宽表的右箭头被切篇快捷键截获。对应 A03、A04、R01。

保留已验证有效的能力：按理财和投资分组的侧栏、各页按需加载分区、累计收益与日收益视图、截图进入待办的路径、报告日期和锚点、宽表容器、带文字的状态及浅色与深色切换。

## 范围与方法

- 沿用同一源码基线上的独立评审。**设计评审 A**检查视觉、任务流程和 Nielsen 启发式，**技术评审 B**运行 Impeccable detector，检查渲染及源码。评分及已记录的交互证据来自两份评审。桌面复核补测渲染与两项显示问题，沿用原评分。
- 复核从当前 Vite 源码启动独立的 loopback 服务，使用临时 SQLite、合成持仓与正负收益以及现有研究资料。Chrome 156 在 1280×900、1440×900 和浅色、深色的四组组合下加载 11 页，共 44 个页面实例。均返回 HTTP 200、渲染主标题，页面根节点无横向溢出，采样未捕获 JavaScript 页面异常。截图核查覆盖收益概览双主题和浅色配置页。基线交互评审在浏览器截获拒绝请求。真实账本与生产服务未参与。
- 候选池实测为空，同桶候选筛选效率和长名称待后续用隔离样本验证。报告正文仅抽样，公开静态归档与实际屏幕阅读器未验收。机械检查和浏览器复核仅在本机运行。
- **P1** 表示可能误操作、误读或主要路径明显受阻。**P2** 表示可绕过的理解或效率问题。**P3** 表示细节改进。未观察到 P0。对比度及键盘参考 [WCAG 2.2](https://www.w3.org/TR/WCAG22/)，字号门槛来自 [AGENTS.md](AGENTS.md#7-界面可读性与最小字号强制)。

### Impeccable 检测结果

基线记录 17 条结构提示，包括 `side-tab` 15 条、`codex-grid-background` 1 条、`border-accent-on-rounded` 1 条。当前带 `DESIGN.md` 复跑 `detect --json src` 退出码为 2，共 666 条，包含相同的 17 条及 649 条对照设计文档的提示（字号 272、颜色 229、圆角 148）。前置 token 只选录代表值，未收录的 42px 展示字号、危险按钮颜色和 8px 圆角即会触发提示。已结合级联与实际用途抽查，提示总数用于定位复核范围。 [布局背景与导航](src/styles/layout.css#L1) · [按钮与展示字号](src/styles/controls.css#L99) · [配置卡片](src/styles/r2-pages.css#L478)

图谱在 `techmap.css:306,336` 的两处 CSS 边线实际组成折叠三角，属于误报。当前页指示、节点类别、推荐候选、高影响消息和引文的边线具有功能，保留其状态语义。装饰网格和多套卡片边线与人工评审所见的层级竞争一致。机械提示未按产品缺陷累计。

基线技术评审在概览、每日记账、产品与配置、报告库和图谱的五个隔离渲染页中确认检测脚本、叠层和控制台输出。叠层在临时 headless 浏览器运行，服务随后关闭。本次用 CLI 和 Playwright 复核。目标标识为 `src`，无忽略清单。

## Critique 评分

站点综合 **21/40**，属于可用且需要明显改进。评分 0–4，满分表示完成度很高。列依次为状态可见、贴近真实任务、用户控制、一致性、错误防护、识别优先、效率、简洁、错误恢复和帮助。本轮十项均适用，综合分是对跨页关键任务的独立判断。

| 页面 | 状态 | 任务 | 控制 | 一致 | 防错 | 识别 | 效率 | 简洁 | 恢复 | 帮助 | 总分 /40 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 全站 | 2 | 3 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | **21** |
| 收益概览 | 3 | 2 | 2 | 2 | 3 | 2 | 2 | 1 | 3 | 2 | 22 |
| 消息中心 | 2 | 3 | 1 | 2 | 1 | 2 | 2 | 2 | 1 | 2 | 18 |
| 每日记账 | 3 | 3 | 2 | 2 | 3 | 2 | 3 | 2 | 2 | 3 | 25 |
| 交易与持仓 | 3 | 3 | 3 | 2 | 3 | 2 | 2 | 2 | 2 | 2 | 24 |
| 产品与配置 | 3 | 2 | 3 | 2 | 2 | 2 | 3 | 1 | 2 | 2 | 22 |
| 复盘 | 3 | 3 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 2 | 22 |
| 决策与评估 | 2 | 2 | 1 | 2 | 1 | 2 | 2 | 2 | 2 | 2 | 18 |
| 科技图谱 | 3 | 3 | 3 | 2 | 2 | 2 | 3 | 2 | 2 | 2 | 24 |
| 调研报告库 | 2 | 2 | 2 | 2 | 2 | 2 | 3 | 1 | 1 | 2 | 19 |
| 每日市场简报 | 1 | 3 | 3 | 3 | 1 | 3 | 3 | 2 | 3 | 2 | 24 |
| 应用内报告阅读 | 3 | 3 | 1 | 2 | 1 | 3 | 2 | 2 | 2 | 2 | 21 |

### 任务走查

- **高频操作用户**从概览看收益与异常。金额和截止日可读，但期内年化在目标与指标卡中重复，异常要经过曲线和归因才能到达。继续对照研究时，从报告返回库会丢失原搜索和筛选。
- **键盘用户**进入图表和报告表格。图表时间范围可操作，数据点浮层主要依赖指针。报告宽表能聚焦，按右方向键却跳到下一篇，打断数据对照。
- **首次使用者**选取成交与收益截图时看见“拖入”说明及多个分区。应更明确告知可点击选文件，以及选图成功、识别、确认和完成各阶段的区别。

## Audit 评分

| 维度 | 分数 /4 | 关键证据 |
| --- | ---: | --- |
| 可访问性 | 2 | 可聚焦表格与共享确认框已存在，报告快捷键抢占、部分文本对比与图表交互有问题。 |
| 性能 | 3 | 路由、报告正文与全文索引有按需边界，首个全文查询仍需加载 1.17 MB 的独立索引。 |
| 主题 | 2 | 有完整切换入口和基础语义变量，前景配对与页面局部样式漂移。 |
| 桌面布局 | 3 | 44 个桌面样本未见页面根横向溢出。产品配置摘要仍有关键字段截断，部分表格的上下文与快捷键存在问题。 |
| 实现一致性 | 2 | 共用外壳和变量有效，原生拒绝提示、字号覆盖、标签语义及错误状态出现重复分叉。 |
| **合计** | **12/20** | 可用，需要改进。桌面范围评分。 |

### 共享问题

| ID | 级别 | 问题与证据 | 改进 |
| --- | --- | --- | --- |
| A01 | **P1** | 消息中心与决策提案的拒绝理由调用 `window.prompt`，取消被转为空字符串。浏览器拦截确认两处都会发出 `POST …/reject`。 [InboxView.vue](src/views/r2/InboxView.vue#L154) · [DecisionProposalPanel.vue](src/components/review/DecisionProposalPanel.vue#L47) | 取消直接结束。复用可取消的确认框，写明对象和后果。成功后显示回执，失败保留原状态。用 `harden`。 |
| A02 | **P1** | 每日记账删除确认用 Enter 打开后，两种桌面主题均默认聚焦“删除记录”。按 Esc 关闭后焦点落到 `body`，丢失原记录位置。未执行删除。 [ConfirmDialog.vue](src/components/ConfirmDialog.vue#L55) | 危险确认优先聚焦取消，关闭后还焦到触发点或有意义的后继位置。保留标题、后果说明和对话框内 Tab 循环。用 `harden`。 |
| A03 | **P1** | 浅色“7天”按钮 3.85:1，“产品 / 批次”表头和“待采纳 0”均 3.93:1，低于 WCAG 1.4.3 的 4.5:1。部分焦点描边按样本底色合成约 1.36:1（浅）与 1.62:1（深）。深色常用次级文字与卡片底配对约 6.23:1。 [tokens.css](src/styles/tokens.css) · [theme.css](src/styles/theme.css) · [controls.css](src/styles/controls.css#L50) | 建立实际搭配的正文、次级文字、焦点和状态语义变量。补测实际图表轴、控件边界与各底色的焦点。用 `colorize`。 |
| A04 | **P1** | 图谱小于 12px 的直接文本元素在脑图/树状/表格分别采到 21/1185/1296 个（含首屏下方，最低样本 10.5px）。抽样 AIGC 报告三处图中数据为 11.5px。通用 `readability.css` 与其后的覆盖存在历史小字号。 [techmap.css](src/styles/techmap.css#L344) · [readability.css](src/styles/readability.css) · [抽样报告](report/AIGC-行业调研-2026-11-06.html#L118) | 按主区、侧栏、表格、SVG 和报告逐项核查渲染大小。先覆盖可复现的不足 12px 文本，再逐步收敛到字号变量。用 `typeset`。 |
| A05 | **P2** | Vite 审计构建到系统临时目录。独立全文索引为 1,168.55 kB，gzip 457.84 kB，全局 CSS 约 170.32 kB。索引通过独立模块按需加载。当前证据说明构建体积，未测用户感知延迟。 [InvestmentResearchView.vue](src/views/InvestmentResearchView.vue#L58) · [main.ts](src/main.ts) | 记录首个全文查询与全局样式的加载成本，再评估分片、缓存和样式路由拆分。用 `optimize`。 |
| A06 | **P3** | 减少动态效果时，通用 CSS 把动画和过渡时长统一压到 0.01ms。Chrome 验证滚动转为即时。 [panels.css](src/styles/panels.css#L2148) | 分辨需要取消的位移与需要保留的状态反馈，对组件逐项覆盖。用 `animate`。 |

### 按页面记录

| 页面 | ID / 严重程度 | 问题、证据与影响 | 改进建议 |
| --- | --- | --- | --- |
| 收益概览 `/ledger/overview` | O01 **P1** | 1280×900 下，3% 目标卡从 y=42 开始，图表从 y=500 开始，概览内异常入口在 y=2659。1440×900 异常入口仍在 y=2632。页内开头突出标语和参考年化，用户要通过侧栏或继续滚动才可处理异常。 [OverviewView.vue](src/views/r2/OverviewView.vue#L83) · [HeroSection.vue](src/components/HeroSection.vue) | 将最新收益、已确认持仓净值及日期、异常数和首要待办放在同屏摘要。进取目标保留样本说明，移到相应指标旁。用 `layout`。 |
| 收益概览 | O02 **P2** | 两张曲线分别提供相同的区间按钮，定位数据点主要靠指针。日期、金额和收益率需要同时核对。 [AssetChart.vue](src/components/AssetChart.vue#L410) · [PnlChart.vue](src/components/PnlChart.vue#L497) | 验证共享区间是否符合对照任务，补键盘可达的逐点值和摘要，标注净值或收益的口径及范围。用 `harden`。 |
| 收益概览 | O03 **P2** | 两日正负收益样本在 1280px 浅、深色的累计收益图中，两条高度不同的水平刻度都标为 `−1`。金额刻度在千元以下按整数显示，小区间的不同刻度会显示相同标签。 [AssetChart.vue](src/components/AssetChart.vue#L106) · [useFormatters.ts](src/composables/useFormatters.ts#L47) | 让轴标签显示精度随刻度间隔变化，注明单位。覆盖跨零、小额和大额样本，保持点值和财务计算口径。用 `typeset`。 |
| 消息中心 `/ledger/inbox` | I01 **P2**，另见 A01 | 合成数据有待办时搜索无匹配，页面仍说“当前没有需要你处理的消息”。聚焦带 `role=tab` 的筛选按钮后，按右方向键不移动焦点。 [InboxView.vue](src/views/r2/InboxView.vue#L205) | 区分无待办与无匹配，显示筛选范围和清除入口。完善标签键盘模型，或用普通筛选按钮语义。用 `clarify`、`harden`。 |
| 每日记账 `/ledger/daily` | D01 **P2**，另见 A02 | 页标题和上传区重复解释同一任务，外层面板、内层卡片和拖放框同时描边。两类截图任务可以直接对照，但点击选文件的能力埋在“拖入”语义中。 [DailyEntryView.vue](src/views/r2/DailyEntryView.vue#L142) · [QuickEntryPanel.vue](src/components/review/QuickEntryPanel.vue#L470) | 保留两列并行入口，收敛到一层分组，给每类截图明确的“选择文件”动作。异常、历史、本金按任务独立。用 `distill`。 |
| 每日记账 | D02 **P2** | 上传后使用全局 Toast 提示结果，多张文件串行处理。识别失败、待补正和已入账对应不同下一步，短暂反馈不便回看。 [QuickEntryPanel.vue](src/components/review/QuickEntryPanel.vue#L204) | 展示每张文件的结果和下一步，失败可重试，保持现有去重与证据关联。用 `harden`。 |
| 交易与持仓 `/ledger/trades` | T01 **P2** | 当前持仓净值、持仓结构、产品收益、流水与收件箱在同一条长页面中，各自强调相近数据，查持仓口径时需来回定位。 [TradesView.vue](src/views/r2/TradesView.vue#L87) | 用当前净值、截止日、到期/披露异常组成摘要。把持仓、收益与流水放到独立次级视图，深链仍指向对应区块。用 `layout`。 |
| 交易与持仓 | T02 **P2** | 桌面样本出现约 24×19px 的行内操作，部分操作相邻。不同表的标识、对齐和操作区样式分散。 [review-workspace.css](src/styles/review-workspace.css#L488) · [CurrentHoldingsValuationPanel.vue](src/components/r2/CurrentHoldingsValuationPanel.vue#L131) | 统一数字对齐、产品标识、滚动和行操作，核对相邻动作热区及间距。用 `harden`。 |
| 产品与配置 `/ledger/products` | P01 **P2** | 页内索引、配置口径、目标进度和期限桶连续出现，配置差额与同桶复核需要跨区块读取。候选池为空时可进入产品池弹窗，未测满数据筛选效率。 [ProductsView.vue](src/views/r2/ProductsView.vue#L41) · [ProductsSection.vue](src/components/ProductsSection.vue#L231) | 首先展示当前配置差额、约束与同桶比较入口，把分配假设、低频规则和事件放到次级区块。用 `layout`。 |
| 产品与配置 | P02 **P2** | Chrome 可访问树中的产品快照弹窗缺少名称。Esc 关闭和返回触发键已正常。 [ProductDialog.vue](src/components/ProductDialog.vue#L900) | 把弹窗标题与 `dialog` 关联，保留当前焦点恢复行为。用 `harden`。 |
| 产品与配置 | P03 **P2** | 1280px 浅色下，进度条占据独立一列，配置摘要单行省略了尾部金额。在查看「无法完成分配」状态时，同一摘要无法同时读完本金、待确认买入、补仓/新开与未分配。 [ProductsSection.vue](src/components/ProductsSection.vue#L264) · [panels.css](src/styles/panels.css#L1122) | 将关键金额拆成可换行、标签清晰的字段。进度条与其文本合组，保留未分配原因及同桶复核入口。用 `layout`。 |
| 复盘 `/ledger/review` | V01 **P2** | 1280px 和 1440px 点击页内“月度五问”都只改变 hash，目标 `details` 仍折叠。用户要再展开才能开始。 [R2SectionIndex.vue](src/components/r2/R2SectionIndex.vue#L14) · [ReviewView.vue](src/views/r2/ReviewView.vue#L88) | 页头显示本期下一项。锚点打开相应详情、滚动并聚焦，历史维持可折叠。用 `harden`。 |
| 决策与评估 `/ledger/evaluation` | E01 **P1**，与 A01 同根 | 拒绝理由取消仍发请求。提案变更可能与用户意图相反。 [DecisionProposalPanel.vue](src/components/review/DecisionProposalPanel.vue#L47) | 两个入口共用确认与取消规则，测试拒绝、重复点击和失败回退。用 `harden`。 |
| 决策与评估 | E02 **P2** | 提案、日志、预测校准与自动评估并列，待确认事项与只读历史处于同一级。用户需要在四个分区寻找下一步。 [EvaluationView.vue](src/views/r2/EvaluationView.vue#L65) | 按“待我处理”和“历史与分析”组织，并把理由、样本边界和下一验证点并列。用 `layout`。 |
| 科技图谱 `/investment/tech-map` | M01 **P1** | 图谱节点元数据和说明低于 12px，画布默认缩放进一步降低实际阅读大小。 [techmap.css](src/styles/techmap.css#L344) · [TechMapCanvas.vue](src/components/techmap/TechMapCanvas.vue#L656) | 保证初始阅读尺寸。缩放变化时保留可在树状或表格中读取的同一节点信息。用 `typeset`。 |
| 科技图谱 | M02 **P2** | 视图切换、搜索、打印、全屏、展开和缩放同时占据工具区，视图标签无法通过右方向键切换焦点。脑图节点展开仅有点击，树状与表格提供另一条浏览路径。 [InvestmentTechMapView.vue](src/views/InvestmentTechMapView.vue#L126) · [TechMapCanvas.vue](src/components/techmap/TechMapCanvas.vue#L723) | 突出视图和搜索。按操作频率分组其他动作，补方向键和焦点反馈，确保键盘能展开与进入同一节点。用 `distill`、`harden`。 |
| 调研报告库 `/investment/research` | L01 **P2** | 分类按钮共 28 个。选“电子材料”后搜“利润革命”，元数据结果为零，正文仍命中 AIGC。返回库会丢失搜索状态。 [InvestmentResearchView.vue](src/views/InvestmentResearchView.vue#L17) | 提供常用分类与“更多”，区分正文和元数据范围，在返回时恢复筛选和滚动位置。用 `clarify`、`layout`。 |
| 调研报告库 | L02 **P2** | 正文索引失败缺少可见错误与重试。用户易把未加载当作无命中。 [InvestmentResearchView.vue](src/views/InvestmentResearchView.vue#L58) | 分开加载中、已查无结果和暂时不可用，提供重试并保留查询词。用 `harden`。 |
| 每日市场简报 `/investment/briefs` | B01 **P1** | 拦截并延迟 Markdown 1.2 秒，切至 11-04 时纸面日期先更新而正文仍为 11-05。阻断请求时同时出现“已按日期加载原文”与“简报读取失败”。 [InvestmentBriefsView.vue](src/views/InvestmentBriefsView.vue#L68) · [页内状态](src/views/InvestmentBriefsView.vue#L210) | 将展示日期绑定到已加载正文，明确标记过渡状态并提供重试，保留日期深链。用 `harden`。 |
| 每日市场简报 | B02 **P2** | 页眉在日期区后还展示 Markdown 加载说明，正文固定八章，当前页面缺少面向读者的章内导航。 [InvestmentBriefsView.vue](src/views/InvestmentBriefsView.vue#L153) | 把日期导航和数据状态合为一组，提供关键章节锚点，保留日期、来源、表格单位与原章节。用 `layout`。 |
| 应用内报告阅读 `/investment/research/:slug` | R01 **P1** | 在抽样报告中，1280px 时宽表容器 700px、内容 980px，1440px 时容器 860px。两次聚焦表格后按右方向键均切到下一篇，原生横滚被截获。涉及 WCAG 2.1.1 的键盘可操作性。 [InvestmentReportView.vue](src/views/InvestmentReportView.vue#L138) | 左右切篇快捷键避开表格与其他原生可交互元素，保留独立目录和可聚焦表格。用 `harden`。 |

## 后续交付顺序

按 [UI_REDESIGN_PLAN.md](UI_REDESIGN_PLAN.md) 执行。先确认设计系统，再以收益概览、产品与配置分别试点。按页面批次处理误提交、日期归属和键盘问题，相关回归作为该页交付条件。最后进行 `polish`。
