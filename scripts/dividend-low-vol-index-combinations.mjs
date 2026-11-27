import assert from 'node:assert/strict'

const csiTotalReturn = [
  ['H30269', 'H20269'],
  ['930955', 'H20955'],
  ['930740', 'H20740'],
  ['931848', '931848CNY010'],
  ['932422', '932422CNY010'],
]
const commonStart = '2025-04-09'
const spRoute = 'W00526'
const spProxy = '515450'
const dayMs = 86_400_000
const quarterStartMonths = ['01', '04', '07', '10']

async function indexPrices(get, code, start, end) {
  const params = new URLSearchParams({ indexCode: code, startDate: start.replaceAll('-', ''), endDate: end.replaceAll('-', '') })
  const { data } = JSON.parse(await get('https://www.csindex.com.cn/csindex-home/perf/index-perf?' + params))
  assert(data?.length > 0 && data.every(row => row.indexCode === code), 'Missing CSI history for ' + code)
  return data.map(({ tradeDate, close }) => ({
    date: tradeDate.replace(/^(\d{4})(\d\d)(\d\d)$/, '$1-$2-$3'),
    close: Number(close),
  }))
}

function navPrices(script) {
  assert.equal(script.match(/var fS_code\s*=\s*"(\d+)"/)?.[1], spProxy)
  const rows = JSON.parse(script.match(/var Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/)?.[1] ?? '[]')
  return rows.map(row => ({
    date: new Date(row.x + 8 * 3_600_000).toISOString().slice(0, 10),
    close: row.y,
  }))
}

function reinvest(prices, actions) {
  const byDate = new Map(actions.map(action => [action.date, action]))
  assert.equal(byDate.size, actions.length, 'Concurrent 515450 corporate actions require review')
  const dates = new Set(prices.map(row => row.date))
  for (const { date } of actions) assert(dates.has(date), 'Missing 515450 ex-date ' + date)
  let units = 1
  return prices.map(({ date, close }) => {
    const { dividend = 0, split = 1 } = byDate.get(date) ?? {}
    units *= split + dividend / close
    return { date, close: close * units }
  })
}

function alignedLevels(series, calendar, label) {
  assert.deepEqual(series.map(row => row.date), calendar, 'Misaligned trading dates for ' + label)
  assert(series.every(row => Number.isFinite(row.close) && row.close > 0), 'Invalid closing levels for ' + label)
  return new Map(series.map(row => [row.date, row.close]))
}

function backtest(levels, pool, dates, includeCurves) {
  let holdings = pool.map(() => 1 / pool.length)
  let equity = 1
  let peak = 1
  let maxDrawdown = 0
  const daily = includeCurves ? [{ date: dates[0], equity }] : null
  for (let i = 1; i < dates.length; i++) {
    const prior = dates[i - 1]
    const date = dates[i]
    for (const [j, code] of pool.entries()) {
      const prices = levels.get(code)
      holdings[j] *= prices.get(date) / prices.get(prior)
    }
    equity = holdings.reduce((sum, value) => sum + value, 0)
    daily?.push({ date, equity })
    peak = Math.max(peak, equity)
    maxDrawdown = Math.min(maxDrawdown, equity / peak - 1)
    const month = date.slice(0, 7)
    if (month !== prior.slice(0, 7) && quarterStartMonths.includes(month.slice(5))) {
      holdings.fill(equity / pool.length)
    }
  }
  const years = (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / dayMs / 365.25
  return { pool, total: equity - 1, cagr: equity ** (1 / years) - 1, maxDrawdown, ...(daily ? { daily } : {}) }
}

function combinations(routes, size) {
  if (!size) return [[]]
  return routes.flatMap((code, i) => combinations(routes.slice(i + 1), size - 1).map(rest => [code, ...rest]))
}

export async function runIndexCombinations({ get, publicPrices, corporateActions, start, end, includeCurves = false }) {
  const [indices, traded, navScript, distributions] = await Promise.all([
    Promise.all(csiTotalReturn.map(async ([code, variant]) => [code, await indexPrices(get, variant, start, end)])),
    publicPrices(spProxy),
    get('https://fund.eastmoney.com/pingzhongdata/' + spProxy + '.js'),
    corporateActions(spProxy),
  ])
  const calendar = indices[0][1].map(row => row.date)
  assert.equal(calendar[0], start)
  assert.equal(calendar.at(-1), end)
  assert(calendar.every((date, i) => !i || date > calendar[i - 1]))
  const sessions = new Set(calendar)
  const actions = distributions.filter(action => action.date > start)
  const marketSeries = reinvest(traded.filter(row => row.date >= start), actions)
  const navSeries = reinvest(navPrices(navScript).filter(row => sessions.has(row.date)), actions)
  const official = new Map(indices.map(([code, prices]) => [code, alignedLevels(prices, calendar, code)]))
  const routes = [...official.keys(), spRoute]
  const pools = [...combinations(routes, 2), ...combinations(routes, 3)]
  assert.equal(pools.length, 35)

  function rank(proxyPrices, firstDate, includeDaily = false) {
    const levels = new Map(official).set(spRoute, alignedLevels(proxyPrices, calendar, spProxy))
    const window = calendar.filter(date => date >= firstDate)
    assert.equal(window[0], firstDate)
    const ranked = pools.map(pool => backtest(levels, pool, window)).sort((a, b) => b.cagr - a.cagr)
    if (includeDaily) ranked.splice(0, 5, ...ranked.slice(0, 5).map(row => backtest(levels, row.pool, window, true)))
    return { start: firstDate, end, sessions: window.length, ranked, allSix: backtest(levels, routes, window, includeDaily) }
  }

  return {
    sources: { csiTotalReturn: Object.fromEntries(csiTotalReturn), spRoute, spProxy },
    market: { long: rank(marketSeries, start, includeCurves), common: rank(marketSeries, commonStart) },
    nav: { long: rank(navSeries, start), common: rank(navSeries, commonStart) },
  }
}
