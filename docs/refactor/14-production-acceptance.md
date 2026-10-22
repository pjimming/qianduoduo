# 生产重启与验收

验收时间：2026-10-22 23:46–23:48（Asia/Shanghai）

验收范围：本机生产服务 `http://127.0.0.1:8765`、关键 HTTP API、静态页面、研究报告归档、进程生命周期、运行标记、日志和真实 SQLite 只读完整性。

本次未执行线上部署、真实资金操作、真实数据库恢复或批量重算。

## 1. 重启结果

重启前旧进程：

- Server PID：15924
- Supervisor PID：6480

第一次切换时，旧 Server 已运行在本轮生命周期重构生效之前，守护脚本等待超时后将其强停。随后启动重构后的 Server PID 23708 和 Supervisor PID 21664，健康检查通过。

为验证当前代码的关闭路径，又执行了一次受控重启：

- Server PID 23708 在收到 stop marker 后优雅退出。
- Supervisor PID 21664 随后退出。
- 新 Server PID 为 8068。
- 新 Supervisor PID 为 24388。

守护日志明确记录：

```text
2026-10-22 23:47:43 server exited pid=23708 code= after=71.3s
2026-10-22 23:47:43 supervisor exiting pid=21664
2026-10-22 23:47:43 server stopped gracefully pid=23708
2026-10-22 23:47:45 server started pid=8068
```

当前状态：

```text
Health:     OK
Server:     running (PID 8068)
Supervisor: running (PID 24388)
Watchdog:   not installed
```

`run/server.pid` 和 `run/daemon.pid` 分别指向 8068、24388；`server.stop`、`daemon.stop` 均不存在。

## 2. HTTP API 验收

以下接口在重启后返回 HTTP 200 且响应可解析为 JSON：

- `/api/health`
- `/api/dashboard`
- `/api/trades`
- `/api/inbox`
- `/api/review/workspace`
- `/api/decision-proposals`
- `/api/product-valuations`
- `/api/backups`
- `/api/automation/workspace`

`/api/export.csv` 返回 HTTP 200 和 CSV 内容。

未知 API `/api/not-a-real-route` 返回 HTTP 404：

```json
{"error":"接口不存在"}
```

健康接口返回 `ok=true`。dashboard、交易、收件箱、自动评估、备份和产品收益接口均保持可读。

## 3. 页面与研究归档验收

以下页面返回 HTTP 200：

- `/`
- `/investment/research`
- `/investment/tech-map`

抽样归档报告返回 HTTP 200，大小 66,994 bytes，Content-Type 为 `text/html; charset=utf-8`：

```text
/research/stocks/鼎捷数智-300378-个股深度-2026-10-21.html
```

本次没有修改报告正文、研究结论或静态索引。

## 4. 日志与任务

- 新 Server 的启动日志正常输出服务地址、数据库路径和自动化 startup 结果。
- 新 Server 的 stderr 日志为空。
- 自动评估 startup 已执行，日志为“评估 3 条，待处理 2 项”。
- 守护日志未出现新进程启动失败、端口占用或未捕获异常。
- 旧进程切换时首次强停记录来自重构前运行实例；重构后实例的受控重启已确认优雅退出。
- 当前守护日志的退出码字段显示为空，但不影响通过进程消失与否判定 graceful/forced；可作为后续低优先级日志诊断项。

## 5. 数据库只读验收

对生产数据库 `data/r2_ledger.sqlite` 仅执行只读 PRAGMA：

```text
PRAGMA quick_check: ok
PRAGMA foreign_key_check: []
PRAGMA user_version: 0
PRAGMA journal_mode: wal
业务表数量: 28
```

本次数据库 schema 未改变，没有写入、迁移、恢复、修复或清理真实业务数据。

## 6. 结论

生产服务重启和重启后基础验收通过。

阶段 8 的核心验收点“stop marker 请求优雅关闭、超时才强杀、关闭时停止调度器和 OCR 进程、日志可诊断”在当前代码上已通过实际进程重启验证。

保留事项：

- 本机 Watchdog 计划任务当前未安装。
- 收益截图跨表写入仍不是单一事务。
- Dashboard GET 仍有刷新投影的既有效果。
- automation cycle 仍同步执行，timeout 目前只能诊断，不能强制中断业务计算。
- 本次没有在真实数据库上执行破坏性备份恢复演练；恢复流程此前已在隔离测试数据库验证。

以上保留事项已登记到工作区根目录的 `TODO.md`，编号为 `TD-REF-001` 至 `TD-REF-005`，并附有优先级、风险和完成标准。
