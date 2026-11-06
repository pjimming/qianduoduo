# 每日市场简报接口目录

执行安排（2026-11-05）：本机 Codex 简报任务每天 18:00 触发，模型为 `gpt-6.1-sol`，推理档位为 `medium`。

运行配置以 `README.md` 与本机实际任务定义为准；供应商切换只调整任务模型，不改变本目录的数据接口和采集口径。

本文件保存钱多多 A 股收盘每日简报已验证、可复用的数据入口。任务每次运行先读取本文件；新增接口必须实际请求成功并确认响应字段后再登记，不能把搜索摘要、一次性新闻文章或猜测写成接口。

结构性亮点同时采集强势与弱势板块：涨跌幅与第三方资金流分别排序，记录同日时间戳及各自统计范围；缺失数据写“未获取到”，不得由价格反推资金流。 强势板块与弱势板块各用一张 Markdown 表格展示，固定四列为“板块｜涨跌幅｜第三方主力净流入｜净流入率”，表后保留简短解读；注明数据日期、快照时间、来源与分类口径，净流出用负号，缺失字段写“未获取到”，不同分类不得拼成同一行。强势表按东方财富完整行业样本主力净流入金额从高到低取前五，弱势表按净流出金额从大到小取前五，两表各五行；不足五个符合方向的有效样本时只列可核验项并说明缺口，不硬凑。价格与资金背离须说明。 通用模板见 `codex-automations/market-brief-template.md`，执行规则见 `codex-automations/market-daily-brief.md`。运行不读取历史成稿作为范文；先核验本轮事实再形成结构、驱动、阈值与结论。历史数值仅按需提取同口径字段并核对来源后用于比较，不载入旧标题、解释、展望或判断。自动化记忆仅保留执行状态、缺口和稳定规则，不存放市场观点。

估值参考可使用市场分析师文章、券商研报和可靠财经媒体原文，不要求官方披露。记录作者/机构、原文链接、发布日期、估值截至日、指标与分位口径；允许最近可得数据和统计口径差异，但须注明时差及“仅供参考”。一次性文章只在简报引用，不登记为可复用接口。

- 每日市场简报采用结论优先的简洁正文：每章解读尽量1—3句，保留关键数据、后续观察、必要来源与口径限制，不展示计算和取数过程；后台核验要求保持完整。

## 登记规则

- 优先记录稳定的数据接口、官方列表页、官方日历和本地确定路径；具体新闻文章只在正文引用时保留，不因一次事件写入本目录。
- URL 中的业务日期必须参数化为 `YYYY-MM-DD` 或 `YYYYMMDD`，不得把某次查询日期写成唯一入口。
- 新条目必须写明用途、请求方式与必要请求头、日期参数、响应字段、统计范围和失败回退。
- 同一主机与路径已登记时，更新“最近验证”和字段说明，不重复新增；口径变化必须保留说明。
- 不记录 Cookie、令牌、账户标识、R2 账本、账户事实、交易截图或其他私有数据。
- 本目录只服务每日市场简报任务 `a`；其每日触发、交易日判定和非交易日静默规则不随 `r2-2` 的工作日巡检及每轮报告规则变化。`r2-2` 无需用户处理时也报告巡检结果，不因此新增消息中心事项或简报接口。
- 运行中发现新接口并确认可复用后，除登记本文件外，还要在 `$CODEX_HOME/automations/a/memory.md` 写入一行摘要。

独立 R2 选品初筛由工作台调度，初筛状态只供 R2 巡检读取。

## 已验证接口

| ID | 最近验证 | 用途 | 入口与参数 | 读取说明 |
| --- | --- | --- | --- | --- |
| QDD-MB-01 | 2026-11-05 | 新浪核心指数与科创综指快照 | `https://hq.sinajs.cn/list=s_sh000001,s_sz399001,s_sz399006,s_sh000688,s_sh000300,s_sh000680`；Header `Referer: https://finance.sina.com.cn` | 名称、点位、涨跌额、涨跌幅、成交量、成交额；`s_` 汇总不带完整日期，日期另由腾讯时间戳和交易所 `TRADE_DATE` 校对 |
| QDD-MB-02 | 2026-11-05 | 腾讯指数历史与复核 | `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},day,{start},{end},{count},qfq` | `symbol` 为 `sh000001`、`sz399001`、`sz399006`、`sh000688`、`sh000300`、科创综指 `sh000680`；读取 `day` 和 `qt`，日期用 `YYYY-MM-DD` |
| QDD-MB-03 | 2026-10-29 | 上交所股票日终统计 | `https://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_SJ_GPSJ_CJGK_MRGK_C&PRODUCT_CODE=17&type=inParams&SEARCH_DATE=YYYY-MM-DD`；Header `Referer: https://www.sse.com.cn/` | `PRODUCT_CODE=17` 为股票合计，读取 `result[].TRADE_AMT`（亿元）和 `TRADE_DATE` |
| QDD-MB-04 | 2026-10-29 | 深交所证券类别统计 | `https://www.szse.cn/api/report/ShowReport/data?SHOWTYPE=JSON&CATALOGID=1803_sczm&TABKEY=tab1&txtQueryDate=YYYY-MM-DD`；Header `Referer: https://www.szse.cn/` | 读取 `data[]` 中“股票”的 `cjje`（亿元）；含存托凭证，B 股单列，ETF 在基金项下 |
| QDD-MB-05 | 2026-10-29 | 全 A 涨跌家数（备用） | `https://push2.eastmoney.com/api/qt/clist/get?pn={page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f3,f12,f14` | 单页约 100 只，按 `pn` 翻页；统计有效 `f3` 的正、负、零；含北交所和 ST，不含 B 股与 ETF。2026-10-30 连续重试仍断连，当前仅作备用 |
| QDD-MB-06 | 2026-10-29 | 涨停结构 | `https://push2ex.eastmoney.com/getTopicZTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt%3Aasc&date=YYYYMMDD` | 读取 `data.tc`；日期用 `YYYYMMDD` |
| QDD-MB-07 | 2026-10-29 | 跌停结构 | `https://push2ex.eastmoney.com/getTopicDTPool?ut=7eea3edcaed734bea9cbfc24409ed989&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fund%3Aasc&date=YYYYMMDD` | 读取 `data.tc`；日期用 `YYYYMMDD` |
| QDD-MB-08 | 2026-10-29 | 固定行业分类 | `https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php` | 解析 `S_Finance_bankuai_sinaindustry`；逗号字段索引 1 为行业名、5 为涨跌幅、7 为成交额；约 49 个宽行业，`次新股`非行业 |
| QDD-MB-09 | 2026-10-29 | 人民银行新闻列表 | `https://www.pbc.gov.cn/goutongjiaoliu/113456/113469/index.html` | 从列表打开实际文章并核对正文、发布时间；一次性文章 URL 不单独登记 |
| QDD-MB-10 | 2026-10-29 | 国家统计局数据发布 | `https://www.stats.gov.cn/sj/zxfb/` | 从列表打开实际文章并核对发布日期、口径和正文；一次性文章 URL 不单独登记 |
| QDD-MB-11 | 2026-10-29 | Fed 会议日历 | `https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm` | 读取已确认会议日期与决议状态；美东时间换算为北京时间 |
| QDD-MB-12 | 2026-10-29 | BEA 发布日历 | `https://www.bea.gov/news/schedule` | 读取已确认的美国宏观发布日期与时间，美东时间换算为北京时间 |
| QDD-MB-13 | 2026-10-29 | 本地报告索引 | `src/data/stockReports.json` | 只读；按 `date`、`priority`、`category`、`keywords`、`slug` 做确定性匹配 |
| QDD-MB-14 | 2026-10-29 | 本地健康检查 | `http://127.0.0.1:8765/api/health` | HTTP 200 且 JSON `ok=true` |
| QDD-MB-17 | 2026-10-30 | 全 A 涨跌家数（主用） | 总数：`https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hs_a`；分页：`https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page={page}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page`；Header `Referer: https://vip.stock.finance.sina.com.cn/mkt/` | 总数接口返回 JSON 字符串；分页按 `page` 从 1 取至声明总数覆盖，`num=100`，读取 `symbol`、`code`、`name`、`changepercent`、`ticktime`，按 `symbol` 去重后统计正、负、零值。`hs_a` 覆盖沪深北 A 股和 ST，不含 B 股与 ETF；快照日期须用核心指数行情时间戳复核。失败时回退 QDD-MB-05，仍失败则写“未获取到”，不按涨跌停家数推算 |
| QDD-MB-18 | 2026-11-02 | 国家统计局年度发布日历 | `https://www.stats.gov.cn/sj/fbrc/bnxxfb/` | 读取“2026年国家统计局主要统计信息发布日程表”，包括指标、月份、日期和发布时间；用于判断下一交易日是否存在已排定的例行数据发布。日程不等同于实际披露，临时公告和正文仍以 QDD-MB-10 及当日发布页核对；缺失时写“待披露”，不得据标题推断数值 |
| QDD-MB-19 | 2026-11-06 | 东方财富行业板块资金流 | `https://push2.eastmoney.com/api/qt/clist/get?pn={page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f62&fs=m:90+s:4&fields=f12,f14,f2,f3,f62,f184,f124`；Header `Referer: https://data.eastmoney.com/bkzj/hy.html` | 从 `pn=1` 翻页至覆盖 `data.total`，按实际每页条数继续请求并按 `f12` 去重核对总数；读取 `f14` 名称、`f3` 涨跌幅、`f62` 主力净流入（元）、`f184` 主力净流入率（%）、`f124` Unix 秒快照时间。样本规模以响应声明和实收完整性为准，按 `f62` 本地排序，统计净流入/净流出板块数并分别取前五。仅写“第三方估算的主力净流入”，与新浪 49 行业涨跌幅分开；`f124` 日期不等于简报日期或早于 15:00 时写“未获取到”，不得由价格、成交额或涨跌停结构反推 |
| QDD-MB-20 | 2026-11-03 | 东方财富个股与 ETF 日线成交额 | `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid={market}.{code}&klt=101&fqt=1&beg={YYYYMMDD}&end={YYYYMMDD}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57`；Header `Referer: https://quote.eastmoney.com/` | `market` 为上交所 `1`、深交所 `0`；`code` 为证券代码，日期使用 `YYYYMMDD`。读取 `data.klines`，逗号字段依次为日期、开盘、收盘、最高、最低、成交量、成交额（元）；用于核对 ETF 当日成交额及前一日变化。需与腾讯 ETF 快照金额交叉校验，单日金额不得外推为净申购或推断买方身份 |
| QDD-MB-21 | 2026-11-03 | 央广网站内搜索 | `POST https://s.cnr.cn/search`；Header `Content-Type: application/json`、`Referer: https://s.cnr.cn/` | JSON 请求体为 `{page,size,doctitle,starttime,endtime}`；`page` 从 1 开始，日期参数使用 `YYYY-MM-DD`，关键词放在 `doctitle`。响应 `sums` 为命中总数，`datas[]` 含 `docid`、`doctitle`、`crtime`、`docpubtime`、`docpuburl`、`docsourcename`、`doccontent`。标题和正文可能带高亮 HTML，使用前须清理；搜索命中不能替代打开原文 |
| QDD-MB-22 | 2026-11-03 | 新华财经指数快照 | `https://quotedata.cnfin.com/quote/v1/real?fields={fields}&en_prod_code={codes}`；Header `Referer: https://www.cnfin.com/` | `fields` 为逗号分隔字段，`en_prod_code` 为逗号分隔代码，如上证指数 `000001.SS`、深证成指 `399001.SZ`、沪深300 `000300.SS`。响应 `data.snapshot.fields` 给出列顺序，各代码值按该顺序映射；常见字段 `px_change_rate`、`px_change`、`last_px`、`prod_name`。`data_timestamp` 不是 Unix 时间戳，不能直接 `new Date()`；日期和收盘时点须由腾讯或交易所数据复核。失败时回退 QDD-MB-01/02 |
| QDD-MB-23 | 2026-11-03 | 证券时报热点行业快照 | `https://www.stcn.com/article/hot-plate.html`；Header `Referer: https://www.stcn.com/` | 无日期参数，返回实时热点快照。`state=1` 时读取 `data[].label`、`code`、`rate`（%）、`url`、`list[]`；成分股含 `label`、`rate`、`url`。接口不提供快照时间，只能与同日核心行情配合使用，不得当作历史收盘数据或资金净流入 |
| QDD-MB-24 | 2026-11-03 | 证券时报指数行情文本 | `https://www.stcn.com/public/hq.html?list={symbols}`；Header `Referer: https://www.stcn.com/` | `symbols` 为逗号分隔的 `sh000001`、`sz399001` 等。返回多个 `var hq_str_<symbol>="..."` JavaScript 文本；观测字段依次含名称、开盘、昨收、现价、最高、最低，成交额位于索引 9。无完整日期，须用腾讯或交易所数据复核；失败时回退 QDD-MB-01/02 |
| QDD-MB-25 | 2026-11-03 | 中国基金报分类文章列表 | `https://www.chnfund.com/list-category-articles?category={category_id}&pageIndex={page}&pageSize={size}`；Header `Referer: https://www.chnfund.com/` | `pageIndex` 从 1 开始，`category_id` 从目标列表页的 `var categoryId` 获取；当前 ETF 分类为 `CAe283da1a-f513-5a2c-fded-3a12edd9e690`。返回 `{list,hasMore}`，文章含 `articleID`、`title`、`publishedTime`、`summary`、`detailUrl`、`external`、`cover`、`isVipArticle`。空 `category` 返回 `null`，不能作为“最新”通用接口；须打开详情核对正文 |
| QDD-MB-26 | 2026-11-03 | 新浪财经滚动新闻 | `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid={lid}&k=&num={num}&page={page}`；Header `Referer: https://finance.sina.com.cn/` | `page` 从 1 开始，`num` 为每页条数，频道由 `lid` 指定；本次验证 `lid=2515` 为财经内容流。响应 `result.status.code=0` 时读取 `result.data[]` 的 `title`、`url`、`ctime`、`intime`、`media_name`；`ctime/intime` 为 Unix 秒。媒体稿只能作为线索，关键事实仍以原文或官方来源核对 |
| QDD-MB-27 | 2026-11-03 | 东方财富 7×24 快讯 | `https://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_{count}_{page}_.html`；Header `Referer: https://finance.eastmoney.com/` | `count` 为期望条数、`page` 从 1 开始。响应为 `<script>` 风格文本，去掉前缀 `var ajaxResult=` 后解析 JSON；读取 `LivesList[]` 的 `id`、`url_w`、`title`、`digest`、`showtime`。属于第三方快讯，不能直接替代公告或官方正文 |
| QDD-MB-28 | 2026-11-03 | 雪球批量实时行情 | 先在同一会话 `GET https://xueqiu.com/` 获取公开会话 Cookie，再 `GET https://stock.xueqiu.com/v5/stock/batch/quote.json?symbol={symbols}`；Header `Referer: https://xueqiu.com/` | `symbols` 为逗号分隔的 `SH000001,SZ399001`。响应 `data.items[].quote` 含 `symbol`、`name`、`current`、`percent`、`chg`、`timestamp`（Unix 毫秒）、`amount`、`volume` 等。会话令牌只运行时获取，不记录 Cookie；失败时回退 QDD-MB-01/02 |
| QDD-MB-29 | 2026-11-03 | 雪球 7×24 快讯 | 先在同一会话 `GET https://xueqiu.com/` 获取公开会话 Cookie，再 `GET https://xueqiu.com/statuses/livenews/list.json?count={count}&max_id={max_id}`；Header `Referer: https://xueqiu.com/` | 首次 `max_id=-1`，后续使用响应 `next_max_id`。`items[]` 含 `id`、`text`、`target`、`created_at`（Unix 毫秒）、`status_id`、`reply_count`、`share_count`；`count` 不保证严格限制返回数，应本地截断。社区快讯须回到原始公告或权威来源核验 |
| QDD-MB-30 | 2026-11-04 | 百分位网指数估值 | `GET https://baifenwei.com/index/{slug}/`；无需登录或专用请求头；`slug` 取 `hs300`、`cyb`、`kc50`；无日期参数或分页 | 读取 HTML 估值卡片的 PE/PB/PS 与历史分位，解析内嵌 `var d` JSON 的 `date`、`pe_pct`、`pb_pct`、`ps_pct`、`point`。图表为展示序列，勿据此重算完整历史分位。数据日期以最后一条有效记录为准；前值注明时差，晚于简报日或字段不符时回退其他可核验来源。11 月 4 日晚间已验证当日数据，18:00 可得性待观察。 |
| QDD-MB-31 | 2026-11-04 | 百分位网 A 股恐贪指数 | `GET https://baifenwei.com/data/fear-greed/series-full-1.json`；无需登录或专用请求头；固定近一年日序列，无日期参数或分页 | `mode=full_daily`，`points[]` 为 `[交易日期,分数]`，`generated_at` 为文件生成时间。用交易日期匹配简报日期；缺当日值则标注“未获取到”，可另列已核实的最近前值及日期。仅作站方自定义情绪指标；11 月 4 日晚间已验证，18:00 可得性待观察。 |
| QDD-MB-32 | 2026-11-05 | 央行公开市场操作公告列表 | `GET https://www.pbc.gov.cn/zhengcehuobisi/125207/125213/125431/125475/index.html`；无需专用请求头，无日期参数 | 按列表发布日期打开对应公告正文，读取发布时间、工具期限、操作利率、投标及中标量；不从标题推断金额，不以操作额代替净投放；到期量缺失时不算净投放。失败回退央行新闻列表及可核验官方原文，仍失败写“未获取到” |

| QDD-MB-33 | 2026-11-06 | 腾讯指数与 ETF 批量快照 | `GET https://qt.gtimg.cn/q={symbols}`；Header `Referer: https://gu.qq.com/`，逗号分隔市场前缀代码，无日期参数 | 按 GB18030 解码，以 `~` 分字段，索引 1/2/3/4/30/32/37 对应名称/代码/现价/昨收/北京时间 `YYYYMMDDHHmmss`/涨跌幅（%）/成交额（万元）。已验证沪深核心指数、风格指数和固定六只 ETF。盘后核对日期与快照时间，失败时回退 QDD-MB-02、20 和独立同日来源，不用于补历史快照。 |
| QDD-MB-34 | 2026-11-06 | 上交所年度休市安排 | `GET https://www.sse.com.cn/disclosure/dealinstruc/closed/`；无需专用请求头，无日期参数 | 按年份读取年度休市、恢复开市日期及周末提示，临时变化核对相关公告。失败回退交易所正式休市公告或同日官方日终统计，无法确认时跳过。 |

## 采集完整性与 Markdown 校验

- 科创综指代码为 `sh000680`，使用 QDD-MB-01/02 与其余五个指数一同采集并双源核对；不能因为早期五指数示例未列出而跳过。缺失时须实际请求并记录失败原因，再写“未获取到”。
- Markdown 加粗标签将冒号、句号放在结束标记外，例如 `**事实**：正文`；百分号结尾的加粗数字与后接中文之间加空格，例如 `**1.38%** 上涨`。采集先保存受控临时响应并完成字段投影与日期核验，再输出摘要，避免工具输出截断造成可用字段丢失；发布后清理临时响应。发布前运行 `node --test test/market-briefs.test.mjs`，检查正文没有未解析的加粗标记。

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
