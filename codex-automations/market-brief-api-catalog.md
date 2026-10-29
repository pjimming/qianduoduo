# 每日市场简报接口目录

本文件保存钱多多 A 股收盘每日简报已验证、可复用的数据入口。任务每次运行先读取本文件；新增接口必须实际请求成功并确认响应字段后再登记，不能把搜索摘要、一次性新闻文章或猜测写成接口。

## 登记规则

- 优先记录稳定的数据接口、官方列表页、官方日历和本地确定路径；具体新闻文章只在正文引用时保留，不因一次事件写入本目录。
- URL 中的业务日期必须参数化为 `YYYY-MM-DD` 或 `YYYYMMDD`，不得把某次查询日期写成唯一入口。
- 新条目必须写明用途、请求方式与必要请求头、日期参数、响应字段、统计范围和失败回退。
- 同一主机与路径已登记时，更新“最近验证”和字段说明，不重复新增；口径变化必须保留说明。
- 不记录 Cookie、令牌、账户标识、R2 账本、账户事实、交易截图或其他私有数据。
- 运行中发现新接口并确认可复用后，除登记本文件外，还要在 `$CODEX_HOME/automations/a/memory.md` 写入一行摘要。

## 已验证接口

| ID | 最近验证 | 用途 | 入口与参数 | 读取说明 |
| --- | --- | --- | --- | --- |
| QDD-MB-01 | 2026-10-29 | 新浪五指数快照 | `https://hq.sinajs.cn/list=s_sh000001,s_sz399001,s_sz399006,s_sh000688,s_sh000300`；Header `Referer: https://finance.sina.com.cn` | 名称、点位、涨跌额、涨跌幅、成交量、成交额；`s_` 汇总不带完整日期，日期另由腾讯时间戳和交易所 `TRADE_DATE` 校对 |
| QDD-MB-02 | 2026-10-29 | 腾讯指数历史与复核 | `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},day,{start},{end},{count},qfq` | `symbol` 为 `sh000001`、`sz399001`、`sz399006`、`sh000688`、`sh000300`；读取 `day` 和 `qt`，日期用 `YYYY-MM-DD` |
| QDD-MB-03 | 2026-10-29 | 上交所股票日终统计 | `https://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_SJ_GPSJ_CJGK_MRGK_C&PRODUCT_CODE=17&type=inParams&SEARCH_DATE=YYYY-MM-DD`；Header `Referer: https://www.sse.com.cn/` | `PRODUCT_CODE=17` 为股票合计，读取 `result[].TRADE_AMT`（亿元）和 `TRADE_DATE` |
| QDD-MB-04 | 2026-10-29 | 深交所证券类别统计 | `https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1803_sczm&TABKEY=tab1&txtQueryDate=YYYY-MM-DD`；Header `Referer: https://www.szse.cn/` | 读取 `data[]` 中“股票”的 `cjje`（亿元）；含存托凭证，B 股单列，ETF 在基金项下 |
| QDD-MB-05 | 2026-10-29 | 全 A 涨跌家数 | `https://push2.eastmoney.com/api/qt/clist/get?pn={page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f3,f12,f14` | 单页约 100 只，按 `pn` 翻页；统计有效 `f3` 的正、负、零；含北交所和 ST，不含 B 股与 ETF |
| QDD-MB-06 | 2026-10-29 | 涨停结构 | `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt%3Aasc&date=YYYYMMDD` | 读取 `data.tc`；日期用 `YYYYMMDD` |
| QDD-MB-07 | 2026-10-29 | 跌停结构 | `https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fund%3Aasc&date=YYYYMMDD` | 读取 `data.tc`；日期用 `YYYYMMDD` |
| QDD-MB-08 | 2026-10-29 | 固定行业分类 | `https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php` | 解析 `S_Finance_bankuai_sinaindustry`；逗号字段索引 1 为行业名、5 为涨跌幅、7 为成交额；约 49 个宽行业，`次新股`非行业 |
| QDD-MB-09 | 2026-10-29 | 人民银行新闻列表 | `https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html` | 从列表打开实际文章并核对正文、发布时间；一次性文章 URL 不单独登记 |
| QDD-MB-10 | 2026-10-29 | 国家统计局数据发布 | `https://www.stats.gov.cn/sj/zxfb/` | 从列表打开实际文章并核对发布日期、口径和正文；一次性文章 URL 不单独登记 |
| QDD-MB-11 | 2026-10-29 | Fed 会议日历 | `https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm` | 读取已确认会议日期与决议状态；美东时间换算为北京时间 |
| QDD-MB-12 | 2026-10-29 | BEA 发布日历 | `https://www.bea.gov/news/schedule` | 读取已确认的美国宏观发布日期与时间，美东时间换算为北京时间 |
| QDD-MB-13 | 2026-10-29 | 本地报告索引 | `src/data/stockReports.json` | 只读；按 `date`、`priority`、`category`、`keywords`、`slug` 做确定性匹配 |
| QDD-MB-14 | 2026-10-29 | 本地健康检查 | `http://127.0.0.1:8765/api/health` | HTTP 200 且 JSON `ok=true` |

## 新接口登记模板

```text
ID: QDD-MB-NN
最近验证: YYYY-MM-DD
用途:
入口:
请求方式与必要请求头:
日期或分页参数:
响应字段:
统计范围:
失败回退:
```
