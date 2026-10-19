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

脚本会调用招行理财产品统一查询平台公开接口，按 R2、开放中、代销、公募/不限条件分页拉取全量产品，生成 data/cmb_r2_all-YYYY-MM-DD.csv（全量原始）、data/cmb_r2_universe-YYYY-MM-DD.csv（普通可买候选池：人民币、公募、R2/PR2、开放中、非私行/私银/私享/尊享/企享/专属/私募、成立满 12 个月、期限可解析且 1M/3M/6M/1Y 完整）和 data/cmb_r2_selected-YYYY-MM-DD.csv（研究观察池，不含资金分配），并调用本地 /api/products/refresh 让应用立即使用新候选池。实际买什么、买多少由应用按本金、持仓、待确认买入、流动性和额度动态计算。

运行后检查 http://127.0.0.1:8765/api/dashboard 的 meta.product_csv、products.all.length、products.watchlist.length，确认候选池和精选池已生效。

输出简短报告：最新数据日期、全量/候选/精选数量、期限桶分布、1Y/3M 明显变化、精选产品代码、哪些产品未获取到或已过期。

若脚本失败，保留旧快照并报告错误，改为提醒我从招行 App 手动补录；不要伪造数据。不要登录招行账户、不要抓取实时额度、不要替我下单；额度、赎回到账和实际可买状态仍需我在 App 当日核验。
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
- 一条简短的数据更新报告，不包含买入建议

## 失败处理

- 保留旧快照，不删除旧 CSV；
- 报告错误原因和缺失的数据；
- 提醒用户到招行 App 手动核对；
- 不伪造产品数量、收益率或额度。
