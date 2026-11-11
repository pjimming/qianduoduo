# 每日市场分析接口目录

当前入口使用投资科学公开数据；原独立采集接口目录已退役，可从 Git 历史查询。不得保存或透传登录凭证，不将源站分析视为工作台自行核验的结论。

## QDD-MB-37：可用日期

- 最近验证：2026-11-11，匿名 HTTP 200。
- GET https://touzikexue.com/api/daily-market-analyses/dates
- Header：Accept: application/json；无 Cookie、Authorization、分页或日期参数。
- 响应：`dates`，YYYY-MM-DD 数组，去重后倒序展示。
- 本地转发：GET /api/market-briefs/dates；内存缓存60秒。
- 日期格式异常或源站错误显示读取失败；空数组显示暂无分析，不回退本地旧稿。

## QDD-MB-38：每日三时段分析

- 最近验证：2026-11-11，匿名 HTTP 200；未发布日期可返回404。
- GET https://touzikexue.com/api/daily-market-analyses/{YYYY-MM-DD}
- Header：Accept: application/json；无登录或专用请求头。`_ts` 非必要，不记录示例令牌。
- 响应：`trade_date` 必须等于请求日；`analyses[]` 包含 `analysis_type`、`title`、`content_markdown`、`published_at`、`generated_at`、`validation_status`。
- 类型：morning_brief早盘、midday_brief午盘、market_overview收盘；只展示已发布、非空正文。源站validation_status仅为来源字段，不代表本地事实核验。
- 本地转发：GET /api/market-briefs/{YYYY-MM-DD}；内存缓存30秒、合并同键并发请求、最多100个缓存键。
- 10秒超时、2MiB响应上限、固定主机且不跟随跳转；日期不符或格式错误拒绝展示，未发布显示对应空状态，网络失败提供重试。不使用其他时段或本地稿冒充。

内容仅在本地应用呈现，不写R2账本、报告库或GitHub Pages；源站新内容无需构建即可读取。
