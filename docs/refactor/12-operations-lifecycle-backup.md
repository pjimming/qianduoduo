# 阶段 8：任务调度、重试、关闭、备份恢复与日志

## 1. 集中调度与诊断

`server/jobs/automation-scheduler.js` 现在集中提供：

- startup/manual/interval 触发。
- `start()` 幂等，重复调用不会创建第二个定时器。
- 单任务防并发。
- 失败自动重试，默认最多 3 次。
- 指数退避，默认从 1 秒开始。
- 停止时取消启动定时器、轮询定时器和待执行重试。
- 最近执行状态：
  - trigger
  - attempts
  - running
  - startedAt/finishedAt
  - durationMs
  - lastResult
  - lastError
  - timedOut

说明：当前 `runCycle()` 是同步函数，`taskTimeoutMs` 是执行后时长诊断阈值，不是强制中断。真正硬超时需要把 cycle 移入 worker/子进程，本阶段未改变现有执行模型。

## 2. 中断任务恢复

`automation-store` 新增 `recoverInterruptedRuns()`。

服务启动时：

1. 打开数据库。
2. 将所有遗留 `automation_runs.status = 'running'` 标记为 `failed`。
3. 写入 finished_at 和“服务进程中断”错误。
4. 再启动 scheduler。

这样服务重启后不会永久显示“任务仍在运行”。

## 3. OCR 子进程关闭

Windows OCR adapter 维护活动子进程集合：

- 正常结束、启动失败或超时都会从集合移除。
- 服务关闭时调用 `terminateOcrProcesses()`。
- 该操作幂等，避免遗留 OCR 子进程。

## 4. 优雅关闭

`server/lifecycle.js` 的关闭顺序：

1. 停止 scheduler 和重试定时器。
2. 终止 OCR 子进程。
3. 关闭 HTTP Server。
4. 清理 stop marker。
5. 关闭 SQLite repository。
6. 移除 SIGINT/SIGTERM handler。

新增可选的 `R2_STOP_FILE` 机制。

Windows 守护脚本 `scripts/daemon.ps1`：

- `prod:stop` 先创建 `run/server.stop`。
- 等待 Node 服务优雅退出，最多约 10 秒。
- 超时才强制终止。
- 最后清理 `server.stop`、PID 和 daemon.stop。

该流程已通过临时生命周期测试，生产任务本身未重启。

## 5. 一致备份与恢复

新增：

```text
server/infrastructure/backup/sqlite-backup.js
```

能力：

- `createConsistentSnapshot()`：使用 `VACUUM INTO` 生成包含 WAL 已提交事务的一致快照。
- `validateDatabase()`：
  - 文件存在且非空。
  - `PRAGMA quick_check = ok`。
  - 关键表存在。
- `restoreDatabase()`：
  1. 验证目标备份。
  2. 对当前数据库生成一致的 pre-restore 快照。
  3. 验证安全快照。
  4. 复制目标备份到同目录临时文件。
  5. 验证临时文件。
  6. 用临时文件覆盖主库。
  7. 删除旧 `-wal/-shm`。
  8. 无论成功失败清理临时文件。

`scripts/db.mjs backup/restore` 均已改用该模块。

关键改进：

- 恢复前安全快照不再只复制主库文件。
- 损坏或不完整备份会在覆盖前拒绝。
- 当前数据库不会因无效备份被替换。

## 6. 日志脱敏

新增：

```text
server/infrastructure/logging/logger.js
```

安全 logger 会在输出前脱敏：

- Bearer token。
- password/passwd。
- token/secret/API key。

lifecycle 和 scheduler 使用 safe logger，不直接记录请求体、截图内容或凭据。

## 7. 验证

新增/扩展测试：

- scheduler 幂等启动。
- scheduler 失败重试并记录最终状态。
- stop 取消待执行重试。
- 启动恢复 interrupted automation run。
- OCR 关闭钩子幂等。
- WAL 安全快照包含恢复前最新记录。
- 有效备份恢复后使用备份内容。
- pre-restore 安全快照保留当前最新数据。
- 损坏备份在覆盖前失败，当前库保持不变。
- logger token/password 脱敏。
- stop marker 触发优雅关闭。

全量测试：

```text
tests 192
pass  192
fail  0
```

覆盖率：

```text
line   88.48%
branch 73.18%
funcs  87.60%
```

`npm run check` 通过。
`npm run build` 通过，仅保留既有大 chunk 警告。

## 8. 已知风险

1. Windows 没有 POSIX SIGTERM；优雅关闭依赖 Node 停止文件轮询，守护脚本等待超时后仍会强杀。
2. `runCycle()` 同步执行，timeout 字段只能诊断超时，不能中断已经阻塞的同步函数。
3. restore CLI 通过健康检查判断服务是否运行；异常的外部 SQLite writer 仍需人工确保停止。
4. 自动任务失败后的业务状态仍依赖现有幂等键收敛，没有引入持久化队列。
5. 日志脱敏覆盖常见凭据格式，不替代“不要主动记录敏感数据”的代码审查。

## 9. 回滚

1. 恢复 scheduler、lifecycle、OCR adapter 和 daemon 脚本。
2. 恢复 `scripts/db.mjs` 的安全快照逻辑。
3. 删除 backup/logging infrastructure 和阶段 8 测试。
4. 重跑阶段 7 的 184 测试基线。
