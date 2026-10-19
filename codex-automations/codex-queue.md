# 钱多多自动化队列巡检

| 配置 | 值 |
| --- | --- |
| ID（本机） | `automation` |
| 名称 | 钱多多自动化队列巡检 |
| 时间 | 每天 21:10（Asia/Shanghai） |
| RRULE | `RRULE:FREQ=DAILY;BYHOUR=21;BYMINUTE=10;BYSECOND=0` |
| 模型 | `deepseek-v4-pro` |
| Reasoning | `high` |
| 执行环境 | `local` |
| 工作目录 | `<WORKSPACE>` |
| 状态 | `ACTIVE` |

## 用途

处理应用写入 SQLite 的 Codex 判断队列，包括截图歧义、评估复核、月度草稿和季度草稿。它是“应用自动化”和“Codex 判断”之间的桥。

## 提示词

```text
检查钱多多本地财富工作台的待判断队列，地址是 http://127.0.0.1:8765。先读取 GET /api/automation/workspace；如果本地服务无法连接，保持安静并直接结束，任务会保留在 SQLite，下次服务启动后继续。如果 jobs 为空，也不做任何事，不要发通知。

只处理 Codex 判断队列里的任务：
1. screenshot_review：读取对应收件箱条目的 OCR 原文和已解析字段。若产品代码、金额、日期、状态能从原文明确确认，可用 PUT /api/trades/inbox/:id 保存校正，再 POST /api/automation/jobs/:id/resolve 标记 done。存在歧义时保留 pending，并在最终回复中指出需要人工确认的字段。
2. evaluation_review：读取评估证据。若证据完整、结论明确，可用 POST /api/evaluations/:id/apply 写入；证据不足、与手工评价冲突或金额不匹配时保留 pending，不要强行覆盖。
3. monthly_summary / quarterly_summary：检查对应草稿是否已生成；只做复核和备注，不要替用户确认复盘结论。可把任务标记为 done 并说明草稿已就绪。

严格边界：不删除或撤销任何交易流水，不替用户下单，不登录银行，不修改 R2 账本收益记录，不把股票调研内容写入 R2。所有写操作前先读取当前状态，失败时保留任务 pending。只有在存在需要用户处理的事项、评估已自动写入，或任务处理失败时才发通知；队列为空、服务不可用或状态未变化时保持安静。
```

## 边界

- 队列为空时保持安静；
- 服务不可用时保持安静，任务留在 SQLite；
- 不删除交易、不覆盖手工评价、不替用户确认复盘结论。
