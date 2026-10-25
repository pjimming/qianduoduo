# 子 Agent 任务上下文与运行防护协议

本协议用于避免子 Agent 丢失任务、无限运行、指数级递归或把未完成工作伪装成完成。主 Agent 和所有项目级子 Agent 都必须遵守；`.codex/config.toml` 的 hooks 与 `scripts/agent-guard.mjs` 负责运行时拦截。

## 主 Agent 派发

1. 为每次派发生成唯一 `TASK_ID`，格式建议为 `<DOMAIN>-<TOPIC>-<YYYYMMDD>-<序号>`。
2. 使用 `npm run agent:brief:init -- --task-id <TASK_ID> --agent-type <AGENT_TYPE> --path run/agent-briefs/<TASK_ID>.md` 生成任务简报。`run/` 已被忽略，不得提交任务简报。
3. 填写简报后执行 `npm run agent:brief -- run/agent-briefs/<TASK_ID>.md`；校验通过会建立仅 2 分钟有效的运行 reservation。同一 Agent 类型同时只允许一个待派发 reservation；已有其他待派发任务时先派发或执行 `npm run agent:reservation:cancel -- <TASK_ID>`。校验失败或 reservation 过期时不得派发，必须重新校验。
4. 校验后立即直接调用一次 `spawn_agent`。需要当前会话、用户要求或既有研究上下文时，显式传入 `fork_turns="all"`；本工作区禁止使用 `fork_turns="none"`。
5. 不得通过批量工具包装器创建需要上下文的任务。多个子 Agent 应逐个直接创建，再等待其并行完成。
6. 提示词只写一行入口：读取 `AGENTS.md`、本协议和指定简报，完成该 `TASK_ID`，不要依赖入口提示复述全部需求。
7. 只接受首行带正确 `CONTEXT_OK <TASK_ID>` 且目标一致的答复。缺失、错 ID、执行了其他任务或要求重新提供已知目标时，立即停止该 Agent，修正简报后以新的 `TASK_ID` 重新派发。
8. `followup_task` 只用于已正确接单 Agent 的收口或已批准的新阶段，不用于修复上下文失败，也不得用来延长原预算。
9. 汇总结果后删除对应的 `run/agent-briefs/<TASK_ID>.md`。

## 运行时硬上限

| Agent 类型 | 任务类别 | 墙钟上限 | 工具调用预算 | 40% 检查点 | 70% 检查点 | 80% 收口 |
| --- | --- | ---: | ---: | --- | --- | --- |
| `workspace_explorer` / `explorer` | 探索 | 10 分钟 | 30 | 第 12 次 | 第 21 次 | 第 24 次 |
| `default` / `worker` | 实现 | 30 分钟 | 80 | 第 32 次 | 第 56 次 | 第 64 次 |
| `backend_integrity_worker` | 实现 | 30 分钟 | 80 | 第 32 次 | 第 56 次 | 第 64 次 |
| `ui_quality_worker` | 实现 | 30 分钟 | 80 | 第 32 次 | 第 56 次 | 第 64 次 |
| `delivery_reviewer` | 审查 | 20 分钟 | 50 | 第 20 次 | 第 35 次 | 第 40 次 |
| `stock_research_analyst` | 综合研究 | 45 分钟 | 120 | 第 48 次 | 第 84 次 | 第 96 次 |

- 运行截止取“简报绝对硬截止”和“启动时间 + 角色墙钟预算”两者中更早者。没有有效期的已校验 reservation 时，`SubagentStart` 标记 `briefVerified=false`，`PreToolUse` 拒绝全部工具。
- 时间或工具调用任一达到 40%/70% 时只写入检查点状态，不在工具调用与 tool output 之间注入任何模型可见消息；主 Agent 通过 `npm run agent:status` 读取阶段。达到 80% 后冻结全部工具，Agent 只能用已有结果完成输出。
- 工具调用超过预算或达到硬截止时间后，`PreToolUse` hook 冻结全部工具调用，Agent 只能输出收口答复。
- 子 Agent 调用 `spawn_agent` 会直接被 `PreToolUse` hook 拒绝。确需继续拆分时，由主 Agent 建立新 `TASK_ID` 并单独派发；不得通过 `followup_task` 延长同一运行。
- `PreToolUse` hook 发生解析、状态读取或执行异常时必须 fail-closed；任何错误都不能放行工具。
- hooks 是运行时护栏，不替代主 Agent 监控；托管 WebSearch 等少数工具无法被本地 hooks 完整覆盖，因此仍须执行有界等待和到点中断。

## 任务简报模板

```markdown
# <TASK_ID>

<!-- agent-guard
{
  "task_id": "<TASK_ID>",
  "agent_type": "<AGENT_TYPE>",
  "task_kind": "<exploration|implementation|review|research>",
  "hard_deadline": "<带时区的 ISO 8601 时间>",
  "wall_clock_minutes": 10,
  "tool_call_budget": 30,
  "checkpoint_1_pct": 40,
  "checkpoint_2_pct": 70,
  "closeout_pct": 80,
  "recursion_allowed": false
}
-->

- 目标：
- 用户原始要求：
- 研究/执行截止：
- 当前工作目录：
- 必须读取：
- 可读范围：
- 可写范围：
- 禁止事项：
- 交付格式：
- 验证命令或证据：
- 完成条件：
- 阻塞时返回：
```

简报必须足以独立判断任务边界；不要把关键信息只放在创建 Agent 的临时消息里。示例数值必须替换为该 `agent_type` 在上表中的真实预算。

## 主 Agent 有界等待

1. 每次 `spawn_agent` 后 30 秒内运行 `npm run agent:status -- --json --require-task <TASK_ID>`，确认出现同一 `taskId`、同一 `agentType` 且 `briefVerified=true`。命令非零退出或未出现时立即 `interrupt_agent`，判定当前会话未加载 hooks，重启 Codex 后以新 `TASK_ID` 重试。
2. 记录每个 Agent 的启动时间、硬截止时间和工具预算。
3. 使用 `wait_agent` 做 5–10 分钟有界等待，超时后调用 `list_agents` 和 `npm run agent:status` 检查实际状态；不得无限等待最终答案。
4. 未到截止且仍有有效进展时，继续下一轮 5–10 分钟有界等待；任务已阻塞、越界、重复失败或到达硬截止时，立即调用 `interrupt_agent`。
5. `wait_agent` 超时只表示“本轮没等到更新”，不得据此判定 Agent 已停止。检查点由主 Agent 通过 `agent:status` 观察，不在 `PreToolUse` 中向子 Agent 注入消息。
6. 每个 Agent 完成、中断收口结束或确认异常终止后运行 `npm run agent:cleanup`，清理未经 `SubagentStop` 留下的孤立调用目录和过期 reservation。

## 中断后的收口

1. `interrupt_agent` 后先检查已有输出；合格答复必须首行使用准确 `CONTEXT_OK <TASK_ID>`，逐字写出“目标复述：<简报目标>”，并包含“已完成 / 未完成 / 可恢复状态 / 剩余风险”四项。
2. 若中断后没有合格答复，只允许发送一次收口 `followup_task`：禁止调用工具，只整理已有结果，并在 5 分钟内返回四项状态。
3. 这次收口答复仍有界等待最多 5 分钟；仍未返回或格式不合格时再次中断并记为失败，不再追问。
4. 需要继续原文工作时，主 Agent 必须建立新 `TASK_ID`、新简报和新预算；旧 Agent 的剩余时间与工具调用不得结转。

## 子 Agent 接单与收口

1. 先读取 `AGENTS.md`、本协议和主 Agent 指定的任务简报。
2. 开工前发送一条简短进展，首句为 `CONTEXT_OK <TASK_ID>：<一句话目标>`。
3. 最终答复首行再次写准确的 `CONTEXT_OK <TASK_ID>`，随后逐字复制简报目标并固定写出：

```text
目标复述：<逐字复制简报“目标”字段>
已完成：
未完成：
可恢复状态：
剩余风险：
```

4. 简报不存在、`TASK_ID` 不一致、目标冲突或无法读取必需上下文时，只返回 `CONTEXT_MISSING <TASK_ID>：<具体缺失项>`，不得猜测或改做其他任务。
5. 模型第一次漏掉四项收口时，`SubagentStop` hook 只允许一次格式重试；第二次仍不合格即结束，不再形成追问循环。

## 写入与冲突

- 只写简报授权的路径；多个 Agent 不得同时写同一文件、生成物、数据库或共享状态。
- 股票报告只可写各自唯一 `report/*.html`；应用内副本、清单、导航、构建和发布由主 Agent 统一处理。
- 后端事务、数据库 schema、生产重启等高风险操作必须使用独占任务，并按串行顺序执行。
