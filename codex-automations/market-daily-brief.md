# 钱多多每日市场简报：接口阅读模式

- 原自动化 ID：`a`，状态：`PAUSED`（2026-11-11 用户授权切换）。
- 入口：`/investment/briefs`。

## 当前规则

每日市场简报入口为 `/investment/briefs`，按需读取投资科学公开 API，不调用 Serenity，也不再自行采集、整理或生成日报。日期来自源站 `/api/daily-market-analyses/dates`；正文来自 `/api/daily-market-analyses/YYYY-MM-DD` 的 `analyses`，支持早盘（morning_brief）、午盘（midday_brief）、收盘（market_overview），默认最新日期的收盘分析，可用 `?date=YYYY-MM-DD&period=midday_brief` 深链定位。正文保持源站 Markdown 内容，通过 DOMPurify 安全渲染；标注来源和北京时间发布时间，未发布或接口失败明确显示并允许重试，不用旧本地稿伪装成功。后端固定主机转发，不携带 Cookie 或凭证，仅短时内存缓存，不写账本或研究报告。Codex 任务 `a` 已暂停；`market-briefs/*.md` 保留为历史归档，原八章模板只约束历史手工稿，不约束接口原文。简报不进入报告清单、独立报告库或 GitHub Pages。

## 提示词

此任务已停用。每日市场简报已改为由钱多多应用按需读取投资科学公开日期及早盘、午盘、收盘分析接口，不再独立采集、整理、生成 Markdown、构建或自动提交推送。不要恢复定时生成；仅在用户明确要求时修改任务。

接口与字段见 `market-brief-api-catalog.md`。`market-brief-template.md` 仅用于历史手工稿，不作为接口正文的重写要求。
