import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const backtest = fileURLToPath(new URL('./backtest-dividend-low-vol.mjs', import.meta.url))
const report = new URL('../report/A股红利低波ETF-横向比较-2026-11-25.html', import.meta.url)
const inputs = process.argv[2]

async function read(name, ...flags) {
  if (inputs) return JSON.parse(await readFile(join(inputs, name + '.json'), 'utf8'))
  const { stdout } = await exec(process.execPath, [backtest, '--report-curves', ...flags], { maxBuffer: 8_000_000 })
  return JSON.parse(stdout)
}

const nav = await read('nav', '--product-nav')
const { fundamentals } = await read('fundamentals', '--fundamentals')
const indices = (await read('index', '--index-combinations')).market.long
const funds = await read('etf', '--combinations')
const { windows, swingCurves } = await read('base')
const dca = (await read('dca', '--dca')).results.full.basic

const channels = [
  ['512890', '中证红利低波'], ['159307', '中证红利低波100'], ['515450', '标普大盘50'],
  ['515300', '沪深300红利低波'], ['159355', '800红利低波'], ['560570', 'A500红利低波'],
  ['510300', '沪深300宽基'],
]
const routeNames = Object.fromEntries(['H30269', '930955', 'W00526', '930740', '931848', '932422'].map((key, i) => [key, channels[i][1]]))
const contribution = [
  ['全收益指数', row => row.total], ['价格指数', row => row.price],
  ['股息再投因子', row => row.total / row.price], ['隐含盈利因子', row => row.earningsProxy],
  ['PE 因子', row => row.pe],
]
const fundsByPool = new Map(funds.combinations.map(row => [row.pool.join('＋'), row.long]))
const two = '512890＋515450'
const three = '512890＋159307＋515450'
const long = windows.full
const valuation = fundamentals.results.full
const attributionRows = fundamentals.attributionHistory
const valueAt = (rows, field = 'equity', baseline = 1, scale = 100) => rows.map(row => ({ date: row.date, value: (row[field] - baseline) * scale }))
const returns = (label, rows) => ({ label, points: valueAt(rows) })
const format = (number, digits = 2) => `${number < 0 ? '−' : number > 0 ? '+' : ''}${Math.abs(number).toFixed(digits)}`
const end = series => series.points.at(-1).value
const profit = (label, key) => ({ label, points: valueAt(dca[key].daily, 'profit', 0, 1 / 10_000) })

const figures = {
  products: {
    title: '代表 ETF 累计净值回报',
    note: '六条指数路线各取一只代表产品，另列沪深300宽基。使用基金单位净值并复权现金分红。',
    series: channels.map(([code, name]) => returns(`${code} ${name}`, nav[code])),
  },
  attribution: {
    title: '中证红利低波的累计收益与复利因子',
    note: '各曲线期初归零。全收益增长倍数＝价格增长倍数×股息再投因子，价格增长倍数＝隐含盈利增长倍数×PE 变化倍数。',
    series: contribution.map(([label, measure]) => ({ label, points: attributionRows.map(row => ({
      date: row.date, value: (measure(row) / measure(attributionRows[0]) - 1) * 100,
    })) })),
  },
  indices: {
    title: '指数路线季度等权｜长样本前五与六路线基准',
    note: '按季度首个交易日收盘调仓。标普大盘50使用 515450 场内总回报替代，指数调仓未额外计交易成本。',
    series: [
      ...indices.ranked.slice(0, 5).map((row, i) => returns(`${i + 1}. ${row.pool.map(code => routeNames[code]).join('＋')}`, row.daily)),
      returns('六路线等权', indices.allSix.daily),
    ],
  },
  allocation: {
    title: 'ETF 配置与持有对照｜累计收益',
    note: '图示从期初开盘入场，按期末收盘估值，含分红再投和单边 8 bp 成本。159307 上市前以 515100 承接。',
    series: [
      returns(`两只等权 · ${two}`, fundsByPool.get(two).daily),
      returns(`三只等权 · ${three}`, fundsByPool.get(three).daily),
      returns('四路线季度等权', long.equalQuarter.daily),
      returns('515450 持有', long['515450-hold'].daily),
      returns('510300 宽基持有', long.benchmark.daily),
    ],
  },
  dca: {
    title: '512890 定投与止盈｜累计账户盈亏',
    note: '同样按周入金，均无额外备金。每日盈亏＝账户市值（含现金）减累计入金。图例为期末盈亏，资金加权年化见正文及明细。',
    unit: '万元',
    series: [profit('固定周投', 'weekly'), profit('固定月投', 'monthly'), profit('年化达 15% 卖一半', 'target15'), profit('年化达 20% 卖一半', 'target20')],
  },
  valuation: {
    title: '512890 估值调仓｜累计收益',
    note: '以同产品满仓持有和固定 80% 仓位作对照。估值信号按月观察并保留发布滞后，单边成本 8 bp。',
    series: [returns('持有满仓', valuation.hold.daily), returns('股息利差 · 两端各 1/3', valuation.carry.daily), returns('PE 分位', valuation.pe.daily), returns('固定 80% 仓位', valuation.fixed80.daily)],
  },
  swing: {
    title: '515450 RSI 机动仓｜累计收益',
    note: '以相同平均仓位的月度调仓作暴露对照，并列满仓持有。计单边 8 bp。',
    series: [returns('RSI35 机动仓', swingCurves.rsi), returns('同平均仓位固定对照', swingCurves.matched), returns('515450 持有', long['515450-hold'].daily)],
  },
}

function dateTicks(start, finish) {
  const oneYear = Date.parse(finish) - Date.parse(start) < 400 * 86_400_000
  const years = +finish.slice(0, 4) - +start.slice(0, 4)
  const between = oneYear
    ? ['02', '05', '08'].map(month => `${finish.slice(0, 4)}-${month}-01`)
    : Array.from({ length: years }, (_, i) => `${+start.slice(0, 4) + i + 1}-01-01`)
      .filter((_, i) => years <= 5 || i % 2 === 1)
  const fraction = date => (Date.parse(date) - Date.parse(start)) / (Date.parse(finish) - Date.parse(start))
  const middle = between.filter(date => fraction(date) > 0.13 && fraction(date) < 0.87)
  const short = date => date.slice(0, 7).replace('-', '.')
  const endpoint = date => oneYear ? date.slice(5).replace('-', '/') : short(date)
  return [[start, endpoint(start)], ...middle.map(date => [date, oneYear ? `${+date.slice(5, 7)}月` : date.slice(0, 4)]), [finish, endpoint(finish)]]
}

function render({ title, note, series, unit = '%' }, id) {
  const dates = series[0].points.map(({ date }) => date)
  const times = dates.map(Date.parse)
  assert(times.every((time, i) => Number.isFinite(time) && (!i || time > times[i - 1])))
  const first = times[0]
  const last = times.at(-1)
  const x = time => (time - first) / (last - first)
  const values = series.flatMap(({ points }) => points.map(({ value }) => value))
  assert(values.every(Number.isFinite) && dates.length > 1)
  const low = Math.min(0, ...values)
  const high = Math.max(0, ...values)
  const step = [2, 5, 10, 20, 25, 30, 50, 100].find(size => (high - low) / size <= 6)
  assert(step)
  const min = Math.floor(low / step) * step
  const max = Math.ceil(high / step) * step
  const y = value => (max - value) / (max - min)
  const toPercent = proportion => `${(proportion * 100).toFixed(3)}%`
  const ticks = Array.from({ length: (max - min) / step + 1 }, (_, i) => max - i * step)
  const horizontal = ticks.map(tick => `          <line class="etf-grid${tick === 0 ? ' etf-zero' : ''}" x2="2000" y1="${Math.round(y(tick) * 1000)}" y2="${Math.round(y(tick) * 1000)}"/>`).join('\n')
  const curves = series.map(({ points }, index) => {
    assert.deepEqual(points.map(({ date }) => date), dates)
    const path = points.map(({ value }, i) => `${Math.round(x(times[i]) * 2000)} ${Math.round(y(value) * 1000)}`).join(' ')
    return `          <polyline class="etf-line etf-line-${index + 1}" points="${path}"/>`
  }).reverse().join('\n')
  const yLabels = ticks.map(tick => `        <span class="etf-y" style="--at:${toPercent(y(tick))}">${format(tick, 0).replace('+', '')}${unit === '%' ? unit : ''}</span>`).join('\n')
  const xLabels = dateTicks(dates[0], dates.at(-1)).map(([date, label]) => {
    const position = x(Date.parse(date))
    const nearEdge = (position > 0 && position < 0.25) || (position > 0.75 && position < 1)
    return `        <span${nearEdge ? ' class="etf-x-edge"' : ''} style="--at:${toPercent(position)}">${label}</span>`
  }).join('\n')
  const legend = series.map((item, i) => `        <li><svg viewBox="0 0 27 12" width="27" height="12" aria-hidden="true"><line class="etf-line etf-line-${i + 1}" x1="1" y1="6" x2="26" y2="6"/></svg><span>${item.label}</span><strong>${format(end(item))}${unit}</strong></li>`).join('\n')
  return `    <figure class="etf-chart" aria-labelledby="etf-plot-${id}">
      <figcaption><strong id="etf-plot-${id}">${title}</strong><span>${dates[0]} 至 ${dates.at(-1)} · ${unit === '%' ? '累计变化' : '单位：万元'}</span></figcaption>
      <div class="etf-plot" role="img" aria-label="${title}，逐日曲线。图例列出各序列期末值。">
        <svg class="etf-plot-svg" viewBox="0 0 2000 1000" preserveAspectRatio="none" aria-hidden="true">
${horizontal}
${curves}
        </svg>
${yLabels}
      </div>
      <div class="etf-x" aria-hidden="true">
${xLabels}
      </div>
      <ul class="etf-legend" aria-label="图例与期末数值">
${legend}
      </ul>
      <p class="rp-src">${note}</p>
    </figure>`
}

let html = (await readFile(report, 'utf8')).replaceAll('\r\n', '\n')
for (const [id, figure] of Object.entries(figures)) {
  const pattern = new RegExp(`(<!-- etf-curve:${id} -->)\\n[\\s\\S]*?(    <!-- /etf-curve:${id} -->)`)
  assert(pattern.test(html), `No report marker for ${id}`)
  html = html.replace(pattern, (_, open, close) => `${open}\n${render(figure, id)}\n${close}`)
}
await writeFile(report, html)
