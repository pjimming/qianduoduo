# TD-YIELD-001 阶段 6 生产发布与验收

## 发布基线

- 旧版本源码提交：`01456dc3ea47fb2a79813695035894f26c568fe0`
- 旧版本回退标签：`rollback-td-yield-001-20261025`
- 发布提交：`1e30bafc9d82a399fc42fbe1da48776a5c94e11f`
- 发布候选标签：`td-yield-001-release-20261025`
- 今日数据库备份：`data/backups/r2_ledger-2026-10-25.sqlite`
- 备份 SHA-256：`B90F05BC74E4A35E6F3D1E9E217BF05A6F1EBD4670720F9CBFE0C37D9FE5FA52`

## 重启前

- Health：`OK`
- 生产旧口径：`r2-dynamic-v3`
- 产品数：689
- 旧口径可评分：604
- 持仓复核：6 条
- 提案：待采纳 0、已采纳 0、已执行 3
- 最新 stderr：0 bytes
- `run/server.stop`：不存在

## 重启

执行：

```text
npm run prod:restart
```

结果：

- Supervisor 正常启动。
- Server 正常运行。
- Health 返回 `OK`。
- 自动启动保持启用。

## 生产验收

| 检查项 | 结果 |
| --- | --- |
| 选择版本 | `r2-dynamic-v4` |
| 前视扣分方案 | `B` |
| 产品数 | 689 |
| 可进入评分 | 587 |
| 参考年化可用 | 626 |
| 参考年化不可用 | 63 |
| `weighted_yield_pct` 与参考年化不一致 | 0 |
| cash 评分/排名泄漏 | 0 |
| 产品参考状态/原因缺失 | 0 |
| 持仓复核 | 6 |
| 持仓收益策略版本 | `r2-term-yield-v1` |
| 持仓当前/候选状态字段缺失 | 0 |
| 收益归因产品证据 | 6 |
| 收益归因参考覆盖 | 100% |
| 收益归因状态 | `insufficient`（当前账本样本仍少） |
| 待采纳提案 | 0 |
| 已采纳提案 | 0 |
| 已执行提案 | 3 |
| 最新 stderr | 0 bytes |
| `run/server.stop` | 不存在 |

关键 API 均返回 200：Health、Dashboard products、Dashboard overview、Dashboard evaluation。

## 回退方法

如果生产异常：

1. 执行 `npm run prod:stop`。
2. 将源码恢复至 `rollback-td-yield-001-20261025`。
3. 重新构建并启动。
4. 验证旧版本 Health、`r2-dynamic-v3` 产品接口、stderr 和 stop marker。
5. 只有数据库发生损坏或非预期迁移影响时才恢复今日备份；恢复前另建 safety snapshot。

本次没有 schema 迁移。发布验收通过，当前生产运行最终参数版本。
