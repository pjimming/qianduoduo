# 钱多多待办

## 已完成

- [x] 原生 Vue 重写全景图
  - 用 Vue 组件替代 `public/research/techmap/` 的 iframe 静态页面。
  - 保留脑图、树状、表格三种视图，以及搜索、缩放、折叠、打印、全屏和视图切换。
  - 保持 A 股资料与 R2 账本隔离，数据快照日期和风险边界不改变。

- [x] 调研报告 Vue 阅读器
  - 报告正文直接渲染，移除 iframe；样式按篇作用域挂载/卸载。
  - 正文全文检索、章节目录、阅读进度、回到顶部、`←/→` 切换。
  - 图片外置为独立文件并懒加载，报告 JS 块从 100–480 KB 降到 9–107 KB。

- [x] 账本与工程化加固
  - 首页加载骨架、错误态与重试；删除操作改为统一确认弹窗。
  - 每日自动备份、`db:list/backup/restore` CLI 与恢复前安全快照。
  - 写接口同源校验 + JSON Content-Type；静态资源 gzip、immutable 缓存、HEAD 和 CSP。
  - 产品快照自动选取最新 CSV；评级阈值改为后端单一来源。
  - 样式拆分为 tokens/layout/controls/capital/panels/readability/dashboard/research/report；新增 Playwright 端到端冒烟。
