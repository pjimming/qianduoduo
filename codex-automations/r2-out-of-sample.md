# 钱多多R2样本外观察

| 配置 | 值 |
| --- | --- |
| ID（本机） | `r2-4` |
| 名称 | 钱多多R2样本外观察 |
| 时间 | 每周一 08:45（Asia/Shanghai） |
| RRULE | `RRULE:FREQ=WEEKLY;BYHOUR=8;BYMINUTE=45;BYDAY=MO` |
| 模型 | `gpt-6-luna` |
| Reasoning | `high` |
| 执行环境 | `local` |
| 工作目录 | `<WORKSPACE>` |
| 状态 | `PAUSED` |

## 当前状态

旧策略样本外观察已按用户要求停用：`r2-4` 为 `PAUSED`，周快照不再自动采集 TD-YIELD-002 样本或触发参数复核；日常/周五巡检不创建或重开单窗口高分、667828A 排名及4/8样本里程碑提醒。历史规格、cohort、台账和报告保留，仅在用户明确恢复后重新启用。当前 v9 策略、收益对账、公开初筛与产品快照更新继续运行。

来源：旧 `r2` 周快照内置采样与 `r2-4` 独立复核均可通过 `/api/inbox/confirmations` 创建提醒。两条自动路径现已停止。

## 提示词

```text
此任务已按用户要求暂停。
旧策略样本外观察已停用：不自动运行 yield:observe、yield:observe:review 或参数复核，不为 TD-YIELD-002、单窗口高分、667828A 排名或4/8样本里程碑创建或重开消息；历史资料保留，仅在用户明确恢复后重新启用。当前 v9 与账本巡检继续执行。
```

## 历史资料

- 冻结规格与 cohort：`data/yield-observations/`。
- 已有参数复核：`docs/analysis/td-yield-002-out-of-sample-parameter-review-2026-11-23.md`。
- 本次停用不改变冻结研究版本；手工研究命令仍保留，自动任务不得调用。
