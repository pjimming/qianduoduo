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
- 10秒超时、2MiB响应上限、固定主机且不跟随跳转；日期不符或格式错误拒绝展示，仅显示当天已发布报告的时段按钮；当前时段缺失时切换到当天最新可用时段，并同步选中项与链接；当天全无报告时显示未发布状态，网络失败提供重试。正文标注实际时段，不使用本地稿冒充。

内容仅在本地应用呈现，不写R2账本、报告库或GitHub Pages；源站新内容无需构建即可读取。

关联 R2 巡检口径（2026-11-16）：收益披露 T+N 按工作日计数，跳过周末和中国大陆法定放假日（周末调休上班不计入）；收益日不计作第 1 日。最终披露日当天仍 waiting，次日仍缺才提示。周末收益沿用周一合并披露起点，再加产品工作日 T+N；覆盖只消除缺口，不改写金额归属。日历覆盖不足时日期仅为估算、保持待核，不据此判漏记。市场简报接口及暂停任务 a 不变。
