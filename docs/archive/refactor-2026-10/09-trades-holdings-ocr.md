# 阶段 5：交易、持仓、截图与 OCR

> 历史快照：本文记录当时的重构、审计或验收结果，不代表当前实现或运行状态。当前事实以代码、`TODO.md`、运行接口和 [文档地图](../../README.md) 为准。

## 1. 完成范围

以下 API 已从 legacy 迁出：

- 交易总览、创建、修改、确认、撤销和审计。
- 交易截图上传、哈希去重、人工校正、忽略、清理和图片读取。
- 截图 apply 与 vision-apply。
- 部分/完全赎回和切换所依赖的交易命令。
- 旧 `/api/review/holdings` 兼容接口。

实现位于：

```text
server/modules/trades/
  validation.js
  repository.js
  service.js
  routes.js
```

## 2. OCR 基础设施

原 `lib/ocr.js` 实现已移动到：

```text
server/infrastructure/ocr/
  windows-ocr.js
  index.js
```

职责：

- `windows-ocr.js`：Windows PowerShell OCR 子进程、超时和 JSON 输出解析。
- `index.js`：给交易域提供 `read()`，把 OCR 文本解析为交易字段。

兼容层：

```text
lib/ocr.js -> server/infrastructure/ocr/windows-ocr.js
```

现有调用和测试不需要改 import。

图片 Base64 解码和 MIME 校验移动到：

```text
server/shared/images.js
```

交易和尚未迁移的收益截图流程共享同一解码实现，没有复制两套。

## 3. 交易不变量

继续由现有 trade store 和新增 service 保持：

- pending 交易不进入正式持仓。
- confirmed 交易才参与 allocations。
- 确认日决定期限起算和持有起点。
- 同字段 pending/confirmed 重复交易受 dedupe key 和业务检查保护。
- 赎回按同产品批次先进先出。
- 切换先消耗来源产品，再建立目标产品批次。
- 部分赎回超过批次本金时整个命令失败并回滚。
- 交易变更写 audit。

## 4. 事务加固

`lib/trade-store.js` 新增可嵌套事务协调器 `withTransaction()`：

- 顶层调用开启 `BEGIN IMMEDIATE`。
- 事务内的 create/update/confirm/cancel 复用同一事务，不重复 `BEGIN`。
- `applyInbox()` 现在把“创建/确认交易”和“更新截图 applied 状态”放在同一事务中。
- 任一失败会整体回滚，截图保持 pending，不产生正式交易。

使用真实 SQLite trigger 注入 inbox update 失败，回归测试确认：

- API 返回错误。
- 交易数量仍为 0。
- 截图仍为 pending。

## 5. 并发截图上传

交易截图上传流程改为：

1. 写入唯一本地文件。
2. 在 DB 中立即建立 pending 收件箱占位（SHA-256 唯一）。
3. 执行 OCR。
4. 更新 ocr_text、parsed、confidence/error。

若并发同图上传：

- 只允许一个占位记录插入。
- 一个请求返回 201，另一个返回 200 `duplicate:true`。
- 竞争失败的文件若与胜出文件名不同会删除。

新增真实并发测试：

- 两个相同图片请求同时上传。
- 收件箱只有 1 条记录。
- OCR 被关闭时截图保持 pending 且 error 可诊断。
- 不创建正式交易。

## 6. 截图人工处理兼容性

保留：

- `PUT /api/trades/inbox/:id` 人工校正字段白名单。
- `apply` 合并 parsed + 人工字段后统一校验。
- `vision-apply` 的金额/产品代码 OCR 对照。
- `OCR_AMOUNT_MISMATCH`、`OCR_CODE_MISMATCH`、`UNKNOWN_PRODUCT_CODE`、`NO_MATCHING_TRADE` 409 响应。
- `confirm_mismatch`、`allow_unknown_code`、`create` 显式确认字段。
- 截图 image URL、no-store 和本地文件路径保护。
- 30–3650 天截图清理。

## 7. 旧持仓兼容 API

`/api/review/holdings` 已迁入 trades 模块：

- POST 创建 confirmed buy 交易。
- PUT 修改对应交易。
- DELETE 撤销对应交易。

正式持仓仍只由交易推导，没有恢复为独立可写持仓来源。

## 8. Legacy 清理

`server/http/legacy-app.js` 中已删除：

- `/api/trades` 全部路由。
- trade inbox 全部路由。
- `/api/review/holdings` 路由。
- 交易/持仓校验函数。
- 交易图片解码函数。
- 交易后 decision/evaluation 同步函数。
- 交易 OCR import。

收益截图仍暂时使用兼容 OCR 入口，阶段 6/后续再迁。

## 9. 测试结果

```powershell
node --test
```

结果：

```text
tests 179
pass  179
fail  0
```

覆盖率：

```text
line   88.41%
branch 73.13%
funcs  87.80%
```

新增阶段 5 测试：

- 并发相同截图只产生一条收件箱记录。
- OCR 失败不创建交易。
- inbox apply 抛出错误时不产生正式交易。
- 数据库 trigger 强制 inbox 更新失败时，交易与状态整体回滚。

原有测试继续覆盖：

- pending 不入持仓。
- 确认日重算期限。
- 部分赎回 FIFO。
- 切换来源/目标批次。
- 重复交易拒绝。
- 旧 holdings 迁移。
- 截图匹配已有 pending 交易。
- 审计和截图清理。
- vision apply 冲突。

## 10. 已知风险

1. 文件在 DB 占位前写入；若进程恰好在写文件成功与插入占位之间崩溃，仍可能留下孤立文件。目录清理需在阶段 8/后续加入对账。
2. 交易 SQL 仍由 `lib/trade-store.js` 持有；阶段 5 通过 repository adapter 和模块 service 接管调用边界，没有双实现。
3. 没有执行真实招行截图 OCR 成功链路；测试使用 OCR 关闭、解析器单测和已有 fixture。真实机器 OCR 仍需人工 smoke。
4. 跨模块决策/评估同步发生在主交易事务提交后，失败时可重试，但不是同一事务。
5. 生产进程未重启，本次未接触真实截图目录或生产数据库。

## 11. 回滚

本阶段无 schema 变化。回滚：

1. 恢复 `server/app.js`、`server/http/legacy-app.js`、`routes.js`。
2. 恢复 `lib/trade-store.js` 事务和 inbox update 变更。
3. 恢复 `lib/ocr.js`，删除 server OCR adapter。
4. 删除 trades module 和阶段 5 测试。
5. 重跑阶段 4 的 176 测试基线。
