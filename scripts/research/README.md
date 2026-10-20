# 股票调研复用工具

本目录只保存可跨报告复用的模板、候选池和检查工具。报告专属数据仍遵循 `AGENTS.md`：

- 行情、净值、IOPV、折溢价、持仓、公告PDF、抓取缓存和带实际数字的估值JSON不长期保存。
- 单次调研使用 `tmp/research/<slug>/`；发布前清理。
- 完成后运行 `npm run research:publish`。

## 目录

```text
scripts/research/
  templates/
    dcf-company.template.json
    dcf-etf.template.json
    report-shell.template.html
    research-manifest.template.json
    sources.template.csv
  universes/
    etf-nasdaq100.json
  new-research-workdir.ps1
  invoke-research-checks.ps1
  cleanup-research-workdir.ps1
```

## 推荐流程

1. 建立单次临时目录：

```powershell
pwsh -NoProfile -File scripts/research/new-research-workdir.ps1 `
  -Slug "宁德时代-300750-2026-10-21" -Kind company
```

ETF或主题调研使用 `-Kind etf` 或 `-Kind theme`，会复制 ETF 估值模板。主题中的核心公司仍可按公司模板另建配置。

2. 在 `tmp/research/<slug>/assignments.json` 填入本次假设；在 `manifest.json` 记录研究范围、数据截止、来源和检查状态。

3. 运行估值与质量检查：

```powershell
pwsh -NoProfile -File scripts/research/invoke-research-checks.ps1 `
  -Report "report/标的或主题-日期.html" `
  -Assumptions "tmp/research/<slug>/assignments.json" `
  -Industry capital-markets,hardware
```

行业参数按 Equity Research 附录 slug 填写；ETF、指数和跨行业主题可以传多个。脚本会先运行 `dcf.py`，再运行 `check_research_output.py`，并检查HTML静态约束。

4. 报告附录更新后，删除单次工作目录：

```powershell
pwsh -NoProfile -File scripts/research/cleanup-research-workdir.ps1 `
  -Slug "<slug>"
```

5. 重新发布：

```powershell
npm run research:publish
```

## 保存边界

可以长期保存：

- DCF字段结构、公式配置和通用情景骨架。
- HTML章节、样式、目录和导航壳。
- 候选池身份信息：代码、名称、跟踪指数、交易所、管理人、资料来源。
- 数据源登记表格式、检查清单和工具脚本。

必须按次删除：

- 实际估值数字、WACC情景、财务CSV和脚本终端输出。
- 市场行情、IOPV、折溢价、份额、规模、持仓与申赎状态快照。
- 下载的PDF、网页正文、截图、OCR结果和任何抓取缓存。
- Markdown草稿和临时HTML片段。

候选池中的管理人或资料来源变更时应更新 `lastVerified`，不能把旧值继续当作当前事实。
