# R2产品快照每周更新

| 配置 | 值 |
| --- | --- |
| ID（本机） | `r2` |
| 名称 | R2产品快照每周更新 |
| 时间 | 每周一 08:30（Asia/Shanghai） |
| RRULE | `RRULE:FREQ=WEEKLY;BYHOUR=8;BYMINUTE=30;BYDAY=MO` |
| 模型 | `deepseek-flash` |
| Reasoning | `high` |
| 执行环境 | `local` |
| 工作目录 | `<WORKSPACE>` |
| 状态 | `ACTIVE` |
| auto_archive | `true` |

## 用途

每周刷新招行 R2 公开产品池，生成全量、普通可买候选和精选 CSV，并让本地应用立即使用新快照。它是数据维护任务，不是选品建议，也不查实时额度。

## 提示词（新环境模板）

把 `<WORKSPACE>`、`<NODE_EXE>`、`<NODE_PATH>` 替换为本机实际值。如果自动化 shell 能找到 `npm`，优先使用 `npm run r2:refresh-all`。

```text
每周一 08:30 自动更新钱多多工作台的 R2 全量产品池。先在工作区 <WORKSPACE> 运行 `npm run r2:refresh-all`。

如果自动化 shell 找不到 npm，使用本机 Node.js 24+ 的绝对路径执行：
<NODE_EXE> <WORKSPACE>\scripts\fetch-cmb-r2-all.cjs

脚本会调用招行理财产品统一查询平台公开接口，按 R2、开放中、代销、公募/不限条件分页拉取全量产品，生成 data/cmb_r2_all-YYYY-MM-DD.csv（全量原始）、data/cmb_r2_universe-YYYY-MM-DD.csv（普通可买研究池：人民币、公募、R2/PR2、开放中、非私行/私银/私享/尊享/企享/专属/私募、期限可解析，并分为完整 1Y、缺 1Y 的 6M 档、仅 3M、仅 1M 新品观察和无有效收益五档）和 data/cmb_r2_selected-YYYY-MM-DD.csv（研究观察池，不含资金分配），并调用本地 /api/products/refresh 让应用立即使用新研究池。6M 档和仅 3M 档可参与自动评分，单只最多 10%、同类合计最多 20%；仅 1M 的新品只进入观察，不自动分配。实际买什么、买多少由应用按本金、持仓、待确认买入、短期桶下限和额度动态计算。本项目新增日开目标固定为 0%，target3 固定为短期 30% / 中期 35% / 长期 35%；现有日开持仓只保留为迁移事实。

运行后检查 http://127.0.0.1:8765/api/dashboard/products 的 `meta.product_csv`、`products.all.length`、`products.stats.observation_ready`、`products.stats.evidence_counts`、`products.stats.universe_median_3m/6m/1y`、`products.allocation.allocation_policy.evidence_caps` 和 `products.watchlist.length`，确认五档研究池、10%/20% 上限与观察池已生效。

成功且数据正常时保持安静，不发例行周报。只有抓取/刷新失败、空快照、数据日期倒退、数量或 3M/6M/1Y 中位数显著跳变、五档证据数量或可评分数发生重要变化时，才输出一张短卡，写明日期、数量、变化和是否需要用户在招行 App 核对。

若脚本失败，保留旧快照并报告错误，不要伪造数据。不要写买入建议、不给固定“每桶 3 只”配置；不要登录招行账户、不要抓取实时额度、不要替我下单；额度、赎回到账和实际可买状态仍需我在 App 当日核验。
```

## 本机当前命令

当前机器的自动化提示词使用 Codex 运行时的 Node 路径，避免自动化 shell 的 PATH 找不到 Node：

```powershell
$env:NODE_PATH='C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
& 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' 'D:\codex\钱多多财富工作台\scripts\fetch-cmb-r2-all.cjs'
```

如果在普通 PowerShell 里运行，通常直接执行即可：

```powershell
npm run r2:refresh-all
```

## 预期输出

- `data/cmb_r2_all-YYYY-MM-DD.csv`
- `data/cmb_r2_universe-YYYY-MM-DD.csv`
- `data/cmb_r2_selected-YYYY-MM-DD.csv`
- `/api/dashboard` 的 `meta.product_csv` 指向最新候选池
- 正常时无消息；异常时才有一条简短更新卡，不含买入建议

## 失败处理

- 保留旧快照，不删除旧 CSV；
- 报告错误原因和缺失的数据；
- 提醒用户到招行 App 手动核对；
- 不伪造产品数量、收益率或额度。
