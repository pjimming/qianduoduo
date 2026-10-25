# R2 分析证据目录

本目录保存收益策略研究、影子计算和参数审核的可复查证据。Markdown 提供结论和异常说明，同 basename 的 JSON/CSV 保存机器结果或逐项数据。

## 阅读与维护

- 顶层 `td-yield-001-shadow-2026-10-22.*` 是阶段 2 初始候选方案生成物。
- `stage5/td-yield-001-shadow-2026-10-22.*` 是阶段 5 最终方案快照，不是顶层的重复文件。
- `td-yield-001-backtest-2026-10-25.*` 保存回测与异常归因结果。
- `td-yield-001-parameter-decision-2026-10-25.*` 保存参数决策和敏感性结果。
- 两组 shadow 的生成时间、统计值和输出路径不同，均被历史任务规格引用，不得按同名文件互相覆盖。
- 冻结结果不要手工编辑。需要重跑时使用 `yield:shadow`、`yield:backtest` 或 `yield:parameter-review` 的 `--out-dir`，把新实验写入独立目录。

任务规格、交接和发布验收位于 `docs/tasks/`；本目录只保留分析方法和结果证据。脚本默认输出仍为 `docs/analysis/`，修改该约定时必须同步更新脚本、任务说明和入口文档。
