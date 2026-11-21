# TD-INCOME-PRECISION-001：四位日收益与银行累计对账

状态：2026-11-20 已部署本机生产，完成财务核验、真实界面与最终文案E2E复核。

## 授权与范围

用户明确要求先处理当前收益差异，再改为四位记录。已先说明增量schema、一致性备份、受控回填、兼容分字段与保留新事实的回滚方式，执行范围包含生产迁移和原计划任务重启。现行契约见[收益精度与银行累计对账](../../../累计收益精度改造计划-2026-11-10.md)。

## 已交付

- 产品日收益使用万分之一元整数并保留来源2/4位；日账存原始产品合计，累计和分析使用原始值，最后舍入。保留分兼容值、旧累计、来源精度覆盖及修正审计。
- 银行持仓累计独立按产品/截至日/原图/完整交易范围保存，版本修正和旧请求重放不会回滚新值。不将累计差额伪装成某日日收益，不进入策略资金。
- 当前范围有效时持仓估值采用银行累计；后续原始日收益仅在范围未变、覆盖完整、合并收益未跨基准日时续算，并显示来源。原始银行快照不改写；不满足续算条件时显示待核或历史并回退账本。
- 四位输入、截图补正、明细、审计和冲突提示贯通；浅深主题保留日期、银行值、同期账本、差额和精度状态。概览明确区分持仓银行累计与账本累计。
- 独立审查发现的同分四位通知、负半分、回填同分原始冲突及cash_balance交叉迁移问题已修复并补回归。

## 当前事实处理

已登记用户三张原始银行持仓图，11只当前产品分别按截图标注的11月18日或19日建立累计基准；多批次产品关联完整截至日交易范围。截图各自截止日不同，不能把银行累计合计当成单日收益。

逐图确认38条四位明细，按ID/产品/收益日/原值/原精度状态/更新时间/原图SHA清单受控恢复；每条保留旧事实和修正审计。160条非目标日收益逐字段不变。其余历史精度未知明确标记，不自动从notes或parsed批量推断。来源标注预估的明细保留原证据性质；份额/成本舍入等残差仍分别展示。

## 迁移与恢复证据

- 主备份：data/backups/r2_ledger-pre-income-precision-2026-11-20T14-42-31-627Z.sqlite。
- 银行基准登记后、日明细恢复前备份：data/backups/r2_ledger-pre-precision-backfill-2026-11-20T14-42-31-627Z.sqlite。
- 生产迁移脚本：scripts/migrate-income-precision.mjs、scripts/migrate-product-holding-income.mjs；受控回填：scripts/restore-income-precision.mjs。
- 私有清单及验证：run/income-precision-backfill-20261120.json、run/bank-holding-income-20261120.json、run/precision-production-plan.json、run/precision-production-verification.json。
- 副本演练完成重复迁移、同清单第二次changed=0、完整性及非目标事实指纹核验。正式迁移后quick_check=ok，产品/日账原始整数不变量0处失败，本金、交易、分配、决策指纹均不变。
- 回滚优先回退兼容新增字段的代码并保留新增事实；如必须整库恢复，先停写、保存故障时库并识别/重放备份后的合法事实，禁止直接覆盖新交易。原图和审计须一同保留。

## 验收

- npm run check、npm test（628/628）、npm run build、完整npm run test:e2e通过；node --experimental-test-coverage --test为632/632通过。
- 桌面1280浅深主题真实生产页面验收通过，无根节点横向溢出和pageerror；四位日收益、银行累计、同期账本和差额均已核对。受控样本另覆盖0.0000来源精度、超四位拦截和补正；样本写请求全部拦截，未写真实账本。
- 测试与日志：run/precision-tests-final.log、run/precision-coverage-final.log、run/precision-e2e-final.log、run/precision-check-final.log、run/precision-build-final.log。
- 真实UI证据：run/precision-ui/verification-production.json及production-*.png。
- 原计划任务恢复后定义有效、唯一登录触发、Independent=true、来源task-scheduler，Health和关键API正常，host-state started/last_error=null，stderr为空，无host.stop。

## 边界

四位记录降低后续日舍入损失，但不能恢复未提供的历史小数，也不能保证日收益累计与银行以份额/净值/成本计算的持仓收益逐分一致。银行基准与日收益事实独立保留，缺口及历史残差不被造平。当前部署在本机；Git交付状态以当前提交和远端分支为准。
