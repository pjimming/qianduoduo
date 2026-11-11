# 钱多多财富工作台 · 使用手册

定时任务运行安排（2026-11-05）：Codex 的 5 个任务均已启用，沿用原日程。模型和推理档位见下方定时任务章节链接的配置表。

钱多多是本地运行的 R2 理财、股票研究和报告发布工作台。日常入口为 `http://127.0.0.1:8765`；数据和截图只保存在本机。

- 项目概览：[README.md](README.md)
- Agent 规则：[AGENTS.md](AGENTS.md)
- 长期契约：[MEMORY.md](MEMORY.md)
- 定时任务：[codex-automations/README.md](codex-automations/README.md)
- 切换 Codex 供应商后，定时任务模型与会话恢复配置须同步迁移；任务时间和业务提示词保持原定义。

## 30 秒版

1. 双击 `start.bat`，打开工作台。
2. 首次使用先设置起始本金和起始日期。
3. 每天晚上先处理消息中心，再上传成交截图和收益截图。
4. 买入、赎回或切换前先记录或采纳决策；交易后补成交截图，再补收益截图。
5. 每周看期限阶梯、流动性和产品事件；每月完成复盘，到期或赎回后完成评估。
6. 股票研究默认生成 HTML 报告并发布到报告库。

## 1. 工作台边界

| 模块 | 主要数据 | 用途 |
| --- | --- | --- |
| 收益概览 | `data/r2_ledger.sqlite` | 目标、收益、净值、自动复盘评分、截图入口和待办 |
| 消息中心 | 同一 SQLite | 待补事实、提醒、确认和深链 |
| 每日记账 | 同一 SQLite | 成交/收益截图、每日记录、本金和例外补正 |
| 交易与持仓 | 同一 SQLite | 当前持仓净值、交易流水、持仓结构 |
| 选品与配置 | `data/cmb_r2_*.csv` / `data/r2_screening.sqlite` | 初筛公开份额、批次、原始单位净值与公开数据可行性校验；配置；持仓复核和替换 |
| 复盘 | 同一 SQLite | 收益归因、月度五问、季度复盘 |
| 决策与评估 | 同一 SQLite | 决策日志、提案、自动评估和预测校准 |
| 每日市场简报 | `market-briefs/*.md` | 八章盘后全景、资金、政策、估值和后续展望 |
| 股票调研报告库 | `report/*.html` | 阅读、搜索和切换调研报告 |
| A 股科技图谱 | `src/data/techmap.json` | 脑图、树状和表格三种产业视图 |

R2 账本与股票研究严格隔离。股票报告和科技图谱不进入 R2 账本、产品池排序或选品结论；R2 数据也不用于股票估值。

应用不登录银行账户、不保存密码、不代替用户下单、赎回、转账、删除事实或发送外部消息。额度、费率、风险等级和赎回规则必须以招行 App、产品说明书和当日公告为准。

## 2. 安装与启动

要求 Node.js 24 或更高版本。

```powershell
npm install
```

生产模式：

```powershell
npm start
```

或双击 `start.bat`。页面为 `http://127.0.0.1:8765`，数据库为 `data/r2_ledger.sqlite`。

开发模式：

```powershell
npm run dev:all
```

或双击 `start-dev.bat`。开发页为 `http://127.0.0.1:5173`，Vite 将 `/api` 代理到 `8765`。

只需要手动分终端时：

```powershell
npm run server
npm run dev
```

环境变量复制 `.env.example` 为 `.env`：

- `VITE_API_BASE_URL`：生产 API 前缀，留空表示同源。
- `VITE_API_PROXY_TARGET`：开发代理目标，默认 `http://127.0.0.1:8765`。
- `R2_TRADE_INBOX_DIR`：成交截图归档目录。
- `R2_OCR=0`：关闭本地 OCR，截图仍可归档并手工校正。

## 3. 日常使用

### 每天

1. 打开收益概览，处理消息中心和待确认事项。
2. 有交易时上传成交截图；有收益时上传收益截图。
3. 检查收益记录、交易状态和到期提醒。

### 每周

1. 检查本周记录完整度。
2. 检查未来 30/90 天到期阶梯。
3. 检查单只、短期桶和流动性结构。
4. 处理产品事件和仍未完成的待确认事项。

### 每月

1. 查看自动复盘草稿。
2. 完成月度五问，确认“下月只改一件事”。
3. 导出 Markdown 复盘。

### 季末

完成季度复盘清单，并核对下季度到期、流动性和产品变化。

## 4. R2 本金与每日记录

### 4.1 本金

- 首次进入时设置起始本金和起始日期。
- 后续通过“转入/转出”维护本金，不修改历史收益金额。
- 当日本金 = 起始本金 + 截至当日累计转入 − 累计转出。
- 起始日前的日期不属于收益账本，不计缺记、完整度或目标，也不接受补记。

### 4.2 每日记录

- 当日收益由逐产品收益汇总，亏损为负。
- 当日持仓金额来自已确认且未赎回的买入成本；待确认交易和临时桥接本金不计入。
- 日收益率 = 当日收益 ÷ 当日已确认持仓金额。
- 记录日参考净值 = 当日本金 + 截至该日累计收益，只用于历史曲线和按日分析。
- 同一日期同一收益金额幂等；不同金额只提醒，不覆盖原事实。
- 0 元是有效收益值，只有用户或银行页面明确确认时记录。

月度评级：

| 月收益率 | 评级 |
| ---: | --- |
| < 0.16% | 不及格 |
| 0.16% | 及格 |
| 0.20% | 良好 |
| 0.25% | 优秀 |
| ≥ 0.30% | 卓越 |

起始日起可记录天数不足 28 天，或账本期内少于 20 条时，只标“样本不足/进行中”。

## 5. 交易、决策与证据

每笔买入、赎回和切换都必须关联决策与原始交易证据，待确认、手工录入和截图入账也适用。

决策至少记录：

- 原因和预期；
- 期限、收益口径和策略版本；
- 证据日期、验证日期和失效条件；
- 其他后续评价所需事实。

交易状态：

- 待确认交易只占额度，不计持仓和收益。
- 确认后的买入生成持仓批次；确认后的赎回按先进先出匹配批次。
- 持仓期限、到期日和持有天数从 `confirm_date` 起算；下单日单独保留。
- 赎回支持部分赎回，实际到账金额与成本差额计入已实现盈亏。

多笔订单截图先运行：

```powershell
node scripts/split-trade-rows.mjs <图片> <输出目录>
```

逐笔核对产品、方向、金额、日期和状态后分别绑定。总览图只保留为批次来源。

## 6. 收益截图与对账

- 一张收益截图按已确认持仓代码拆分多只产品。
- 日期和至少一条产品明细明确后，产品事实写入 `product_daily_valuations`。
- 账户总账 `daily_records` 在同一事务内按当日产品合计重算。
- 截图中的账户金额只作可选核对，不覆盖产品汇总。
- 合并收益的覆盖日期只消除来源缺口，金额仍归记录自己的 `yield_date`。
- 产品 T+N 只判断披露进度，不改写用户明确提供的收益日期。
- 最终披露日前保持“等待到账”；次日仍缺才提示。
- 同日确认赎回但收益归属未知时，只提示确认，不直接判定漏记。

日常提醒日使用 `meta.reporting_date = today - max(当前持仓 yield_lag_days)`；没有当前持仓时才使用昨天。

消息中心中的补事实或最终确认事项通过 `POST /api/inbox/confirmations` 持久化，并使用确定性 `dedupe_key` 去重。消息中心只保留待处理和稍后提醒；事项处理完成或来源消失后，对应 `inbox_items` 投影会自动删除，底层通知、事实和审计记录不受影响。

## 7. 持仓结构与产品配置

### 7.1 当前持仓

- 持仓由确认买入批次和赎回匹配自动推导。
- “未赎回成本本金”是确认买入金额减已匹配赎回本金，不是余额或当前市值。
- 当前持仓净值 = 未赎回确认本金 + 逐产品累计收益 − 已确认赎回分配的已实现收益。
- 部分赎回同时减少持仓本金和剩余持仓收益；银行市值快照仅用于对账。

结构检查包括：

- 单只成本占比；
- 短期评分桶 1–30 天；
- 短期流动性子集 7–30 天；
- 现有日开金额和占比；
- 未来 12 个月到期阶梯；
- 到期未赎回批次。

### 7.2 产品池

产品区不是实时行情、额度承诺或买入建议。刷新命令：

```powershell
npm run r2:refresh-all
```

脚本生成：

- `cmb_r2_all-*.csv`：公开全量；
- `cmb_r2_universe-*.csv`：普通可买研究池；
- `cmb_r2_selected-*.csv`：研究观察池；
- `cmb_r2_snapshot-*.csv`：应用组合快照，包含开放与未开放产品。

“查看全部产品”默认只显示开放研究池。勾选“显示未开放产品”后，页面按需读取
`GET /api/products/unopened` 并追加未开放记录；这些记录明确标记“仅展示”，不参与评分、
研究候选、金额配置、提案或持仓复核。

期限调整参考年化按期限桶加权：

| 桶 | 权重 |
| --- | --- |
| cash | 1M 70% + 3M 30% |
| short | 1M 20% + 3M 50% + 6M 30% |
| medium | 3M 50% + 6M 30% + 1Y 20% |
| long | 3M 20% + 6M 40% + 1Y 40% |

缺失窗口按剩余权重重归一化；全部缺失时标记“不可计算”。新增日开目标为 0%，目标结构为短期 30% / 中期 35% / 长期 35%。6M 档和仅 3M 档单只最多 10%、同类合计最多 20%；仅 1M 新品只作人工观察。

### 7.3 持仓复核

持仓复核对当前产品和候选产品使用同一期限桶比较期：

- short：30 天；
- medium：100 天；
- long：360 天。

计算内容包括参考年化差、费用、赎回/到账 T+N、候选申购 T+N、有效计息、盈亏平衡和预计差额。锁定期内只显示“到期后可替换”；估算等待期不能通过执行闸门。

### 7.4 选品与配置

从理财侧栏进入“选品与配置”`/ledger/products`，默认打开配置分区；`?section=screening` 为初筛、`section=allocation` 为配置、`section=holdings` 为持仓复核。旧 `/ledger/screening` 自动重定向到初筛分区，旧锚点 `#holding-reviews`、`#events` 和 `view=performance` 仍定位到对应内容。

初筛分区默认显示正式候选，可组合搜索、期限、分类、发行方和提示。展开份额详情查看披露日、额度查询时间、原始单位净值与公开数据可行性校验。批次切换和详情链接保留批次 ID，刷新失败时保留最近发布批次并显示证据时效。初筛只刷新公开证据；“刷新配置快照”和“重新评估”各自沿用原数据与动作，试算不会让不合格产品获得资格。

“刷新初筛”走独立公开数据任务。“刷新配置快照”继续读取周产品快照。初筛启用后按北京时间周一至周五 12:00 运行，法定放假日和周末跳过。当天午后启动会补跑，任务中断按当日重试额度接续。

生产首次初始化需明确授权。先运行 `npm run r2:screen:db -- preflight` 核对独立路径、日历和浏览器，再用 `npm run r2:screen:db -- init` 初始化。创建本地开关文件 `data/r2_screening.enabled` 后，使用既有 `prod:restart` 经计划任务启动。也可由运行环境设置 `R2_SCREENING_ENABLED=1`，显式环境变量优先。`R2_SCREENING_DB_PATH` 可指定独立路径。

- `npm run r2:screen -- status` 读取当前状态，`npm run r2:screen -- refresh` 触发手动批次。`--dry-run` 在临时库验证公开采集，`--dry-run --fixture test/fixtures/r2-screening/2026-11-07.json` 离线复算。
- `npm run r2:screen:db -- status` 检查库状态，`verify` 校验完整性和外键，`backup` 在线快照至 `data/screening-backups/`。所有子命令可指定 `--db <绝对路径>`，备份和还原可指定 `--backup-dir <目录>`。
- 恢复前关闭初筛开关并经托管重启以停止初筛 worker。初筛停用时，页面可继续读取历史，账本服务可保持运行。确认初筛库没有活动 WAL/SHM 后运行 `npm run r2:screen:db -- restore --offline --backup <已校验的独立备份>`。命令校验备份，并在替换前保留当前库的保护快照。
- 发布故障先读 `GET /api/r2-screening/status` 和运行记录。日历缺口须补官方日历版本。核心来源失败保留上一批次。需暂停采集时移除开关文件或设置 `R2_SCREENING_ENABLED=0`，再经既有托管重启。

## 8. 决策提案、评估与复盘

入口为 `/ledger/evaluation`，`?section=proposals|decisions|results` 分别定位提案、决策记录和评估结果；结果区可加 `view=evaluations|calibration`。旧 `#proposals`、`#decisions`、`#automation`、`#calibration` 继续兼容。

v9 执行层的提案、采纳和评价共用冻结契约：新决策使用 `r2-screening-v9-execution-v1` 的评价版本，旧决策保留原策略、原预测和原评价依据；旧 2.5%/2.8%/3.0% 期限 hurdle 只用于 legacy 决策样本。

v9 可操作持仓会投影到消息中心：续持不达标待确认退出、锁定持仓到期观察、赎回规则待补、风险复核和证据待补。同一持仓事项按稳定键去重，处理或来源消失后自动删除；`hold`、shadow 和 legacy 不生成待办。

流程：

```text
平台生成有证据的提案 → 用户采纳或拒绝 → 用户在招行 App 执行 → 上传成交截图
→ 平台匹配决策、审计偏差、维护持仓 → 自动评估 → 月/季复盘
```

交易前可行性校验只使用公开配额、起购、递增、期限和持有期，并保留 decision_log 与截图；赎回到账核验以交易记录的 `arrival_date` 为准，`arrival_verified_at` 记录首次写入时间。

提案：

- 可分配资金大于 0 时生成买入提案；持仓达到退出或替换条件时生成 `holding_exit` 或 `holding_switch` 提案；
- 提案去重键包含执行版本、批次/证据指纹、份额身份、金额和交易腿；同一计划逐只采纳时后续只核余额；
- 采纳前重核当前激活策略、证据时效、公开状态、公开可行性（配额/起购/递增/期限/持有期）、资金承诺、集中度和交易腿；采纳只生成待执行决策，不创建交易；
- 拒绝、过期或未执行取消不生成新决策；已有交易关联的决策不能直接删除；部分执行只重算余额并保留已发生事实。部分成交后可在提案区“取消剩余”，只释放未执行余额和未用预留，不撤销已确认交易；重复取消幂等。

评估：

- 按决策冻结的执行/评价版本分发；v9 使用冻结快照中的预期金额、确认日、费用和到账事实，不用公开净值补个人收益；
- 买入日检查决策完整性、期限桶和单只限制；持有期检查组合收益、流动性和产品事件；
- 到期/赎回按实际到账金额、加权持有天数和冻结契约评价；1 个月有效年化低于 2.15% 触发退出/到期退出意图，锁定持仓只形成到期后观察计划；
- 低置信度、金额缺失、证据不足或与手工评价冲突时进入待确认；待验证、未执行和失效结果不计入预测命中率；
- 旧、新策略及不同指标分样本展示，校准按策略/规则版本分组；自动评估可撤销，历史版本保留。

月度五问、季度复盘和 Markdown 导出位于“复盘”页。

## 9. 投资模块

### 9.1 每日市场简报

入口：`/investment/briefs`；指定日期用 `?date=YYYY-MM-DD`。

- 源文件：`market-briefs/YYYY-MM-DD.md`
- 每日市场简报采用结论优先的简洁正文：除第二章外，每章解读尽量1—3句，保留关键数据、后续观察、必要来源与口径限制，不展示计算和取数过程；后台核验要求保持完整。
- 第二章先提炼当日行情主线并检查反证，再按解释力串联开盘、盘中转折或分化与收盘结构。通常写 2–4 条驱动，每条 2–4 句，交代事实、作用机制和判断边界，证据不足可少写。

- 正文 H1 后写 `> 今日标题：…`（不超过 20 字）；页面和浏览器标题使用该标题，日期由页眉展示。
- 固定八章：收盘概览、市场为何这样走？、结构性亮点：当日 1–2 点结论、关键资金信号、政策面信号、估值参考、后续影响与展望、结论；第三章标题直接写出当天最重要的结构结论，“后续影响与展望”分设“短期（1-2 周）”和“中期（1-3 个月）” 结构性亮点必须同时包含“强势板块”和“弱势板块”两个三级小节，各列至少一个相对强势、相对弱势方向，结合涨跌幅、成交或资金证据说明；普涨或普跌时使用相对强弱，数据不足写“未获取到”，不得硬凑或将弱势写成买入机会。 强势板块与弱势板块各用一张 Markdown 表格展示，固定四列为“板块｜涨跌幅｜第三方主力净流入｜净流入率”，表后保留简短解读；注明数据日期、快照时间、来源与分类口径，净流出用负号，缺失字段写“未获取到”，不同分类不得拼成同一行。强势表按东方财富完整行业样本主力净流入金额从高到低取前五，弱势表按净流出金额从大到小取前五，两表各五行；不足五个符合方向的有效样本时只列可核验项并说明缺口，不硬凑。价格与资金背离须说明。 通用模板见 `codex-automations/market-brief-template.md`，执行规则见 `codex-automations/market-daily-brief.md`。运行不读取历史成稿作为范文；先核验本轮事实再形成结构、驱动、阈值与结论。历史数值仅按需提取同口径字段并核对来源后用于比较，不载入旧标题、解释、展望或判断。自动化记忆仅保留执行状态、缺口和稳定规则，不存放市场观点。

重跑指定交易日会重新核验该日证据。简报以分时证据核对预期是否兑现，正文只保留影响判断的变化。候选稿通过发布验证才替换该日简报，失败时保留原稿。
- 估值参考允许读取并分析市场分析师文章、券商研报和可靠财经媒体原文，不要求交易所或指数公司官方披露；注明作者/机构、原文链接、文章发布日期、估值数据截至日和指标口径（如 PE TTM、静态/预测 PE、PB，以及分位区间和方法）。允许统计口径差异，逐项标注并统一提示“统计口径可能存在差异，仅供参考”，不同来源不强行拼接或直接比较。可引用最近可得数据，明确其与简报日期的时差；文章未披露的字段写“未获取到”，不猜测，不把旧数据当成当日估值。区分文章观点与本稿分析，不能只凭搜索摘要填数。
- 第六章可引用百分位网指数详情页的估值和历史分位，第四章可补充站方恐贪指数。用页面或 JSON 的数据日期判断新鲜度，前值标明时差。
- “关键资金信号”展示宽基 ETF 成交额、涨跌停结构、固定行业涨跌与东方财富行业板块资金流；资金流为第三方订单分档估算，必须标注快照时间和统计口径
- 页面只列出实际存在的日期，并默认打开最新一篇
- 所有数字记录日期、截止时间和来源；无法核实写“未获取到”
- 市场状态只是结构摘要，不是仓位或买卖建议

Codex 任务 `a` 每天 18:00 运行。构建和健康检查通过后，只提交当天简报及本次实际更新的接口目录增量，并推送 upstream。同名重跑覆盖同一文件，无变化不建空提交。

已用行情和宏观接口见 `codex-automations/market-brief-api-catalog.md`。运行中发现新的可复用接口时，必须先验证、参数化、去重，再写入目录和任务记忆。

### 9.2 股票调研报告库

入口：`/investment/research`。支持日期、标签和优先级筛选，全文检索、目录、阅读进度、前后篇切换和打印。

研究范围：

- 个股深度；
- 快速扫描；
- 标准主题或产业链报告；
- 公司事件更新。

默认交付静态 HTML 报告，除非用户明确要求“只分析、不要生成文件”。

### 9.3 A 股科技图谱

入口：`/investment/tech-map`，提供脑图、树状和表格三种视图。数据来自 `src/data/techmap.json`，属于产业资料，不进入 R2 账本或选品结论。

## 10. 两个配套 skill

| Skill | 适合什么 |
| --- | --- |
| `r2-wealth-management` | R2/PR2 产品筛选、额度判断、期限桶、买入检查、切换和复盘 |
| `serenity-skill` | 个股、主题、产业链、候选公司对比和公司事件研究 |

直接输入 `$r2-wealth-management` 或 `$serenity-skill` 即可触发。skill 只做研究和复盘，不登录银行、不保存密码、不下单、不赎回、不转账。

R2 决策提示词示例：

```text
$r2-wealth-management
按当前本金、期限桶、持仓、未来现金流和可分配资金，检查 R2 配置；
候选必须写明证据档位、缺失窗口、期限调整参考年化、公开配额可行性（起购/递增）和 10%/20% 限制。
```

股票研究提示词示例：

```text
$serenity-skill
研究 [主题/公司]，先拆产业链和真实瓶颈，再给公司阵型、证据缺口、下一催化、
市场叙事与资金结构、五红灯和退出条件；默认生成 HTML 报告并发布。
```

## 11. 研究交付标准

股票报告固定采用以下内容：

1. 一页结论；
2. 产业事实与瓶颈地图；
3. 公司全景、阵型与证据阶梯；
4. 市场叙事与拥挤度；
5. 催化剂与验证登记；
6. 退出与监控。

个股报告在证据后附五红灯：

| 检查项 | 核验内容 |
| --- | --- |
| 利润与现金流 | 经营现金流是否长期弱于净利润 |
| 应收与存货 | 增速是否明显高于收入，回款和库存是否恶化 |
| 利润质量 | 一次性收益或资本化是否放大利润 |
| 治理与股东行为 | 关联交易、问询、重述、减持、质押、解禁是否异常 |
| 融资与资产负债表 | 债务、流动性、定增、可转债和摊薄压力是否上升 |

每项标记“未见异常 / 需关注 / 红灯”并附事实和来源日期。两项及以上红灯时，降低研究优先级或标注“财务证据不足”。

事实、市场解释和推断分开。每个关键判断带日期来源；商业化阶段、收入和现金流证据按阶段核验。高估值不自动构成退出结论，退出状态由证据变化触发。

## 12. 新增或修改报告

唯一需要手工编辑的是：

```text
report/<报告>.html
```

文件名：

```text
宁德时代-300750-个股深度-YYYY-MM-DD.html
AI-光互连-产业链调研-YYYY-MM-DD.html
AI-光互连-快速扫描-YYYY-MM-DD.html
宁德时代-300750-事件更新-YYYY-MM-DD.html
```

报告需要：

- 非空正文和作用域化 `<style>`；
- 浅色、深色主题均清晰可读；
- 不包含脚本、内联事件或 `javascript:` 链接；
- 标注调研日期、数据截止日、财务报告期、币种和实际方法；
- 正文末尾挂载通用导航：

```html
<!-- ↓ 报告导航（通用组件，自动挂载） -->
<script src="../scripts/report-nav.js" defer></script>
</body>
```

需要覆盖报告库元数据时：

```html
<!-- rpnav-published: YYYY-MM-DD HH:mm -->
<!-- rpnav-title: 自定义卡片标题 -->
<!-- rpnav-tag: 分类 -->
<!-- rpnav-summary: 一句话摘要 -->
<!-- rpnav-keywords: 代码或检索词 -->
<!-- rpnav-priority: 高 -->
<!-- rpnav-priority-detail: 研究优先级及依据 -->
```

发布和验收：

```powershell
npm run research:publish
```

命令重建独立导航、报告清单、Vue 文档、检索索引和媒体，执行构建并重启服务。验收桌面与移动、浅色与深色、正文、表格、图片、搜索、目录和生产健康接口后，按路径提交并推送。

清理本次调研产生的 Markdown 草稿、抓取缓存和临时目录。

## 13. GitHub Pages

```powershell
npm run pages:build
```

产物写入 `run/pages-site/`，严格包含报告库、全部源报告、报告导航、科技图谱三视图和 `.nojekyll`。入口为：

`https://pjimming.github.io/qianduoduo/research/`

Pages 只承载公开研究内容，不包含 R2 数据、账户事实、截图、服务端代码、Vue 构建物或市场简报。

## 14. API 参考

服务默认只监听 `127.0.0.1`。写接口只接受同源请求和 `application/json`。

### 健康与 Dashboard

- `GET /api/health`：健康检查。
- `GET /api/dashboard`：完整 Dashboard 兼容读取。
- `GET /api/dashboard/sections?include=summary,ledger`：按需组合只读分区。
- `GET /api/dashboard/summary|overview|ledger|trades|products|evaluation|inbox`：读取单个分区。
- `POST /api/dashboard/refresh`：刷新决策提案、提醒生命周期和消息中心投影。

### 选品与配置：初筛接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /api/r2-screening/status | 批次、下次刷新、来源与证据时效 |
| GET | /api/r2-screening/runs 和 /runs/:id | 运行历史与尝试 |
| GET | /api/r2-screening/results | 以 run_id 固定批次，筛选与分页 |
| GET | /api/r2-screening/results/:channel/:code 及 /nav | 份额证据、复核清单与原始净值 |
| POST | /api/r2-screening/runs | 带 Idempotency-Key 启动或查看活动批次 |

### 复盘、评估与自动化

- `GET /api/review/workspace`：复盘与评估工作区。
- `GET /api/automation/workspace`：任务、通知、草稿、队列和调度状态。
- `POST /api/automation/run`：运行一次自动化巡检。
- `PUT /api/automation/settings`：修改目标、hurdle、限制、置信度和巡检间隔。
- `POST /api/evaluations/:id/apply|undo`：确认或撤销评估。
- `POST /api/notifications/:id/read|unread|resolve`、`POST /api/notifications/read-all`：处理提醒。
- `POST /api/automation/jobs/:id/resolve`：完成、跳过或标记 Codex 判断任务。
- `GET/POST /api/review/drafts/:type/:period/generate|confirm`：生成或确认月/季复盘草稿。
- `GET /api/review/export?month=YYYY-MM`：导出月度 Markdown。
- `GET /api/calibration/monthly?month=YYYY-MM`：预测校准。
- `GET /api/calibration/predictions/:id`：预测版本与实际结果。
- `POST /api/calibration/predictions/:id/confirm`：确认低置信度预测。

### 决策与交易

- `GET /api/decision-proposals`：提案列表。
- `POST /api/decision-proposals/:id/adopt|reject`：采纳或拒绝提案。
- `GET/POST /api/trades`：读取或新增交易。
- `PUT /api/trades/:id`：修改交易并留痕。
- `POST /api/trades/:id/confirm|cancel`：确认或撤销交易。
- `GET /api/trades/:id/audit`：读取交易审计。
- `GET/POST /api/trades/inbox`：读取或上传成交截图。
- `PUT /api/trades/inbox/:id`：保存人工校正。
- `POST /api/trades/inbox/:id/apply|ignore`：应用或忽略截图。
- `POST /api/trades/inbox/:id/vision-apply`：按视觉字段写入，OCR 校验冲突时返回 409。
- `GET /api/trades/inbox/:id/image`：读取本地截图。
- `POST /api/trades/inbox/prune`：清理历史已处理截图。

### 收益与持仓估值

- `GET/POST /api/income/inbox`：读取或上传收益截图。
- `POST /api/income/inbox/:id/apply|ignore`：归档产品收益或忽略截图。
- `npm run income:entry -- run/income.json [--apply]`：收益截图一键入账；默认 dry-run 做冲突预检和 T+N 覆盖检查，加 `--apply` 才上传并 apply，随后打印当日账户、对账状态和账户汇总。`--template` 打印规格骨架。
- `GET /api/product-valuations?product_code=...`：逐产品收益、覆盖区间和修正审计。
- `POST /api/product-valuations`、`PUT /api/product-valuations/:id`：补录或修正产品收益。
- `GET/POST /api/holding-valuations`：兼容读取派生当前净值；历史快照能力不再由工作台界面使用。
- `POST /api/holding-valuations/evidence`、`GET /api/holding-valuations/evidence/:id/image`：兼容保留历史银行对照截图。

### 决策、事件、本金和产品

- `POST/PUT/DELETE /api/review/decisions`：决策增改删。
- `POST /api/review/decisions/:id/predictions`：追加预测版本。
- `POST/PUT/DELETE /api/review/holdings`：兼容读写买入交易。
- `POST/PUT/DELETE /api/review/events`：产品事件增改删。
- `PUT /api/review/notes/:month`：保存月度五问。
- `PUT /api/review/quarterly/:quarter`：保存季度复盘。
- `POST /api/capital/init`：初始化起始本金。
- `PUT /api/capital/init`：调整起始本金并重算历史。
- `POST /api/capital/events`：记录转入/转出。
- `DELETE /api/capital/events/:id`：删除转入/转出。
- `POST /api/products/refresh`：重新读取本地产品快照。
- `GET /api/products/unopened`：只读加载未开放产品展示快照，不参与决策。
- `PUT /api/holding-reviews/:code`：保存单只产品 T+N、费用和核验状态。

### 记录、备份和消息

- `POST /api/records`：按日期幂等新增收益记录。
- `PUT /api/records/:date`：修改记录。
- `DELETE /api/records/:date`：删除记录。
- `GET /api/export.csv`：导出台账 CSV。
- `GET /api/backups`：列出备份。
- `POST /api/backups`：立即备份。
- `POST /api/inbox/confirmations`：写入需要用户确认的消息中心事项。

## 15. 运行、备份与测试

生产命令：

```powershell
npm run prod:deploy
npm run prod:status
npm run prod:start
npm run prod:restart
npm run prod:stop
npm run prod:install
npm run prod:uninstall
```

生产托管使用当前用户计划任务 `QianDuoDuo-Production`，只包含当前用户登录触发。安装器从 `scripts/production-bootstrap-template.vbs` 生成 ASCII 路径下的隐藏启动器，计划任务通过 `wscript.exe //B` 在无控制台窗口运行一次 PowerShell 并拉起 Supervisor，此后不执行定时健康巡检。计划任务动作、触发器和运行账号不匹配时，`prod:status` 会报告托管定义不匹配，不会仅凭同名任务或快捷方式声称自启已启用。

`prod:stop` 写入 `run/host.stop` 并让隐藏登录任务停止运行时，但保留托管安装；登录任务再次触发时看到停止意图会静默退出。`prod:start` 清除该标记并通过计划任务重新启动。`prod:install`/`prod:uninstall` 管理计划任务本身。Supervisor 存活期间负责 Node 异常退出；本机不额外巡检或自动恢复 Supervisor。

数据库备份：

```powershell
npm run db:list
npm run db:backup
npm run db:restore -- YYYY-MM-DD
```

服务每次启动生成当天备份，默认保留最近 45 份。恢复前自动保留 `pre-restore-*` 副本，服务运行中拒绝恢复。

质量检查：

```powershell
npm run check
npm test
npm run build
npm run test:e2e
node --experimental-test-coverage --test
npm run test:daemon
npm run test:host
npm audit --omit=dev
```

`test:host` 使用临时目录、临时端口和一次性计划任务，覆盖安装/卸载、唯一登录触发、已登录启动、重复启动、Node 崩溃重启、停止隔离、无周期恢复和显式重启，不读写正式账本。

## 16. 定时任务

| ID | 时间 | 职责 |
| --- | --- | --- |
| `a` | 每日 18:00 | 生成 A 股收盘简报；构建、健康检查后提交简报和接口目录增量并推送 |
| `r2` | 每周一 08:30 | 刷新 R2 产品池 |
| `r2-2` | 周一至周五 21:00；法定节假日跳过 | 处理 Codex 队列和 R2 工作日常规巡检；每轮报告，无需用户处理也明确说明 |
| `r2-3` | 每周五 18:30 | 检查结构、流动性、替换和到期 |
| `r2-4` | 每周一 08:45 | 追加固定 cohort 样本外观察 |

完整配置、提示词和跨机器复现见 [codex-automations/README.md](codex-automations/README.md)。

自动化可以维护事实，但不得代替用户采纳/拒绝提案、创建交易、下单或修改正式权重。

## 17. 故障排查

| 现象 | 处理 |
| --- | --- |
| 页面打不开 | 运行 `npm run prod:status`；先看“Hosting / Independent / Intent / Last start”，再按需 `npm run prod:install` 或 `npm run prod:start` |
| API 不通 | 检查 `http://127.0.0.1:8765/api/health` 和 `logs/server-*.err.log` |
| 截图识别不确定 | 在截图收件箱人工校正，保留原图 |
| 收益缺口未关闭 | 检查产品代码、收益日期、覆盖日期和披露 T+N |
| 报告构建失败 | 修正 `report/*.html` 后重新运行 `npm run research:publish` |
| 产品快照未更新 | 运行 `npm run r2:refresh-all`，再刷新应用 |
| 测试污染正式数据 | 立即停止，检查测试是否使用临时 SQLite 和受控目录 |

## 18. 目录

```text
data/                  SQLite、备份、产品 CSV 和观察数据
lib/                   SQLite store 与共享业务模块
market-briefs/         每日市场简报 Markdown
public/research/       科技图谱静态源和构建媒体
report/                股票报告唯一可编辑源
research/              独立报告归档页
scripts/               构建、发布、守护和迁移脚本
server/                HTTP、业务域和基础设施
src/                   Vue 前端、数据和样式
test/                  后端、前端契约和端到端测试
```

## 19. 边界与免责声明

- 本项目是本地个人工具，不是持牌投顾，不构成投资建议。
- R2/PR2 不等于保本，历史年化不代表未来收益。
- 股票研究基于公开信息，研究优先级不是买卖信号或收益预测。
- 服务只供本机使用，应保持监听 `127.0.0.1`。
- 所有最终银行操作和交易决定由用户本人完成。

## 2026-11-08 策略执行入口

<!-- r2-strategy-acceptance-2026-11-08 -->
v9 统一执行层巡检：通过原有运行日闸门后读取 GET /api/r2-strategy/status 与 GET /api/r2-strategy/workspace。mode=v9 时以该工作区的 allocation、monitoring、公开可行性校验（配额/起购/递增/期限/持有期）及 stale 为当前策略依据，旧 dashboard.holding_reviews 和 CSV 仅作 legacy 历史观察。stale=true、结果缺失或接口不可用时标注待重算/待核，不退回旧算法生成当前建议，不调用策略重算、初筛刷新或自动采纳。低于有效同份额近1月年化2.15%时区分立即可退出与锁定到期退出意图；售罄、未入前三不构成强制退出。证据待核、预留/在途资金和约束冲突按当前状态解释，已有消息只引用不重复创建。入口为 /ledger/products?section=allocation、/ledger/products?section=holdings 和 /ledger/evaluation?section=proposals。历史决策按冻结版本评价，周快照与样本外观察仍沿用原独立规则，不切换生产模式。交易前只做公开数据可行性校验并保留 decision_log 与截图；到账核验只读取交易记录的 arrival_date 字段。

### v9 流动性配置

当前建议以 GET /api/r2-strategy/workspace 为准。使用 contract.bucket_caps_pct 读取中期、长期上限，使用 result.allocation.bucket_limits 读取实际策略占用和超限，字段缺失标记待更新。现金需求以 cash_needs 的付款日为准，旧区间末日标注估算。过期、契约不匹配、缺结果或接口异常时标注待核。当前配置与持仓动作仅使用 v9 工作区，CSV 与样本外结果标明各自的证据和冻结版本。r2-2、r2-3 原运行日闸门和财务事实巡检继续适用。
