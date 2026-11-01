# TD-OPS-002 生产独立登录托管

> 状态：已完成
>
> 完成日期：2026-11-01
> 关联契约：[生产独立登录托管](../../../../architecture/production-host.md)

## 1. 目标

将钱多多生产服务从 Codex 会话进程树迁出，由当前用户 Windows 计划任务在登录时隐藏启动一次 Supervisor。按用户体验要求，不执行分钟健康巡检，也不额外自动恢复 Supervisor；Supervisor 存活期间负责 Node 子进程异常重启。

## 2. 交付

- 新增 `scripts/production-host.ps1`，管理 `QianDuoDuo-Production` 的唯一登录任务、隐藏 bootstrap、安装/卸载、显式启动/停止、重启和状态。
- 新增 `scripts/production-bootstrap-template.vbs`；安装器在 `C:\ProgramData\QianDuoDuoProduction` 生成 ASCII 路径启动器，通过 `wscript.exe //B` 隐藏运行一次 PowerShell，设置 Unicode 项目目录后使用相对脚本路径，避免中文路径和每分钟弹窗。
- 计划任务只有一个当前用户 `AtLogOn` 触发器，使用 `IgnoreNew`；没有 `TimeTrigger`、分钟巡检或外部 Watchdog。
- `scripts/daemon.ps1` 保留 Supervisor 对 Node 的递增退避重启，并记录 Supervisor 来源、父 PID 和独立运行元数据。
- `prod:start|stop|restart|deploy` 改走独立登录托管控制面；新增 `prod:install|uninstall`。
- `prod:stop` 写持久 `run/host.stop` 并停止运行时，但保留托管；后续登录或手工触发任务看到停止意图会静默退出。
- `prod:status` 校验任务动作、用户和唯一登录触发，再报告实际 Health、停止意图、独立来源及最近启动结果。
- 安装时将旧 `QianDuoDuo-AutoStart` 任务和 Startup 快捷方式迁移为禁用状态，避免双重启动。
- 新增 `npm run test:host` 与 `test/production-host-smoke.ps1`，全部使用临时目录、临时端口和一次性计划任务。

## 3. 故障边界

| 场景 | 行为 |
| --- | --- |
| Node 正常崩溃 | Supervisor 记录退出码，按 2/4/8/16/32/60 秒递增退避重启 |
| 登录任务重复触发 | `IgnoreNew` 与 `run/host.lock` 共同阻止重复 Supervisor |
| Supervisor 缺失 | 不自动恢复；等待下次登录或显式 `prod:start` |
| 健康接口异常 | 不在后台轮询；`prod:status` 和显式启动时读取一次 |
| `prod:stop` | 写持久停止意图；登录任务保持安装但静默隔离 |
| 未知端口占用 | 显式启动失败，不终止非已记录进程 |

## 4. 验证

- `npm run test:daemon`：Node 正常退出、异常退出、强制终止和 benign stderr 捕获通过。
- `npm run test:host`：安装/卸载、唯一登录触发、已登录启动、旧手工运行时迁移、重复启动、Node 崩溃重启、停止隔离、无周期恢复和显式恢复全部通过。
- `node --test test/unit/daemon-script.test.js`：Windows PowerShell 5.1 语法和隐藏 VBS 启动契约通过。
- 所有托管测试使用临时 SQLite 目录、`18766` 临时端口和一次性任务名，不访问正式账本。
- 正式任务：`QianDuoDuo-Production` 为 `Ready`，只有一个 `MSFT_TaskLogonTrigger`，动作是 `wscript.exe`，`NextRunTime` 为空；`C:\ProgramData\QianDuoDuoProduction` 下的隐藏启动器日志显示 `-WindowStyle Hidden` 和退出码 `0`。
- 正式运行：`prod:status` 为 `Independent=yes`、Health OK、Supervisor 来源 `task-scheduler`；Supervisor 父进程已退出，Server 父进程与监听 PID 一致，最新 stderr 0 字节且无 `host.stop`。

## 5. 回滚

1. 运行 `npm run prod:stop` 写入停止意图并停止运行时。
2. 运行 `npm run prod:uninstall` 移除计划任务和隐藏启动器。
3. 使用上一版 `daemon.ps1` 和 `prod:*` 脚本启动兼容 Supervisor。
4. 回滚不删除 SQLite、审计、备份或业务事实；本任务不修改数据库 schema。
