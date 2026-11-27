# 2026-11-25 生产服务离线排查与恢复

## 原因与证据

时间均为 Asia/Shanghai。

- 13:01:30 启动日志记录 Supervisor PID 6700、Node PID 34632；随后没有正常退出或崩溃退避日志。
- 系统 Winlogon 事件 7002 记录 13:58:54 用户注销；7001 记录 22:12:30 重新登录。结合进程消失及日志中断，推断原交互式运行时在注销期间结束；没有发现 Node 自身报错导致此次离线的证据。
- 22:12:32 创建的 `msedgewebview2.exe` 复用了 PID 6700。22:12:36 的登录启动仍读取旧 `run/daemon.pid`，仅凭 PID 存活就保存 `supervisor_already_running`，跳过真正启动。8765 无监听，Health 失败。
- 旧 `prod:status` 同样误报 Supervisor 存活，且仅凭有效任务和历史来源就显示 `Independent: yes`。

## 修复

- 新增 `scripts/runtime-process.ps1`，由 host 与 daemon 共用身份核验。Supervisor 校验可执行文件类型及脚本、工作区、端口、run 动作；Node 校验类型、命令、持久 Supervisor 父进程和 PID 文件写入时点。
- 普通权限读取提权计划任务进程时命令行不可见，使用 Supervisor 自行持久化的实际进程创建时间，关联 PID、工作区和端口；没有可验证身份时不认作本服务。停止前重新验证身份，避免误停复用 PID 的程序。
- `prod:status` 独立托管正常要求真实 Supervisor、Node、有效计划任务来源和实际 Health 同时成立。
- 通过既有 `QianDuoDuo-Production` 隐藏登录任务恢复及重启，没有增加周期巡检或外部 Watchdog，没有更改停止意图语义。

## 验收

- `npm run check`、`npm test` 647/647、`npm run build`、完整 `npm run test:e2e` 通过。
- `npm run test:daemon` 通过：正常退出、stderr、异常退出码与强制停止。
- `npm run test:host` 使用临时目录、18766 端口及一次性任务通过：任务定义、手动迁移、重复启动、Node 崩溃恢复、持久停止意图、残留 PID 恢复且不误杀其他进程、孤儿恢复和卸载。测试任务与目录已清理。
- 定向身份测试覆盖 PID 被 WebView 复用、无命令行的提权进程、创建时间不匹配、错误端口和无关 PowerShell 命令。
- 运行证据位于 `run/service-recovery-*.log`、`run/service-recovery-facts-before.json` 和 `run/service-recovery-final.json`。
- 22:25 正式重启后，Supervisor 17792、Node 10776；`prod:status` Health OK、独立托管正常，host-state 为 started 且无错误，实际进程创建时间自动写入元数据。健康、Dashboard 摘要、消息中心及策略状态四接口均 200，最新 stderr 为 0 字节，无 host.stop。SQLite quick_check=ok；36 条日账、233 条产品收益、20 条决策、2 条账户市值快照和20条银行产品累计记录的数量与内容 SHA256 均与恢复前一致。

本轮未提交 Git；保留开始时已有的股票工作台与 R2 净值补查相关未提交修改。
