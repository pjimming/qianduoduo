# 环境初始化与分享指南

> 目标：让另一个人在另一台 Windows 机器上，得到与你当前一致的**软件环境、skill、Codex 定时任务和应用设置**。  
> 不包含：你的账本数据、成交截图、API Key 和个人 Codex 配置。

这份文档回答两个问题：你要把哪些东西分享出去；对方拿到项目后，按什么顺序初始化。

---

## 0. 先分清三层

| 层 | 内容 | 分享方式 |
| --- | --- | --- |
| 应用与报告 | 代码、`report/`、`research/`、脚本、文档 | 随项目分享 |
| 个人数据 | `data/r2_ledger.sqlite`、备份、成交截图 | **不要分享**；仅自己迁移时复制 |
| Codex 环境 | 三个 skill、四个定时任务、模型/时区设置 | 按本文档重建，不复制密钥 |

“达到一样的环境”指的是同一套工具、同一套流程和同一套默认设置，不是把同一个账本交给别人。每个人应该用自己的本金、收益记录和成交截图初始化。

---

## 1. 分享前检查（你）

### 1.1 应该分享

- `package.json`、`package-lock.json`、`server.js`、`lib/`、`src/`、`scripts/`、`test/`；
- `report/` 下的 HTML 源报告；
- `research/index.html`；
- `AGENTS.md`、`MEMORY.md`、`README.md`、`USAGE.md`、`SETUP.md`；
- `codex-automations/`；
- `data/cmb_r2_*.csv`（公开产品快照，可选；对方也可以自己刷新）。

### 1.2 不要分享

- `data/r2_ledger.sqlite` 及 WAL/SHM；
- `data/backups/`；
- `data/trade-inbox/`（成交截图）；
- `.env`（如果以后加入密钥或私有配置）；
- `node_modules/`、`dist/`、`run/`、`logs/`；
- `C:\Users\<你>\.codex\config.toml`、`auth.json`、`automations/` 原目录；
- 任何 API Key、Cookie、银行账户截图。

### 1.3 推荐分享方式

用 Git 仓库或压缩包，排除上面的个人数据。如果使用 Git，先提交当前版本，再让对方 clone；如果使用压缩包，手动确认没有把 `data/*.sqlite`、`data/backups/`、`data/trade-inbox/` 打进去。

项目 `.gitignore` 已经忽略 SQLite、备份、截图、`node_modules`、`dist`、`run`、`logs`，以及 `src/data/reportDocs/`、`src/data/reportSearch.json`、`public/research/media/` 这些报告构建产物。压缩包不会自动遵守 `.gitignore`，需要你手动检查。

### 1.4 分享前必须脱敏

项目文档里有多处个人账本快照，分享前要删除或替换：

- `MEMORY.md` 第 3 节、第 5 节里涉及“六笔 … 买入”“当前账户：本金 …”的句子；
- `TODO.md` 里涉及“六笔 … 买入”“待确认金额 …”的句子。

可以保留方法、回测结论、公开数据源和架构说明，但不要保留你的本金、持仓、交易金额和账户状态。

检查命令：

```powershell
Select-String -Path *.md -Pattern '¥','当前账户','待确认金额','六笔' -SimpleMatch
```

建议把 `MEMORY.md` 第 5 节替换为脱敏版本：

```markdown
## 5. 当前数据与 Git

- 当前账户：首次使用时初始化自己的本金和日期；个人账本数据不随项目分享。
- 产品快照：运行 `npm run r2:refresh-all` 生成，以本地最新 CSV 为准。
- 公开数据源：招行理财产品统一查询平台公开接口；签名从公开页面获取，不硬编码。
- 数据备份：启动时自动写入 `data/backups/`，保留 45 天；`npm run db:list|db:backup|db:restore` 可手动操作。
- Git 分支：`main`；`dist/`、`node_modules/`、`.env` 和 SQLite 文件均被 Git 忽略。
```

`MEMORY.md` 第 3 节里的具体迁移笔数改成通用描述；`TODO.md` 里的技术与待办可以保留，但把带有具体金额、笔数和交易状态的句子全部删掉。

---

## 2. 对方机器：从零到能打开应用

### 2.1 环境要求

- Windows 10/11；
- Node.js 24 或更高版本；
- Chrome 或 Edge；
- Codex 桌面端（如果要复刻定时任务和 skill）。

检查：

```powershell
node -v
npm -v
```

当前机器使用 Node `v24.20.0`；Node 24 是硬要求，因为项目使用内置 `node:sqlite`。

### 2.2 安装与启动

```powershell
cd <项目目录>
npm install
npm run build
npm run prod:start
```

或者直接双击 `start.bat`。启动后打开：

```text
http://127.0.0.1:8765
```

首次进入会提示初始化本金。让对方填自己的起始本金和日期，不要把应急金放进 R2 组合。起始日前的日期会显示为“起始日前”，不计缺记、不需要补录；起始月可记录天数不足 28 天时不参与最终评级。

### 2.3 开发模式（可选）

```powershell
npm run dev:all
```

开发页是 `http://127.0.0.1:5173`，API 代理到 `8765`。

---

## 3. 安装三个 skill

三个 skill 不在项目仓库里，而是安装在当前用户的全局 Codex 目录：

```text
%USERPROFILE%\.codex\skills\r2-wealth-management\
%USERPROFILE%\.codex\skills\serenity-skill\
%USERPROFILE%\.codex\skills\equity-research\
```

当前机器的路径是：

```text
C:\Users\Administrator\.codex\skills\r2-wealth-management\
C:\Users\Administrator\.codex\skills\serenity-skill\
C:\Users\Administrator\.codex\skills\equity-research\
```

### 3.1 安装方式

任选一种：

1. 在 Codex 里使用 `$skill-installer` 或 `$manage-skills` 安装；
2. 把三个 skill 目录复制到 `%USERPROFILE%\.codex\skills\`；
3. 如果你有自己的 skill 仓库，按仓库的安装说明部署。

分享 skill 时直接复制当前安装目录；仓库不再保留旧版打包压缩包，避免误用缺少最新参考文件的版本。

### 3.2 检查

每个目录至少要有可读的 `SKILL.md`。当前版本参考：

- `r2-wealth-management`：1.3.0
- `serenity-skill`：1.1.0
- `equity-research`：以当前安装版本为准

在 Codex 里试触发：

```text
$r2-wealth-management 帮我检查一个 R2 产品。
$serenity-skill 帮我拆解一个产业链。
$equity-research 帮我研究一只股票。
```

### 3.3 注意

股票相关请求按 `AGENTS.md` 会同时使用 `serenity-skill` 和 `equity-research`。只装其中一个，双 skill 流程会不完整。

研究能力还依赖 Codex 的网页/文件访问工具。当前机器启用了浏览器、computer-use 等插件；新环境至少要保证能打开公告、财报和行情页面，否则 skill 只能给出有边界的初步结论。

---

## 4. 创建四个 Codex 定时任务

详细配置和可复制提示词在：

```text
codex-automations/README.md
```

三个任务：

| 任务 | 时间 | 作用 |
| --- | --- | --- |
| R2产品快照每周更新 | 每周一 08:30 | 刷新 R2 产品池 |
| 钱多多R2每日巡检（含队列处理） | 每天 21:00 | 先处理 Codex 判断队列，再检查收益、交易、对账、评估 |
| 钱多多R2周五结构巡检 | 每周五 18:30 | 检查记录、集中度、流动性、到期 |

### 4.1 创建顺序

1. 先在 Codex 中打开本项目工作区，让项目出现在项目列表；
2. 打开 Automations，新建 cron 任务；
3. 按 `codex-automations/README.md` 的任务表填写名称、时间、模型、reasoning；
4. 执行环境选 `local`；
5. 工作目录设为项目根目录；
6. 从对应 `.md` 文件复制提示词；
7. 替换 `<WORKSPACE>` 等占位符；
8. 保存并启用；
9. 手动运行一次，确认能读到 `http://127.0.0.1:8765`。

### 4.2 不要做的事

- 不要把 `%USERPROFILE%\.codex\automations` 整个目录复制给对方；
- 不要复用 `project_id`；
- 不要复制 `config.toml` 或 `auth.json`；
- 不要为了同名模型去改 provider 或泄露 API Key。

### 4.3 模型与时区

当前机器的任务使用：

- 三个任务统一：`deepseek-flash`，reasoning `high`；
- 全部 `local`，时区 `Asia/Shanghai`。

如果对方没有同名模型，选择同等能力、支持工具调用的模型，并保持 `high` reasoning。关键是“本地执行 + 项目工作目录 + 完整提示词”，不是模型名字完全一样。

---

## 5. 应用初始化设置

打开首页“自动评估 → 评估设置”，对照下表。截至 2026-10-19，当前数据库没有覆盖这些值，因此使用代码默认值：

| 设置 | 当前值 | 说明 |
| --- | --- | --- |
| 组合目标年化 | 3.0% | 进取目标，不是保本承诺 |
| 短期限 hurdle | 2.5% | 单只短期结果评价 |
| 中期限 hurdle | 2.8% | 单只中期结果评价 |
| 长期限 hurdle | 3.0% | 单只长期结果评价 |
| 单只上限 | 30% | 超过会触发集中度提醒 |
| 流动性下限 | 30% | 日开 + 30 天内占比 |
| 期限桶容差 | 10pp | 买入日流程检查 |
| 自动写入置信度 | 75% | 低于门槛进入待确认 |
| 巡检间隔 | 5 分钟 | 本地服务自动巡检 |
| 策略版本 | `r2-3pct-v1` | 决策默认策略 |
| 评估规则版本 | `r2-eval-v1` | 代码默认规则 |

如果对方想完全对齐，把这些值设为上表；如果对方的风险偏好不同，应明确修改，并在决策日志里写清原因。

### 5.1 产品池

```powershell
npm run r2:refresh-all
```

会生成：

- `data/cmb_r2_all-*.csv`
- `data/cmb_r2_universe-*.csv`
- `data/cmb_r2_selected-*.csv`

页面“刷新快照”会读取最新 universe CSV。实时额度、费率和可买状态仍需在招行 App 当日核验。

### 5.2 报告

如果分享包里包含 `report/`：

```powershell
npm run research:publish
```

会重建导航、应用内副本、检索索引、图片，并重启生产服务。

---

## 6. 启动方式与生产守护

### 6.1 最小方式

双击 `start.bat`。适合偶尔使用；关闭窗口或注销后服务停止。

### 6.2 当前机器的方式

当前机器使用生产守护：

```powershell
npm run prod:start
npm run prod:status
```

状态显示 Supervisor 运行中、Health OK；Windows 计划任务 `QianDuoDuo-Production` **未安装**。如果你想和当前机器完全一致，用 `prod:start` 即可。

### 6.3 带开机自启的方式

```powershell
npm run prod:deploy
```

它会构建、跑测试、停止旧守护、注册 Windows 计划任务 `QianDuoDuo-Production`（失败时回退到 Startup 快捷方式），然后启动并检查健康状态。

这条命令会改变开机自启行为；只在你确实需要时使用。

### 6.4 停止与重启

```powershell
npm run prod:stop
npm run prod:restart
```

---

## 7. 验证清单

### 7.1 服务

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/api/health
```

HTTP 200 即通过。

### 7.2 账本

```powershell
(Invoke-RestMethod http://127.0.0.1:8765/api/dashboard).meta
```

确认 `today`、`product_csv` 和产品数量正常。

### 7.3 自动化设置

```powershell
(Invoke-RestMethod http://127.0.0.1:8765/api/automation/workspace).settings
```

对照第 5 节的表。

### 7.4 产品快照

```powershell
Get-ChildItem data\cmb_r2_universe-*.csv | Sort-Object LastWriteTime -Descending | Select-Object -First 1
```

应能看到当天或最近日期的候选池。

### 7.5 报告

打开：

```text
http://127.0.0.1:8765/investment/research
```

能看到报告卡片、搜索和详情页即通过。

### 7.6 Codex 定时任务

在 Codex Automations 页面确认三个任务都存在、状态为启用、时间正确。手动运行一次，检查：

- `r2`：生成当天 CSV；
- `r2-2`：没有异常或待办时无消息，有内容时只有一张巡检卡；
- `r2-3`：没有结构风险时无消息；

---

## 8. 个人数据迁移（只给你自己）

如果只是你换电脑，想把账本一起带走：

1. 在原机器停止服务；
2. 运行 `npm run db:backup`；
3. 复制 `data/r2_ledger.sqlite`、`data/backups/`、`data/trade-inbox/`；
4. 在新机器放到同样的相对路径；
5. 启动服务，检查 `/api/dashboard`；
6. 需要恢复历史备份时用 `npm run db:restore -- YYYY-MM-DD`，恢复前先停服务。

不要把这份数据发给别人。它包含你的本金、收益、交易和成交截图。

---

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| 对方打开页面是空账本 | 正常；让对方初始化自己的本金和收益 |
| 定时任务不触发 | 确认 Codex 桌面端在运行、任务已启用、时区正确 |
| 定时任务读不到数据 | 先启动本地服务，检查 `8765/api/health` |
| 提示模型不存在 | 换同等能力模型，保持 high reasoning |
| skill 没触发 | 确认三个 skill 已安装，并用 `$skill-name` 显式点名 |
| 周报读不到产品快照 | 把提示词里的 `cmb_r2_products` 改成 `cmb_r2_selected`（精选）或 `cmb_r2_universe`（全量候选） |
| Windows 计划任务安装失败 | `prod:deploy` 会回退到 Startup 快捷方式；也可只用 `prod:start` |
| 报告页没有新报告 | 确认文件名以 `-YYYY-MM-DD.html` 结尾，执行 `npm run research:publish` |
| 数据库恢复被拒绝 | 先 `npm run prod:stop` |

---

## 10. 当前环境快照（2026-10-19）

| 项目 | 当前值 |
| --- | --- |
| 工作区 | `D:\codex\钱多多财富工作台` |
| Node.js | `v24.20.0` |
| 本地服务 | `http://127.0.0.1:8765` |
| 生产守护 | Supervisor 运行中，Health OK |
| Windows 看门狗 | `QianDuoDuo-Production` 未安装 |
| Codex 定时任务 | 3 个，全部 ACTIVE，全部 deepseek-flash，全部 local |
| 应用自动化 | 目标 3.0%，hurdle 2.5/2.8/3.0%，单只 30%，流动性 30%，置信度 75%，巡检 5 分钟 |
| 产品快照 | 2026-10-19：全量 980 / 候选 432 / 研究观察池 9 |
| 报告数量 | 13 篇（截至 2026-10-19） |
| skill | `r2-wealth-management` 1.3.0、`serenity-skill` 1.1.0、`equity-research` 当前安装版 |

快照会随环境变化。分享时以本文档的步骤为准，不要把快照里的个人路径、PID 或数据当成永久配置。

---

## 11. 一页纸初始化清单

- [ ] Node.js 24+，`node -v` 正常；
- [ ] `npm install` 完成；
- [ ] `npm run build` 成功；
- [ ] `npm run prod:start`，`http://127.0.0.1:8765/api/health` 返回 200；
- [ ] 首次进入初始化自己的起始本金和日期，并确认起始日前日期显示为“起始日前”、无需补记；
- [ ] 三个 skill 都已安装，`SKILL.md` 可读；
- [ ] 四个 Codex 定时任务已创建并启用；
- [ ] 应用评估设置与第 5 节一致；
- [ ] `npm run r2:refresh-all` 生成最新产品 CSV；
- [ ] `npm run research:publish` 后报告库可见；
- [ ] 每个定时任务手动运行一次，行为符合预期；
- [ ] 分享包里没有 SQLite、备份、成交截图、`.env` 和 Codex 密钥；
- [ ] `MEMORY.md` / `TODO.md` 里没有本金、持仓和交易金额。
