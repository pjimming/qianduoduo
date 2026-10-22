# 阶段 4：本金、账户账本与逐产品收益

## 1. 完成结果

以下 API 已从 legacy 迁出并由独立模块接管：

| 路径 | 模块 |
| --- | --- |
| `POST /api/capital/init` | `capital` |
| `PUT /api/capital/init` | `capital` |
| `POST /api/capital/events` | `capital` |
| `DELETE /api/capital/events/:id` | `capital` |
| `POST /api/records` | `ledger` |
| `PUT /api/records/:date` | `ledger` |
| `DELETE /api/records/:date` | `ledger` |
| `GET /api/export.csv` | `ledger` |
| `GET /api/product-valuations` | `product-valuations` |
| `GET /api/product-yield-settings` | `product-valuations` |
| `PUT /api/product-yield-settings/:code` | `product-valuations` |
| `POST /api/product-valuations` | `product-valuations` |
| `PUT /api/product-valuations/:id` | `product-valuations` |

`server/http/legacy-app.js` 中对应的路由、本金校验、账户收益校验和 CSV 实现均已删除。

## 2. 模块结构

```text
server/modules/
  capital/
    validation.js
    repository.js
    service.js
    routes.js

  ledger/
    validation.js
    export.js
    repository.js
    service.js
    routes.js

  product-valuations/
    repository.js
    service.js
    routes.js
```

### Repository 迁移策略

本阶段 repository 是显式适配器，继续调用现有：

- `lib/db.js` 的 capital/ledger 稳定门面。
- `lib/product-valuation-store.js` 的产品收益 store。

没有复制第二套 SQL 或业务实现。SQL 进一步下沉可在后续阶段进行，但必须同时删除 `lib/db.js` 旧入口，不能形成双写。当前适配器边界足以让 HTTP/service 脱离旧路由并独立测试。

## 3. 本金兼容性

新增测试：

```text
test/integration/historical-principal.test.js
```

测试序列：

1. 临时库初始化 ¥100,000。
2. 增加 ¥5,000 转入和 ¥2,000 转出。
3. 在三个日期写入账户收益。
4. 校验初始本金快照为 `100000 / 105000 / 103000`。
5. 将初始本金调整为 ¥110,000。
6. 校验历史快照重算为 `110000 / 115000 / 113000`。
7. 校验记录 ID、日期、收益、动作和备注全部不变。
8. 删除 ¥5,000 转入。
9. 校验历史再次重算为 `110000 / 110000 / 108000`，收益值不变。

结果：通过。

该测试只使用临时 SQLite，不接触真实账本。

## 4. 账户账本兼容性

保留：

- 未初始化本金时禁止记录收益。
- 日期、未来日期、2000-01-01 下限、金额、动作和备注校验。
- 同日同金额返回 200 `duplicate:true`。
- 同日异金额保留原记录，返回 conflict 并写消息中心。
- 新记录返回 201。
- 修改时禁止改日期。
- 删除不存在记录返回 404。
- CSV UTF-8 BOM、CRLF、列名和文件名保持不变。

PUT 记录仍在读取 JSON body 前检查记录是否存在，保留旧 404/JSON 错误顺序。

## 5. 逐产品收益兼容性

保留：

- `product_code` 详情/汇总双模式和 query 读取。
- 产品收益延迟设置及修正审计。
- 同日同产品唯一约束和冲突返回。
- 0 元收益有效。
- `yield_date` 与 `credit_date`/`valuation_date` 校验。
- 手工修正 PATCH 语义和 audit note。
- 成功响应继续带完整 dashboard。

产品收益 store 仍负责实际 SQL、唯一约束、审计和对账；本阶段没有改变算法或历史数据。

## 6. Legacy 清理验证

源码检索确认以下字符串不再出现在 `server/http/legacy-app.js`：

- `/api/capital`
- `/api/records`
- `/api/export.csv`
- `/api/product-valuations`
- `/api/product-yield-settings`
- `validateRecordPayload`
- `validateCapitalInitPayload`
- `validateCapitalEventPayload`
- `buildCsv`
- `csvEscape`

## 7. 测试结果

```powershell
node --test
```

结果：

```text
tests 176
pass  176
fail  0
```

覆盖率：

```text
line   88.56%
branch 72.93%
funcs  89.18%
```

新增阶段 4 测试：

- 历史本金重算和记录身份保持。
- capital、ledger、product valuations 模块路由集成。
- 本金初始化、资金事件、收益记录、产品延迟设置、0 元产品收益和 CSV 导出。

## 8. 已知风险

1. `getCapitalState()` 的默认日期仍使用 UTC；HTTP 路径显式传上海日期，本阶段未改变该兼容行为。
2. 收益截图跨“产品收益 → 账户收益 → 收件箱状态”的原子性仍未解决，留在阶段 5。
3. Capital/Ledger 的真实 SQL 仍由 `lib/db.js` 持有；当前通过 repository adapter 单一委托，没有双实现。
4. 产品收益 store 尚未拆 SQL；本阶段只迁移 HTTP/service 边界。
5. 生产进程未重启，未对真实数据库执行迁移或批量重算。

## 9. 回滚

本阶段无 schema 变化。回滚时：

1. 恢复 `server/app.js`、`server/http/legacy-app.js` 和 route manifest。
2. 删除三个阶段 4 模块。
3. 恢复阶段 3 的 174 测试基线。
4. 重跑阶段 3 全量测试。
