---
name: 钱多多
description: "存量 Web 界面基线，记录当前实现供审计与后续改造对照"
colors:
  paper: "#f2f4ef"
  paper-deep: "#e7ebe2"
  card: "#fffefa"
  card-soft: "#f9faf6"
  ink: "#1c2a24"
  ink-soft: "#3e4b44"
  muted: "#748078"
  muted-light: "#9ba49e"
  line: "#dde3da"
  line-strong: "#cdd5ca"
  green: "#176456"
  green-deep: "#0d3c34"
  green-soft: "#dfeee8"
  green-wash: "#eff7f2"
  accent-solid-hover: "#124b40"
  on-accent: "#f9f7ef"
  gain: "#238b63"
  gain-soft: "#dff2e8"
  loss: "#c24f43"
  loss-soft: "#f8e4df"
  amber: "#b77c2d"
  amber-soft: "#f3ead9"
  warning-ink: "#8a5c1c"
  danger-ink: "#9b3d2c"
  surface-warning: "#fbf6ea"
  surface-danger: "#fbf0ed"
  chart-axis: "#8b958e"
  chart-grid: "#e6ebe3"
  dark-paper: "#141719"
  dark-card: "#1d2225"
  dark-card-soft: "#181c1e"
  dark-ink: "#eef2f2"
  dark-muted: "#96a4a4"
  dark-line: "#2e3638"
  dark-green: "#91d5d5"
  dark-accent-solid: "#30696b"
  dark-on-accent: "#f3ffff"
  dark-gain: "#78d7a4"
  dark-loss: "#ff8b81"
  dark-amber: "#d8c18b"
  dark-chart-axis: "#899697"
typography:
  headline:
    fontFamily: 'Georgia, "Times New Roman", "Songti SC", serif'
    fontSize: "32px"
  title:
    fontFamily: '"Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", "Segoe UI", system-ui, sans-serif'
    fontSize: "19px"
    fontWeight: 650
  body:
    fontFamily: '"Microsoft YaHei UI", "PingFang SC", "Noto Sans SC", "Segoe UI", system-ui, sans-serif'
    fontSize: "15px"
    lineHeight: 1.55
  label:
    fontSize: "12px"
  screening-body:
    fontSize: "14px"
  screening-data:
    fontSize: "13px"
  numeric:
    fontFamily: '"Cascadia Mono", "SFMono-Regular", Consolas, monospace'
    fontSize: "12.5px"
rounded:
  control-small: "10px"
  control: "12px"
  md: "14px"
  lg: "20px"
  xl: "26px"
  pill: "999px"
spacing:
  gap-control: "8px"
  gap-brand: "12px"
  inset-sidebar: "16px"
  gutter-desktop: "24px"
components:
  button-primary:
    backgroundColor: "{colors.green-deep}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.control}"
    padding: "0 17px"
  button-primary-hover:
    backgroundColor: "{colors.accent-solid-hover}"
  button-primary-dark:
    backgroundColor: "{colors.dark-accent-solid}"
    textColor: "{colors.dark-on-accent}"
  button-small:
    rounded: "{rounded.control-small}"
    padding: "0 13px"
    typography: "{typography.label}"
  confirm-dialog:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.lg}"
    padding: "24px 24px 18px"
  r2-header-chip:
    backgroundColor: "{colors.card}"
    textColor: "{colors.muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 11px"
---

# Design System: 钱多多

## Overview

存量视觉可概括为纸面账簿：偏暖的浅色底、深绿操作、衬线标题、密排的数据与说明。深色主题用灰黑表面和偏青的操作色。理财以卡片、表格和状态标签组织操作，投资阅读页在共享外壳内呈现长文和各篇报告样式。

本文件记录截至 2026-11-06 的实现。前置 YAML 是已使用样式的选录，具体生效值以源码及级联为准。 [DESIGN.md 格式](https://raw.githubusercontent.com/google-labs-code/design.md/main/docs/spec.md)

缺陷见 [UI_AUDIT.md](UI_AUDIT.md)，用户确认的目标方向见 [UI_REDESIGN_PLAN.md](UI_REDESIGN_PLAN.md)。

## Colors

- **主色**来自 `--green`、`--green-deep`、`--green-soft`、`--green-wash`。导航选中、操作和提示底色使用同一色系，深色将其映射为青色系。实底动作另有 `--accent-solid` 与 `--on-accent` 语义。
- **金融与状态**由 `--gain`、`--loss`、`--amber` 及浅底配对承担。等待、告警和异常另有 `--surface-*` 与语义前景。正负方向和处理状态应保留符号或文字。市场简报、图谱与 R2 分区使用各自的专用选择器，颜色语义需按表和图例核对。
- **中性层**由 `--paper`、`--card`、`--ink`、`--muted` 和 `--line` 家族区分背景、内容和次要信息。当前浅色的淡灰文本和部分状态色需要重新配对后才能承担小号正文。
- `tokens.css` 提供基础色，`theme.css` 扩展图表、表单、状态，并在 `html[data-theme='dark']` 覆盖值和局部规则。主题支持系统、浅色、深色，首屏初始化和 Vue 中的状态同步使用同一键。 [基础变量](src/styles/tokens.css) · [主题变量](src/styles/theme.css) · [主题逻辑](src/composables/useTheme.ts) · [首屏初始化](public/theme-init.js)

## Typography

页面标题有衬线展示层，中文正文使用系统无衬线栈，部分金额、日期、代码和指标用等宽字栈。不同操作组件常见 12–15px，字号分散在组件和页面中。`main.ts` 先加载基础、控制和面板样式，再加载 `readability.css`、页面样式，最后加载 `theme.css`。组件局部样式也参与级联，单条 CSS 声明需以渲染结果核对。已复现的小字号集中于图谱与抽样报告。 [导入顺序](src/main.ts) · [层级与导航](src/styles/layout.css) · [R2 页头](src/styles/r2-pages.css) · [旧字号覆盖](src/styles/readability.css)

## Layout

桌面使用 232px 粘性侧栏与可收缩内容列，主区域最大 1440px、左右各预留约 24px。移动端以顶部栏和抽屉承载全局导航。理财常用页头、页内索引、面板及折叠区，投资区分别采用检索列表、正文阅读和图谱控制栏。

间距主要由 px 字面值决定，8/12/16/24px 是可复用的已观察尺寸，页面也有 10/14/18/22px 等取值。断点由不同样式文件各自声明，常见 1080/1040/820/760/720/620px。报告目录在 1179px 附近切换布局。宽表在本地包装容器中滚动，图谱画布为独立平移和缩放区域。 [外壳](src/styles/layout.css) · [通用响应式](src/styles/panels.css) · [报告阅读](src/styles/report.css) · [图谱](src/styles/techmap.css)

## Elevation & Depth

页面背景以径向渐变和微弱网格增加层次，侧栏有半透明背景和模糊。基础面板使用边框、柔和投影或近色填充，浅色共享投影为 `0 18px 50px rgba(33, 53, 43, 0.07)` 与 `0 8px 24px rgba(33, 53, 43, 0.045)`，深色另设阴影。确认框使用遮罩和更强的独立投影。部分按钮和导航的状态过渡约 160ms。 [基础变量](src/styles/tokens.css) · [控制样式](src/styles/controls.css) · [主题](src/styles/theme.css)

## Shapes

主操作为 12px 圆角，紧凑按钮为 10px，面板主要使用 14/20/26px 的共享半径或附近的局部值。状态胶囊与范围选择器经常用全圆角。描边与圆角在不同层级面板上重复，导致部分页面难以凭轮廓判断层级。 [圆角变量](src/styles/tokens.css) · [面板与折叠区](src/styles/r2-pages.css)

## Components

| 组件 | 现行用法和状态 | 实现位置 |
| --- | --- | --- |
| 按钮与链接动作 | 实底主按钮、描边次按钮、危险按钮、紧凑变体与行内链接式动作并存。通用按钮最小高 44px，紧凑按钮 36px，部分行内动作低于此值。 | [controls.css](src/styles/controls.css) · [review-workspace.css](src/styles/review-workspace.css) |
| 输入、筛选与日期 | 原生输入框和选择器配圆角，页面各自定义搜索栏和范围切换。图谱、研究库、消息和表格使用独立样式。 | [controls.css](src/styles/controls.css) · [research.css](src/styles/research.css) · [inbox.css](src/styles/inbox.css) |
| 导航 | 全局按理财与投资分组，标记当前路由。理财子页有页内索引，阅读页有报告切换与目录。 | [AppSidebar.vue](src/components/AppSidebar.vue) · [R2SectionIndex.vue](src/components/r2/R2SectionIndex.vue) · [ReportSwitcher.vue](src/components/report/ReportSwitcher.vue) |
| 面板与状态 | R2 页头使用摘要胶囊，区块使用面板和可展开详情；部分状态使用文字、边框与背景组合。 | [R2PageHeader.vue](src/components/r2/R2PageHeader.vue) · [r2-pages.css](src/styles/r2-pages.css) |
| 表格与图表 | 日账、交易、持仓和研究各自定义表格。概览使用 SVG 累计收益曲线、日收益柱与日收益率折线，分别有区间控件、文本摘要及浮层。轴线、网格、收益率线与零线已有主题变量，金额轴复用紧凑金额格式。 | [LedgerTable.vue](src/components/LedgerTable.vue) · [PnlChart.vue](src/components/PnlChart.vue) · [AssetChart.vue](src/components/AssetChart.vue) · [theme.css](src/styles/theme.css) |
| 确认与反馈 | 有独立确认组件与全局状态 Toast；部分流程仍用浏览器原生弹窗。 | [ConfirmDialog.vue](src/components/ConfirmDialog.vue) · [ToastBanner.vue](src/components/ToastBanner.vue) · [InboxView.vue](src/views/r2/InboxView.vue) |
| 报告正文 | 正文由已生成的报告文档和作用域化样式渲染，附目录与表格包装。正文样式与公共应用外壳分别管理。 | [ReportDocument.vue](src/components/report/ReportDocument.vue) · [report.css](src/styles/report.css) |

选品初筛使用单列批次状态、可筛选漏斗、分组表格与独立详情面板。信息正文采用 13–14px，金额、收益与日期使用表格数字对齐。页面在 1280 与 1440px 下保留列级对照，横向滚动限定在表格容器。详情由键盘进入和关闭，关闭后回到触发行。

## Do's and Don'ts

- 复用现有主题入口和操作状态，保持理财与投资的视觉基础一致。
- 区分标题、金额、口径说明和状态；保留日期、单位、符号与证据入口。
- 检查桌面浅色和深色主题，按项目规定校验字号、对比度和表格滚动。
- 避免把既有局部覆盖当作新页面的标准，尤其是低于字号下限的规则、浅底低对比文字和重复卡片边框。
- 避免仅以颜色、悬停或指针拖动呈现必需信息。
