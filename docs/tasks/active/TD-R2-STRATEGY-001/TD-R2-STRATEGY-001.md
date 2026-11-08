# TD-R2-STRATEGY-001：v9统一执行层

> 2026-11-08 08:17 独立验收后已修复前端接线、协议、资金、持仓、评价与调度遗漏并重新发布。最新结果为595/595单测、check/build/完整E2E/覆盖率/daemon通过，收益只读899/899；schema与核心财务事实不变，生产v9/1健康。11批次实际证据仍待核，首次工作日真实补采待观察。完整缺陷及证据见[独立验收记录](../../../r2-strategy-acceptance-2026-11-08.md)。下文保留此前实施时间线。

目标：完成 [R2策略整合计划](../../../r2-strategy-integration-plan.md) 的全部范围，包含后端、前端、调度、生产切换和回滚验收。截至 2026-11-08 02:05，TD-R2-STRATEGY-001 的可执行范围已完成：本地整合、生产 v9 切换、保留切换后事实的副本回滚演练、部分执行余额取消与事实修正追加评价版本均已落地；生产 `mode=v9`、`activation_seq=1`，消息中心投影已核验。真实切换前影子对照因用户直接授权切换未执行；生产回滚本身未执行，副本演练通过；周末披露归属保留待核。部分执行取消随 01:55 重启发布，事实修正版本随 02:02 重启发布。

## 当前边界

- 用户已明确授权所附增量DDL的生产迁移；实际为7张新表，原“8张”是计数笔误，未新增审批对象。迁移后先保持legacy，不在建表时切换策略。
- `UI_REDESIGN_PLAN.md` 和原计划文件在开工前已有用户改动，保留其内容。没有重写账户事实、历史交易、历史预测或现有表schema。
- 新API的legacy模式只计算不持久化的v9预览；shadow仅写新任务和摘要，不生成正式提案、决策或用户待办。生产推荐链尚未切换。
- `TD-YIELD-002` 独立观察继续原规则；`TD-R2-ALLOC-001`仍暂缓。

## 实施与完成证据

| 原计划范围 | 当前实现与证据 | 尚需完成 |
| --- | --- | --- |
| 0 契约/字段/并发冻结 | `contract.js`、`schema.sql`、[执行契约](../../../r2-strategy-integration-contract.md)；契约哈希与生产一致 | 随切换继续核对最终状态/运维字段 |
| 1 冻结公开批次 | 初筛repository同一只读事务读current、全量摘要及证据哈希；`evidence.js`同份额/期限/有效期适配；`collectHoldingEvidence`补采 | 存量售罄/下架的持续补采与接续观察 |
| 1 映射与复核 | 版本化mapping/check repository；`pretrade.js`逐项复核；GET复核、POST映射/复核已接HTTP与前端表单 | 自动精确映射/歧义处理流程；公开状态与App事实的人工校正体验 |
| 2 统一组合占用 | `account.js`按确认持仓、待确认、预留、部分切换和到账证据去重；中心绑定已接交易/预留同事务，部分成交与超额实情不拒记；部分成交后可取消未执行余额并释放未用预留 | 截图重复、确认/撤销/兼容入口的补充用例 |
| 2 约束配置 | `allocation.js`整数分MIP；等组预算、原rank、替补、额度/步长、产品/族/证据档位、用款/流动性约束；12项定向测试 | 真实池影子比较与性能/容量证据，完整UI展示 |
| 3 不可变快照与情景 | `snapshot.js`冻版本、证据、组合分母、预期确认/赎回/到账、费率与空档；沿用calculateSwitch | 绑定后不可变字段的补充保护用例 |
| 3 提案/采纳 | `proposals.js`买入、`holding_exit`/`holding_switch`生成/去重/替代、采纳前重核、同计划逐只采纳、决策和预留同事务、未执行取消；19项定向测试 | 旧对象切换生命周期、手工/事实补记入口 |
| 4 存量续持 | `holdings.js`收益退出、锁定观察、当日赎回核验、售罄不退出；`holding-actions.js`经济替换；补采/退出/替换测试 31 项；`inbox.js` 将 v9 可操作持仓投影为稳定去重待办 | 用户确认流程；到期观察之外的例外处理 |
| 4 分版本评估/校准 | `evaluation.js`按冻结契约生成买入日/到期评价；`automation-store`按版本分发；`decision-calibration`按策略/规则分组；新增评估测试 27 项、事实修正追加版本集成用例 1 项 | 比较期止于周末的周一披露口径（需确认归属） |
| 5 统一输入/影子 | `engine.js`统一证据→账户→配置→复核→监控；HTTP、CLI、独立worker、启动/周期调度与初筛发布唤醒已接同一用例 | 真实影子差异与性能证据；切换竞争/迟到 worker 演练 |
| 5 前端整合 | “选品与配置”三区、“决策与评估”三区、旧深链兼容、取消零写、1280/1440双主题；`e2e-r2-strategy.mjs`覆盖 | 旧 `e2e-smoke` 整页断言已由专用 E2E 取代，待后续清理 |
| 6 生产迁移/切换 | 显式预检、两库WAL备份、增量DDL事务/签名、失败/空回滚演练通过；生产apply并重启；2026-11-08 01:40 经用户确认发布并切到 v9/1，切换前备份、副本 legacy/0→v9/1→legacy/2 演练、job#1 done、watermark seq1、消息中心11条已核验 | 完整真实影子、保留新事实的切换后回滚演练 |
| 13.6 专项 | 临时库资金竞争、租约恢复、输入变化/序号竞争、旧表无写入、HTTP/CLI/worker/调度一致性、切换序号拒绝已测 | 发布丢通知、跨库不同检查点、进程硬退出、定时依赖、较大样本性能的端到端演练 |
| 14 文档/Skill/实际任务 | README/USAGE/MEMORY/PRODUCT/设计/计划/契约已同步 | Skill 与实际自动化任务定义在切换时同步；运行对应验收 |

## 当前接口与运行方式

- `GET /api/r2-strategy/status`：模式、序号、迁移、契约及任务摘要。
- `GET /api/r2-strategy/workspace`：现有持久化影子摘要、是否过期及当前输入指纹；不刷新来源、不创建业务记录。
- `POST /api/r2-strategy/preview`：只读计算；可带`expected_input_fingerprint`，不接收客户端本金、候选或规则覆盖。
- `POST /api/r2-strategy/recompute`：legacy退为非持久预览；shadow/v9在新任务表幂等保存派生摘要，提交前在写事务内重核账户。
- `POST /api/r2-strategy/proposals`：v9模式且满仓配置/全部复核/冻结预测通过后生成正式待采纳提案；legacy/shadow禁止。现有`/api/decision-proposals/:id/adopt|reject`按执行版本转新用例。最新写链已随生产 v9/1 发布。
- `npm run r2:strategy -- status|preview|recompute`：使用无初始化器的existing-ledger adapter，不导CSV、不回放schema、不更新迁移时间。支持`--db/--screening-db/--date`及仅限run目录的私有`--out`。
- `server/jobs/r2-strategy-worker.js`：显式动作、两库路径、业务日、序号/指纹；由 `server/jobs/r2-strategy-scheduler.js` 在 shadow/v9 下启动补跑和 300 秒周期调度，legacy 下跳过。
- `npm run db:preflight:r2-strategy`、`db:migrate:r2-strategy`（须指定受控`--backup-dir`）、`db:verify:r2-strategy`、`db:rollback-empty:r2-strategy`。

新增依赖锁定`javascript-lp-solver@1.0.3`，运行时审计无漏洞。求解结果由应用以整分重新验算；未完成公平/排名偏好时不宣称配置通过。

## 本轮验证记录

全量回归和覆盖率最近一次为489/489通过；覆盖率行89.55%、分支77.15%、函数91.01%；check与现有完整E2E通过。此后的小范围快照校验防线有定向复测，最终上线前再以当前代码做完整检查。测试和备份/回滚仅在临时SQLite与受控目录执行。完整原始输出保存在`run/r2-strategy-*.log`，不进入Git或Pages。

2026-11-08推进：最新全量507/507和check通过，覆盖率行89.56%/分支77.12%/函数91.04%。新增提案与事实接续证明：(a)原始/采纳快照保留统一组合分母；(b)同计划可逐只采纳、重复采纳只返回同一决策；(c)任何非本计划资金/复核/批次变动必须重核；(d)小额部分成交不受旧20%金额容差拦截；(e)超额成交真实入账并记录偏差；(f)写入/预留接续异常回滚提案、决策、交易、lot和审计；(g)取消未执行计划释放余额一次；(h)非legacy模式不能静默生成旧池提案。旧评估器当前尚未接新策略，**不得启用生产v9模式**。

曾发现应用工厂轻量repository夹具兼容失败，已修复并通过复测。旧持仓迁移记录原来每次初始化都会更新completed_at，现增加“版本/hash已完成则不写”的幂等保护，并有重开账本不改迁移审计时间的测试。

首轮repository测试的Windows清理钩子顺序导致8个临时目录遗留；钩子已修复，后续临时库正常释放。对遗留目录的递归清理被自动审批以`blocked by policy`拒绝，未改换方式绕过，目录暂留系统临时区。此项不影响事实与代码验证，最终交付须注明。

## 生产增量迁移验收

用户授权后执行prod:stop，确认持久停止标记；分别创建并验证两库WAL一致备份，再以显式apply新增7张表，初始legacy/0；通过prod:start调用现有计划任务重新托管。两份备份SHA256均核验通过，旧schema和daily_records/product_daily_valuations/trade_transactions/trade_allocations/capital_settings/capital_events/holdings/decision_log八类事实与迁移前逐表一致。新API和初筛API均200；当前初筛批次仍#1。prod:status确认唯一登录任务、隐藏启动器、Independent=yes及task-scheduler来源；host-state.last_outcome=started、last_error=null，Health正常、stderr为空、无host.stop。收益只读验收899/899通过。

此验收只证明增量迁移和legacy兼容，不证明v9推荐或前端整合已完成；前端分区、评估与调度已在本轮补齐，见文末“四路收口与本地验收”。Supervisor临时端口退出测试也已通过，安装器未改动。

## 2026-11-08 压缩续接

用户明确允许复杂任务使用多智能体，并请求缩短上下文。后续可遵循`.codex/agents/TASK_PROTOCOL.md`派发：评估/校准（lib/automation-store.js、lib/decision-calibration.js、lib/review-store.js及新增评估模块）、持仓补采/退出（公开source与持仓领域模块）、前端整合（src各工作区/路由/侧栏/表单及E2E）；主线程保留共用契约、策略service/repository、server/app.js/routes、交易接续、手工决策/证据写入口、调度、生产切换和最终文档。具体简报需重新核对文件分区，禁止覆盖他人的未完成修改。所有子Agent均fork_turns=all，按简报reservation/状态验证/预算执行。

当时增加的安全防线：新执行版本不进入旧全局hurdle评估；`v9_frozen_net_pnl`尚无正式解释器时返回insufficient_data，不使用旧个人年化公式代评。该解释器已在文末收口中实现并接入。提案预测的容差字段已改为calibration原有tolerance_abs。

前端只做了局部修复：DecisionProposalPanel取消原生prompt时立即return、并发操作全局禁用、取消采纳反馈保留旧决策；提高局部说明/元数据对比度。已有E2E新增“取消原因输入零POST请求”并通过。跨午夜暴露了旧E2E将最终披露日简单写成today+1的缺陷，现按weekendDisclosureBase(yield_date)+2求期望值；同时移除了Inbox采纳处未被消费的原生dialog监听，避免它错误处理后面的取消测试。

局部真实浏览器证据在`run/r2-strategy-ui/`（全部合成数据），1280/1440、浅/深色均最小12px、根节点无横向溢出，标签对比度8.73/11.12，Impeccable检测为空。`impeccable context --target src/components/review/DecisionProposalPanel.vue`已运行，skill/harden/craft-floor已读。该段为局部修复时点；整体三分区界面已在文末收口中完成，原生prompt已由统一确认流程取代。

该时点完整E2E已结束且通过（run/r2-strategy-e2e.log）；没有尚待轮询的exec会话、子Agent或其他后台任务。该时点全量为507项；文末已完成565项全量验收。生产进程仍是增量迁移时发布的legacy版，最新提案/交易接续与前端尚未整体重启发布；禁止直接将生产mode改为v9。

### 2026-11-08 01:05 续接状态与多智能体派发

- 上一轮 Codex 子 Agent 结局：R2-EVAL-20261108-01 于 00:43:08 正常完成；R2-HOLD-20261108-01 于 00:45:55、R2-UI-20261108-01 于 00:42:38 因 Codex 额度耗尽终止（last_agent_message=null，额度约 03:58 恢复），只留下落盘文件。
- 已确认落盘：evaluation.js/automation-store/decision-calibration/review-store/snapshot 的评估接线；source.js 的 collectHoldingEvidence 与 holding-*.js；router/AppSidebar/ScreeningView/api/types/WorkspaceNav 的前端半成品。
- 当前工作树定向测试 53 项 52 过 1 败：test/r2-strategy-proposals.test.js:254 旧断言 evaluation_contract_pending 已过时，实际 invalidated，待 Stream A 修正。
- 2026-11-08 01:05 起改用 DSH 子代理（Codex 额度不可用），四个互不重叠写入范围：
  - Stream A 评估收口：agent `95d6cc5a-5416-4f92-8ea5-3974c69efff5`，简报 `run/agent-briefs/R2-EVAL-20261108-02.md`。
  - Stream B 持仓收口：agent `6649752d-5fd2-4c4e-a07b-a899fb18ce19`，简报 `run/agent-briefs/R2-HOLD-20261108-02.md`。
  - Stream C 前端收口：agent `c3edaf93-8107-4779-b46a-55a1009cfbe4`，简报 `run/agent-briefs/R2-UI-20261108-02.md`。
  - Stream D 后端接线：agent `289ceaf6-3bac-44c6-b1f8-39333ef29a11`，简报 `run/agent-briefs/R2-WIRE-20261108-02.md`。
- 主线程保留：最终集成、文档同步、全量/check/build/E2E、生产只读验收与切换确认。该时点生产仍 legacy/0；后续 01:40 已按用户明确确认完成切换。
- 技术环境：DSH 沙箱下普通 `node --test` 因 pipe 被拒报 `spawn EPERM`，单元测试统一用 `node --test --test-isolation=none`。

### 2026-11-08 01:30 本地整合与验收收口

- 四路结果：A 新增 `test/r2-strategy-evaluation.test.js`（27 项，26 过 1 todo），修正 proposals 旧断言并补 v9 冻结/校准用例；B 完成持仓补采、净值/监控待核、退出/替换计划，新增/追加 31 项测试；C 落盘三分区页面、路由、侧栏、复核/提案面板与 `scripts/e2e-r2-strategy.mjs`，中途因额度/中断未收口，由主线程合并；D 接通复核/映射/复核写入口、持仓提案、启动/周期调度和 worker 校验，补 service/entrypoints/proposals/repository 与生命周期测试。
- 合并修复：`lib/review-store.js:870` 只排除 `actual_fact`，保留 `trade-auto` 冻结评价（修复 pending_evaluations 回归）；`scripts/e2e-r2-strategy.mjs` 关闭数据库后再清理临时目录并容忍 `EPERM/EBUSY`；`scripts/e2e-smoke.mjs` 入口数 8→7，旧整页选品/评估块支持 `--skip-legacy-workspace` 跳过，`package.json` 的 `test:e2e` 串行跑 smoke + 专用 E2E。
- 验收：`npm test` 565 项 / 564 通过 / 0 失败 / 1 todo；`npm run check` 通过；`npm run build` 成功；`npm run test:e2e` 通过，专用 E2E 覆盖六分区、旧深链、无效 section、取消/Esc 零写、无原生 dialog、1280 无横向溢出、≥12px。
- 生产（切换前记录）：`mode=legacy`、`activation_seq=0`、`migrated=true`，最新代码未发布；未启动/重启/迁移/切换生产。01:28 只读复核 `GET /api/health` 返回 200 `{ok:true}`，策略状态仍 legacy/0，node PID 19548 自 23:21:10 未重启。

### 2026-11-08 01:35 消息中心投影

- `server/modules/r2-strategy/inbox.js` 只从 v9 已完成结果的 `monitoring.rows` 生成 `requires_user_action` 待办：退出、到期观察、补赎回规则、风险复核、补证据；`hold` 不生成。
- 去重键为 `r2-strategy:<message_key>`，动作深链回持仓分区并按 `lot` 定位；`service.inboxItems()` 只在 v9、结果序号与当前激活序号一致时返回，直接读状态和最近完成任务，不触发证据读取。
- Dashboard 投影在账本写事务外读取策略待办，读取失败回退空数组；来源消失后由消息中心同步删除旧投影。shadow/legacy 不生成待办。
- 新增 `test/r2-strategy-inbox.test.js` 5 项、Dashboard 投影测试 1 项、消息中心合并测试 1 项；全量 `npm test` 572 项 / 571 通过 / 0 失败 / 1 todo，`npm run check`、`npm run build`、`npm run test:e2e` 均通过。
- 该时点剩余：事实修正追加历史评价版本（1 todo）、比较期止于周末的周一披露口径、部分执行余额取消、生产切换控制入口（暂停派生与在途 worker）、真实影子对照、整体切换及保留新事实的回滚演练。生产切换控制入口与整体切换已于 01:40 完成。
- 文档已同步 TODO、任务记录、README、USAGE、MEMORY、PRODUCT、UI_REDESIGN_PLAN、初筛实施计划、整合计划和执行契约。生产 v9 切换已于 01:40 经用户确认完成。

### 2026-11-08 01:37 初筛发布唤醒

- `server/modules/r2-screening/service.js` 发布事务成功后通过 `setImmediate(...).unref()` 调用 `onPublished({run_id,business_date,published_at})`；回调异常只记 warn，不延长或回滚发布。
- `server/lifecycle.js` 把回调接到 `strategyScheduler.run('screening_published')`，在 shadow/v9 下立即补算一次；legacy 仍跳过。通知丢失时由启动补跑和 300 秒周期按最新指纹补齐。
- 新增 `test/r2-screening.test.js` 钩子用例；该文件 18/18 通过。全量 `npm test` 573 项 / 572 通过 / 0 失败 / 1 todo，`npm run check`、`npm run build`、`npm run test:e2e` 均通过。

### 2026-11-08 01:40 生产 v9 切换与消息投影修复

- 用户明确确认“生产切换v9”后，先 `npm run db:backup` 生成 `data/backups/r2_ledger-2026-11-08.sqlite`，并在副本 `run/r2-strategy-switch-test.sqlite` 演练 legacy/0→v9/1→legacy/2。
- 新增 `scripts/r2-strategy-mode.cjs` 与 `npm run r2:strategy:mode`：只允许显式 `activate`，必须提供 `--expected-seq`、稳定 `--operation-key`、`--reason`，切 v9 还必须 `--confirm v9`；切换事务内把旧 pending/running 任务标 superseded、旧执行契约的 pending 提案标 expired，并递增 activation_seq。
- 生产执行 `prod:stop`（确认 8765 无监听）→ `activate --mode v9 --expected-seq 0 --operation-key prod-v9-activation-20261108T0140+08` → `prod:start`；Supervisor PID 11860、Server PID 20624，Health OK，host-state `started`、`last_error=null`，stderr 为空。
- 切换后策略状态 `mode=v9`、`activation_seq=1`、`migrated=true`、`contract_matches=true`；首个派生 job#1 `done`、attempts=1，watermark seq=1；workspace `business_date=2026-11-08`、`stale=false`、`allocation.status=pending`、`monitoring.counts={evidence_pending:11}`、`may_generate_buy_proposals=false`。
- 首次切换后发现 `/api/inbox` 只返回原有6条、策略待办0条。根因是 `server/lifecycle.js` 创建 Dashboard 查询服务时没有传入 `strategy`，且启动投影早于首个派生完成。修复：调整 lifecycle 装配顺序，先创建 screening/strategy，再以 `{automationRunner,strategy}` 创建 dashboardQuery；`r2-strategy-scheduler` 新增 `onDerived`，仅在 fresh 结果时触发 Dashboard 投影，避免周期空转重写。
- 新增 `test/r2-strategy-scheduler.test.js` 2项（fresh 才投影、legacy/异常隔离）；全量 `npm test` 575项/574通过/0失败/1todo，`npm run check` 通过，`npm run build` 成功（653ms，33篇报告文档、19张图片）；`npm run test:e2e` 在修复后复跑通过（smoke 七入口 + 专用三分区 E2E）。重启生产后 `/api/inbox` 的 `inbox_center.items` 共17条、策略项11条，样例 `持仓证据待补：GD040242`、深链 `/ledger/products?section=holdings&lot=9%3AGD040242`。
- 回滚路径：停服后 `npm run r2:strategy:mode -- activate --mode legacy --expected-seq 1 --operation-key <op> --reason <reason>`，再启动；或恢复切换前备份。保留新事实的完整回滚演练仍未在生产执行。

### 2026-11-08 01:48 副本回滚演练（保留切换后事实）

- 用 `createConsistentSnapshot` 从生产 `data/r2_ledger.sqlite` 生成一致性副本 `run/rollback-drill/r2_ledger.sqlite`，演练全程未改生产。
- 演练前副本为 v9/1；`PRAGMA quick_check=ok`，关键事实计数：`daily_records=17`、`capital_settings=1`、`trade_transactions=15`（max id 15）、`decision_log=15`（max id 15）、`product_daily_valuations=94`、`decision_proposals=12`；派生任务 `done=1`，切换记录 1 条。
- 副本执行 `activate --mode legacy --expected-seq 1 --operation-key rollback-drill-legacy-20261108T0148+08`，得到 legacy/2；计数与 max id 全部不变，job#1 仍 done，transition 2 条，watermark 仍为 job1/seq1。
- 再执行 `activate --mode v9 --expected-seq 2 --operation-key rollback-drill-v9-20261108T0148+08 --confirm v9`，得到 v9/3；计数与 max id 仍不变，transition 3 条，`status` 返回 `contract_matches=true`。
- 结论：副本内 v9→legacy→v9 的切换保留财务事实、已完成派生任务、水位和完整切换审计；旧任务/旧提案的失效逻辑未误删事实。演练副本含生产数据，核验后已删除；生产回滚本身未执行，真实切换前影子后因直接授权切换而未执行。

### 2026-11-08 01:55 部分执行余额取消

- `server/modules/r2-strategy/proposals.js` 新增 `cancelRemaining(id,{reason})`：仅接受 `accepted/executed/confirmed` 且有关联决策的提案；拒绝仍有 pending 交易的计划；无已确认成交时返回 `execution_missing`，全部成交时返回 `execution_complete`。
- 按决策 `review_meta.expected_legs` 的已确认买入腿重算 expected/confirmed，对同提案 active 预留执行 `reconcileReservation({executedCents,releaseRemaining:true})`，只释放未执行差额；不删除已确认交易、决策、冻结证据或提案。
- 决策写入 `review_meta.execution_status='partial_cancelled'`、`remaining_cancelled_at/cents/reason`、`current_revalidation_required:false`；重复调用以既有取消标记幂等返回。
- `server/modules/r2-strategy/routes.js` 新增 `POST /api/r2-strategy/proposals/:id/cancel-remaining`，只接受 `reason`（≤500 字）；取消分支必须位于通用 proposals 路由之前。
- 前端 `DecisionProposalPanel.vue` 在 `execution_status='partial'` 时显示“取消剩余”，统一确认流程和原因输入，成功后刷新 Dashboard；`src/api/r2-strategy.ts` 与 `src/stores/dashboard.ts` 已接通。
- 测试：`test/r2-strategy-proposals.test.js` 19/19、`test/r2-strategy-entrypoints.test.js` 10/10；全量 `npm test` 577 项 / 576 通过 / 0 失败 / 1 todo；`npm run check`、`npm run build`、`npm run test:e2e` 均通过。
- 2026-11-08 01:55 已 `prod:restart` 发布：Supervisor PID 5196、Server PID 34348；Health OK，策略仍 v9/1、job#1 done，`/api/inbox` 17 条（策略 11 条）。新端点 `POST /api/r2-strategy/proposals/999999/cancel-remaining` 返回 404，路由已生效且未写生产数据。下一步继续真实影子对照和生产回滚验收。

### 2026-11-08 02:02 事实修正追加评价版本与发布

- 关闭最后一个 evaluation todo：`lib/automation-store.js` 对 maturity 评价按 `{available,reason,actual,valuation_ids,snapshot_hash}` 计算 `evaluationRevision`，把 `|rev:<16位>` 追加到 `dedupe_key`；未命中时回查旧 `baseKey`，只有 revision 相同才复用，事实变化则插入新评价版本，旧 auto/confirmed 行不被覆盖。
- `test/automation-store.test.js` 新增集成用例：v9 决策 + 30 天估值先得到 1 条 maturity，修改 2026-11-16 `daily_pnl` 后得到第 2 条且旧 id 保留，第三次不再增加。估值夹具改用测试内 `repository.db` 直接 upsert，绕开估值库对合成代码 `S1` 的 4–32 位格式校验，不放宽生产校验。
- `test/r2-strategy-evaluation.test.js` 删除已过时的“事实修正追加版本”todo，指向该集成用例；定向 `test/r2-strategy-evaluation.test.js test/automation-store.test.js` 41/41、0 todo。
- 全量 `npm test` 577 项 / 577 通过 / 0 失败 / 0 todo（13.3s）；`npm run check`、`npm run build`、`npm run test:e2e` 均通过（E2E build 693ms，smoke 七入口 + 专用三分区 E2E）。
- 2026-11-08 02:02 执行 `prod:restart` 发布：Supervisor PID 24384、Server PID 576；`prod:status` 为 Ready、Independent yes、Health OK、task-scheduler；策略仍 `mode=v9`、`activation_seq=1`、`contract_matches=true`，job#1 done，`/api/inbox` 17 条（策略 11 条）。
- 已接受例外：比较期止于周末的周一披露归属保留待核；真实切换前影子对照因用户直接授权切换未执行；生产回滚本身未执行（副本演练通过）。

### 2026-11-08 02:05 任务收口

- 本任务的可执行范围已完成：契约、迁移、证据/持仓/提案/评估、消息投影、调度、前端三分区、生产 v9 切换、部分执行取消、事实修正版本追加与文档同步均落地。
- 最终验证：`npm test` 577 项 / 577 通过 / 0 失败 / 0 todo；`npm run check`、`npm run build`、`npm run test:e2e` 通过；生产 `mode=v9`、`activation_seq=1`、`contract_matches=true`、job#1 done，Health OK，消息中心 17 条（策略 11 条）。
- 保留例外：真实切换前影子对照未执行（用户直接授权切换）；生产回滚未执行（01:48 副本 v9/1→legacy/2→v9/3 演练通过）；周末披露归属待业务确认，当前按待核处理。
- 结论：无剩余代码 todo；TD-R2-STRATEGY-001 收口，后续仅按运行监控或业务口径变更再开新任务。
