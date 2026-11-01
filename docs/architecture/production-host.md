# 生产独立登录托管

## 目标

钱多多生产服务不得依赖 Codex 会话、终端窗口或 `npm` 父进程存活。当前用户登录后，Windows 计划任务 `QianDuoDuo-Production` 通过隐藏启动器拉起一次 Supervisor；Supervisor 与 Node Server 随后独立运行。

按当前用户体验要求，不设置分钟健康巡检、外部 Watchdog 或 Supervisor 自动恢复。Supervisor 存活期间负责 Node 异常退出和递增退避重启；Supervisor 本身消失时由用户显式执行 `prod:start`。

## 组件

| 组件 | 责任 |
| --- | --- |
| `scripts/production-host.ps1` | 安装/卸载唯一登录任务、组合状态、隐藏启动/停止和显式重启 |
| `scripts/production-bootstrap-template.vbs` | 安装器据此生成无控制台启动器；设置 Unicode 项目目录后隐藏运行一次 PowerShell |
| `scripts/daemon.ps1` | 直接管理 Supervisor、Node 子进程和 PID；Supervisor 对 Node 异常退出执行递增退避 |
| Windows 计划任务 | 当前用户登录触发一次；无 TimeTrigger、无周期巡检 |
| `/api/health` | 仅供状态查询和显式启动验收，不作为周期巡检来源 |

计划任务只允许当前用户交互令牌、最低权限运行，设置 `IgnoreNew` 防重复执行。任务动作使用 `wscript.exe //B` 调用 `C:\ProgramData\QianDuoDuoProduction` 下的 ASCII 路径启动器；VBS 再以隐藏窗口运行一次 PowerShell。安装/更新任务需要 UAC，所有提升权限子进程同样使用隐藏窗口。

## 文件契约

| 文件 | 含义 |
| --- | --- |
| `C:\ProgramData\QianDuoDuoProduction\tick-<task>.vbs` | 生成的隐藏登录启动器；通过相对路径避免中文工作区参数破坏 WScript 启动 |
| `run/host.json` | 最近一次有效托管配置：任务名、隐藏启动器、用户、根目录和端口 |
| `run/host-state.json` | 最近一次登录 bootstrap 或受控停止的结果和 PID 快照 |
| `run/host.stop` | 持久停止意图。存在时登录启动必须静默退出 |
| `run/supervisor.json` | 当前 Supervisor 的 PID、父进程、来源、根目录和端口 |
| `run/daemon.pid`、`run/server.pid` | 运行时 PID；只用于进程查找 |
| `logs/launcher.log` | 登录启动器写入命令完成情况和退出码 |
| `logs/host.log` | 安装、启动、停止和显式迁移事件 |
| `logs/daemon.log` | Supervisor 生命周期与 Node 退避重启 |

所有状态文件均通过同目录临时文件原子替换。`host.lock` 使用独占文件句柄，防止并发 bootstrap 创建重复 Supervisor。

## 行为

- `started`：登录任务无停止意图，且成功创建独立 Supervisor。
- `supervisor_already_running`：重复触发时已有 Supervisor，直接退出。
- `controlled_stop`：`prod:stop` 或卸载写入停止意图并停止运行时。
- `start_failed`：显式或登录启动失败，记录错误但不在后台重试。
- Node 正常崩溃：Supervisor 记录退出码，按 2/4/8/16/32/60 秒递增退避重启。
- Supervisor 缺失：不自动恢复，等待下次登录或显式 `prod:start`。

## 运维命令

```powershell
npm run prod:install
npm run prod:uninstall
npm run prod:start
npm run prod:stop
npm run prod:restart
npm run prod:status
```

`prod:start` 和 `prod:restart` 通过唯一登录任务启动，以便 Supervisor 来源标记为 `task-scheduler`。`prod:stop` 先写停止意图，再让隐藏登录任务停止运行时；不会注销托管。`prod:status` 校验任务动作、用户和唯一登录触发，并报告实际进程、独立来源、停止意图及最近启动结果。

## 验证

- Windows PowerShell 5.1 脚本全部通过语法解析。
- VBS 契约验证：窗口样式 `0`、PowerShell `-WindowStyle Hidden`、相对脚本路径和退出码返回。
- 独立托管测试：临时目录、临时端口和一次性计划任务，覆盖安装/卸载、唯一登录触发、已登录启动、旧手工运行时迁移、重复启动、Node 崩溃重启、无周期恢复、停止隔离和显式恢复。
- 测试不得使用 `data/r2_ledger.sqlite`、正式截图目录、正式端口或正式计划任务名称。
