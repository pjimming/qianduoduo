# 阶段 1：测试保护基线

## 1. 本阶段目标

在迁移业务代码前建立可重复、隔离、能保护财务不变量的测试基础。

本阶段只新增测试和测试 helper，不改变生产业务行为。

## 2. 测试基础设施

新增：

```text
test/helpers/test-context.js
test/integration/app-lifecycle.test.js
test/integration/financial-idempotency.test.js
test/integration/migrations-and-backup.test.js
test/integration/transaction-failure.test.js
test/unit/ocr-adapter.test.js
```

### `test-context.js`

提供：

- 每次测试独立临时目录。
- 独立 SQLite 文件。
- 独立 `trade-inbox` / `income-inbox`。
- 固定产品 CSV fixture。
- 静默 logger。
- port 0 HTTP 测试服务。
- JSON request helper。
- 本金初始化 helper。
- 测试结束自动关闭 repository、HTTP Server 并删除临时目录。

不会使用：

- `data/r2_ledger.sqlite`
- `data/trade-inbox/`
- `data/income-inbox/`
- 固定生产端口
- 真实 OCR

## 3. 新增回归测试

### 3.1 应用生命周期

`test/integration/app-lifecycle.test.js`：

- 隔离端口启动。
- `/api/health` 200。
- 关闭 HTTP Server。
- 关闭后数据库不可继续使用。
- 未知 API 保留 404 `接口不存在`。
- 非法 JSON 保留当前 500 行为，作为重构前 characterization。

### 3.2 财务幂等

`test/integration/financial-idempotency.test.js`：

- pending 买入不进入正式持仓。
- 同字段 pending 交易重复创建返回 409。
- 重复确认同一交易不增加持仓或本金。
- 确认后部分赎回只减少一次本金。
- 实现收益正确记录。
- 同日同额收益重复请求不覆盖原备注。
- 同日异额收益保留原值并返回 conflict。

### 3.3 迁移和备份

`test/integration/migrations-and-backup.test.js`：

- 旧版 `daily_records` 含 `cash_balance` 时，迁移保留收益数据。
- 迁移后移除 `cash_balance` 并补 `source` / `screenshot_id`。
- 旧收益自动生成本金起点。
- WAL 模式下使用 `VACUUM INTO` 的备份包含已提交数据。

### 3.4 失败注入

`test/integration/transaction-failure.test.js`：

- 固定当前“收益截图在产品收益和账户收益已写入后，收件箱更新失败会部分提交”的行为。
- 自动周期发生中途异常时，失败 run 持久化。
- 恢复依赖后下一次 cycle 可完成。

第一项不是对当前缺陷的认可，而是迁移前 characterization。阶段 4/5 建立共享事务后，应把该测试改成“全部回滚或可恢复收敛”，并记录业务兼容变化。

### 3.5 OCR 适配

`test/unit/ocr-adapter.test.js`：

- OCR 引擎无法启动时返回受控失败。
- 不抛出未捕获异常。
- 不创建正式交易或收益。

## 4. 可重复命令

全量测试：

```powershell
node --test
```

覆盖率：

```powershell
node --experimental-test-coverage --test
```

说明：

- 直接使用 `node --test`，不触发 `npm test` 的 `pretest` 报告生成步骤。
- 所有新增测试使用临时目录。
- Node 24 的 `node --test test/unit` 不会递归发现目录；当前推荐直接运行全量 `node --test`。

## 5. 阶段 1 执行结果

### 测试数

```text
tests   167
pass    167
fail    0
skipped 0
```

### 覆盖率

```text
all files
  line   88.36%
  branch 73.91%
  funcs  90.86%
```

关键变化：

- `lib/ocr.js` 行覆盖由 46.67% 提升到 83.33%。
- `lib/automation-store.js` 行覆盖提升到 90.40%。
- 新增应用生命周期、旧库迁移、WAL 备份、财务失败注入测试。

## 6. 阶段 1 验收

- [x] 可重复测试命令。
- [x] 测试数据临时化。
- [x] 应用启动/关闭。
- [x] 数据库初始化和旧 schema 迁移。
- [x] 重复交易创建/确认。
- [x] 买入、部分赎回和持仓变化。
- [x] 本金与收益记录。
- [x] 自动周期失败与下一次重试。
- [x] OCR 启动失败。
- [x] WAL 备份；现有 `db-cli.test.js` 继续覆盖完整 restore。
- [x] 财务不变量 characterization。

剩余缺口：

- 真正的 OS 信号关闭测试将在阶段 2 拆分生命周期后补强。
- 文件写入与 database insert 的并发竞态尚未在阶段 1 修复，只记录已知风险。
- 恢复前 WAL 安全快照问题仍在阶段 8 处理。

**阶段 1 结论**：完成，可以进入阶段 2。
