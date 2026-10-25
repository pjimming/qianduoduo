# 钱多多文档地图

> 本文件只说明文档类型、权威顺序和维护规则。对时效性状态、当前优先级和完成情况，以 `TODO.md`、代码、数据库、Git 和运行接口为准。

## 权威顺序

1. `AGENTS.md`：工作区硬性约定和交付边界。
2. `README.md`、`USAGE.md`、`SETUP.md`：项目入口、使用方法和环境初始化。
3. `TODO.md`：待办、优先级和完成状态的总入口。
4. `docs/tasks/active/`：当前任务规格、交接和验证资料。
5. `docs/architecture/`：仍需长期维护的架构、数据库和数据可信度契约。
6. `docs/analysis/`：可复查的分析输入、结果和对应 JSON/CSV 证据。
7. `docs/archive/`：带日期标记的历史快照，不作为当前实现或运行状态依据。

## 目录约定

| 目录 | 内容 |
| --- | --- |
| `docs/tasks/active/` | 仍在执行的任务规格、交接和观察方法 |
| `docs/tasks/archive/` | 已完成任务及其历史交接、发布验收 |
| `docs/architecture/` | 当前架构边界、数据库不变量、迁移与回滚设计 |
| `docs/analysis/` | 收益策略影子计算、回测、参数审核和证据文件 |
| `docs/archive/refactor-2026-10/` | 后端模块化重构的阶段审计、进度和验收快照 |

`codex-automations/` 保持独立，因为它承载可执行的定时任务提示词；`public/research/techmap/README.md` 保持在其数据目录旁，不并入通用文档区。

## 维护规则

- 活动任务只通过 `TODO.md` 建立和追踪，规格文件放在 `docs/tasks/active/<TASK_ID>/`。
- 任务完成后移动整个任务目录到 `docs/tasks/archive/<年份>/<TASK_ID>/`，并清理 `TODO.md` 中的活动入口。
- 历史文档不复制当前运行状态。需要判断当前事实时，回到代码、`TODO.md`、数据库或运行接口。
- 已跟踪文件使用 `git mv` 调整位置；移动后同步更新 Markdown 链接、脚本默认路径和入口文档。
- `docs/analysis/` 中同一 basename 的 Markdown、JSON 和 CSV 属于一组证据，不单独删除或改写。
- `docs/analysis/` 可能包含产品代码和名称。分享仓库前按 `SETUP.md` 的隐私检查执行，不得把个人数据当作示例发布。
