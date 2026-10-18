# R2 收益账本

一个本地运行的 R2 理财每日收益记录页。前端使用 Vue 3 + Vite + TypeScript，后端继续使用 Node.js 内置 HTTP 与 SQLite。数据只保存在本机，不上传账户信息。

## 功能

- 本金作为独立账户管理：首次进入初始化起始本金，后续用转入/转出维护；每日收益记录自动读取该日适用的本金。
- 记录每日收益、操作与备注；收益表单不再要求填写本金或 R2 流动性仓。
- 自动计算日收益率、累计收益、账户净值、净值指数、最大回撤和近 7/30/90 日年化。
- 绘制累计收益曲线，以及每日收益柱状图和收益率折线；累计收益曲线不随本金变化调整。
- 自动复盘：每日显示当日本金、当日收益、月累计；月度评分与历史月份记录合并展示，按“月收益 ÷ 月均本金”自动评级。
- 支持修改、删除记录，支持导出台账 CSV。
- 每日记录支持 10/20/50/全部条数、上一页/下一页和页码快速跳转；点击日期、当日收益、日收益率、本金、账户净值表头即可切换排序和升降序。
- 展示带数据日期、来源提示和风险边界的 R2 产品观察池；默认按近 1 年收益率降序，支持按近 1/3/6/12 月收益率切换升序或降序。

## 技术栈

- Vue 3，Composition API，`<script setup lang="ts">`
- Vite + TypeScript
- Pinia
- Vue Router
- Node.js 24+、内置 `node:sqlite`

前端目录：

```text
src/
  api/            API 请求封装
  components/     页面组件
  composables/    格式化、图表布局、Toast 等复用逻辑
  router/         Vue Router
  stores/         Pinia 全局状态
  styles/         全局样式
  types/          TypeScript 类型
  views/          路由页面
```

## 启动

要求 Node.js 24 或更高版本（使用内置 `node:sqlite`）。

首次使用先安装依赖：

```powershell
npm install
```

日常直接双击 `start.bat`。脚本会自动构建前端并启动 `http://127.0.0.1:8765`，这是稳定的生产模式。

需要修改 Vue、TypeScript 或 CSS 并自动热更新时，双击 `start-dev.bat`，或运行：

```powershell
npm run dev:all
```

开发模式页面为 <http://127.0.0.1:5173>。如果 `8765` 后端尚未运行，脚本会同时用 `node --watch` 启动后端；Vue/CSS 修改由 Vite HMR 即时更新，`server.js`、`lib/` 修改会自动重启后端。

也可以手动分两个终端启动：

```powershell
# 终端 1：启动 API 和 SQLite 后端
npm run server

# 终端 2：启动 Vite 开发服务器
npm run dev
```

打开 <http://127.0.0.1:5173>。Vite 会把 `/api` 代理到 `http://127.0.0.1:8765`。手动启动后端时，`server.js` 修改后需要重启后端。

生产构建与启动：

```powershell
npm run build
npm run server
```

或使用 `npm start` 一次完成构建和服务启动。数据库文件在 `data/r2_ledger.sqlite`。

## 环境变量

复制 `.env.example` 为 `.env`，按需修改：

```dotenv
VITE_API_BASE_URL=
VITE_API_PROXY_TARGET=http://127.0.0.1:8765
```

- `VITE_API_BASE_URL`：生产环境 API 前缀；留空表示与页面同源。
- `VITE_API_PROXY_TARGET`：Vite 开发服务器的 API 代理目标。

## 已安装的 npm 包

运行时依赖：

- `vue`
- `pinia`
- `vue-router`

开发依赖：

- `vite`
- `@vitejs/plugin-vue`
- `typescript`
- `vue-tsc`
- `@types/node`

项目没有通过 CDN 引入第三方库，也没有 jQuery 插件。

## 记账口径

- `起始本金`：进入账本时已有的 R2 本金，不含累计收益和组合外应急金。
- `转入/转出`：只改变本金，不计入当日收益；系统会按日期重算历史记录中的本金快照。
- `当日本金`：起始本金 + 该日期及之前的累计转入 − 累计转出，由本金账户自动计算。
- `当日收益`：当天收益金额，亏损填负数。
- `账户净值`：当日本金 + 至今累计收益。
- `日收益率`：当日收益 ÷ 当日本金。
- `月收益率`：当月累计收益 ÷ 当月平均本金；当前未结束月份标记为“月中参考”。
- 每日记录不包含 `R2 流动性仓` / `cash_balance`。

月度评级标准：低于 0.16% 为不及格，0.16% 为及格，0.20% 为良好，0.25% 为优秀，0.30% 及以上为卓越。

页面右上角导出的 CSV 字段为 `date,principal,daily_pnl,action,notes`。技能的 `review.py` 目前还要求 `cash_balance` 列，若要用该脚本，需要先自行补一列空值。

## 产品观察池边界

产品区不是实时行情，也不是买入建议。页面按近 3/6/12 月历史年化做期限桶内排序，只用于挑出需要进一步核验的对象；没有核验费率、最大回撤、额度和赎回规则。

产品池是本地静态快照，不会自动定时更新。需要更新时，替换或修改 `data/cmb_r2_products_2026-10-18.csv`（保持原有列名），然后在页面点击“刷新快照”。这个按钮只读取本地文件，不会登录招行或抓取实时额度。

购买前必须以招行 App、产品说明书和当日公告为准。R2/PR2 不等于保本，历史年化不代表未来收益。

## 数据与接口

- `GET /api/dashboard`：记录、指标、本金账户、窗口汇总和产品观察池。
- `POST /api/capital/init`：首次初始化起始本金。
- `PUT /api/capital/init`：调整起始本金，并重算历史本金快照。
- `POST /api/capital/events`：记录转入或转出。
- `DELETE /api/capital/events/:id`：删除一笔转入或转出。
- `POST /api/products/refresh`：重新读取本地产品 CSV，替换当前产品快照。
- `POST /api/records`：新增每日记录。
- `PUT /api/records/:date`：修改指定日期记录。
- `DELETE /api/records/:date`：删除指定日期记录。
- `GET /api/export.csv`：导出台账 CSV。

服务默认只监听 `127.0.0.1`，不要把它直接暴露到公网。需要换端口时可设置 `PORT` 环境变量。

## 测试

```powershell
npm test
npm run check
```

`npm test` 覆盖 API、SQLite、本金快照、指标计算和产品排序；`npm run check` 会执行 Vue TypeScript 检查和 Node.js 语法检查。
