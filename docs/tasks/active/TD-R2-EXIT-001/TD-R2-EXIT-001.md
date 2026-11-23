# TD-R2-EXIT-001：三项联合退出决策

用户授权日期：2026-11-23。范围为v9存量持仓退出规则、提案用例、证据/API展示与本机R2自动任务；不改变新买/加仓的近1月2.15%门槛。

## 当前规则

全部同时满足才形成退出意图：①近7个自然日含分红总收益率严格低于0.04123288%；②最新有效同份额近1月年化严格低于2.15%；③同一披露日同份额近6月年化>近3月年化>近1月年化。相等不触发；6/3/1月是三个回溯窗口，不是三个完整自然月。

7日沿用累计净值差除以期初单位净值的未舍入总收益率。估值规则、日历、区间端点、应有披露或累计净值缺失/冲突/过期时待核；不把缺失当0，不使用已舍入年化反推。窗口值须和同份额同日期的官方披露证据逐项一致。

## 实施

- 新增纯函数exit-conditions，三项各自返回met/not_met/pending，合取为最终状态。仅部分条件满足不触发。
- monitoring、engine退出意图、holding-actions及API快照共用同一结果。锁定份额保留到期退出意图，窗口未知保留待核。
- v9派生提交和退出草案生成共用事务；已可赎且三项满足时自动生成待采纳赎回提案，不自动采纳，不写银行交易。shadow/preview只观察。切换候选仍需经济性、费用、空档、额度及组合校验。
- 同输入重放幂等；证据更新生成新草案并使同组旧草案失效；条件恢复时旧未采纳草案失效；已采纳决策保留且不重复发起；草案写入失败时派生提交整体回滚并可重试。
- holding_review_version升级到r2-v9-holding-review-v2，计算版本10。原v9/1和v9/2冻结契约保留历史校验；新采纳使用当前契约。SQLite schema不变，账户事实不迁移。
- 持仓页新增三项条件明细；沿用现有12px及以上字体、桌面浅/深主题，1280px无根横向溢出。
- 同步AGENTS/MEMORY/README/USAGE、当前策略文档、四项R2任务源文档及本机r2、r2-2、r2-3、r2-4提示词。自动任务仅引用平台结果，不代用户采纳；市场简报仍独立。

## 发布及恢复

发布前停止现有托管并做一致性SQLite备份，记录schema和本金、交易、决策、日收益、日账、银行累计事实指纹；先在临时副本演练契约升级，再用现有r2:strategy:mode受控升级v9契约和激活序号，经计划任务重启，核验来源、Health、工作区、日志和停止标记。

回滚时停止托管、恢复本任务源代码和构建，使用策略repository受控transition回到原契约并新增审计序号（previousContractHash传入升级后的哈希、expectedSeq使用当前序号），使旧派生和未采纳草案失效后重启。保留升级后新增财务事实；不直接用旧整库备份覆盖新事实。备份仅用于受控灾难恢复。已采纳历史决策继续按原冻结契约评价。

## 验收与生产结果

- check通过；npm test 641/641；node --experimental-test-coverage --test 645/645，新exit-conditions行/分支/函数覆盖均100%；构建与完整npm run test:e2e通过。自动提案更新/失效/已采纳去重修正后重新跑过最终检查。
- 副本升级通过，8类核心财务表逐行指纹未变；生产备份为data/backups/r2_ledger-exit-triple-precutover-2026-11-23.sqlite。
- 2026-11-23 12:55经现有QianDuoDuo-Production计划任务发布，v9激活序号2→3；新契约31bf22a1db21a05cd1b4921fddcae152416b6fff454dc35df340d0e3c3ce4d6b，原契约95b4ace76283849ec29f3588e9c9ef48fc9a276010fe6bd7006d5940f28e82fd。
- 生产job#68 done，stale=false、contract_matches=true；13个持仓批次（11个产品）均返回三项检查字段。
- 120056A、17356D、17318K三项满足，均为exit_at_open；最早重新核验窗口分别为2027-01-18、2027-01-19、2027-04-19。未生成当前可执行退出草案。
- PY040225截至2026-11-20近1月年化2.78%，6月及7日证据待核，月度条件明确不满足，因此合取not_met、状态hold；未触发退出。
- 生产schema及8类核心财务事实与备份指纹一致；SQLite quick_check=ok、外键问题0。prod:status确认唯一登录触发托管、隐藏启动和独立Supervisor，Health正常，最新stderr为空，无run/host.stop残留。
- 生产1280px浅/深主题：新增证据能展开，最小信息字号12px，根横向溢出0。截图在run/acceptance-ui/exit-production-1280-light.png及dark.png；完整E2E另检查文字对比度>=4.5:1。
- 实际r2、r2-2、r2-3、r2-4提示词通过Codex自动化工具更新并回读一致，原时刻、状态、模型、推理档位、项目与运行环境保持原值。私有验证日志在run/exit-*.log与run/exit-production-verification.json。
- 自动审批拒绝临时演练库清理（只返回blocked by policy），故保留run/exit-contract-rehearsal.sqlite，不影响生产。
- 不涉及依赖、数据库schema、股票报告或GitHub Pages；未提交或推送工作区改动。
