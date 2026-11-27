import assert from 'node:assert/strict'

const indexEndpoint = 'https://www.csindex.com.cn/csindex-home/perf/index-perf'
const bondEndpoint = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
const dateStart = '2014-01-02'
const tradingLag = 5
const dayMs = 86_400_000

async function indexHistory(get, code, end) {
  const date = value => value.replaceAll('-', '')
  const params = new URLSearchParams({ indexCode: code, startDate: date(dateStart), endDate: date(end) })
  const { data } = JSON.parse(await get(`${indexEndpoint}?${params}`))
  assert(data?.length > 3_000, `Missing CSI ${code} history`)
  return data.map(({ tradeDate, indexCode, close, peg }) => {
    assert.equal(indexCode, code)
    assert(close > 0 && peg > 0)
    return { date: tradeDate.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'), close, pe: peg }
  })
}

async function treasuryHistory(get, end) {
  const years = Array.from({ length: +end.slice(0, 4) - 2015 + 1 }, (_, i) => 2015 + i)
  const rows = []
  for (let i = 0; i < years.length; i += 4) {
    const chunk = await Promise.all(years.slice(i, i + 4).map(async year => {
      const last = year === +end.slice(0, 4) ? end : `${year}-12-31`
      const params = new URLSearchParams({
        reportName: 'RPTA_WEB_TREASURYYIELD', columns: 'SOLAR_DATE,EMM00166466',
        pageNumber: 1, pageSize: 500, sortColumns: 'SOLAR_DATE', sortTypes: '1',
        filter: `(SOLAR_DATE>='${year}-01-01')(SOLAR_DATE<='${last}')`,
      })
      const { result, success } = JSON.parse(await get(`${bondEndpoint}?${params}`))
      assert(success && result.pages === 1 && result.data.length >= 200, `Missing China 10Y rates: ${year}`)
      return result.data.flatMap(({ SOLAR_DATE, EMM00166466 }) =>
        Number.isFinite(EMM00166466) ? [[SOLAR_DATE.slice(0, 10), EMM00166466 / 100]] : [])
    }))
    rows.push(...chunk.flat())
  }
  return new Map(rows)
}

function joinIndices(price, total, bonds) {
  assert.equal(price.length, total.length)
  const distributionPrefix = [0]
  let rate = null
  let rateDate = null
  return price.map((p, i) => {
    const last = price[i - 1]
    const t = total[i]
    assert(p.date === t.date && p.pe === t.pe && (!last || p.date > last.date), `Mismatched index on ${p.date}`)
    if (bonds.has(p.date)) {
      rate = bonds.get(p.date)
      rateDate = p.date
    }
    const payoutRatio = i ? 1 - (p.close / last.close) / (t.close / total[i - 1].close) : 0
    assert(payoutRatio >= -0.00003 && payoutRatio < 0.02, `Unexplained divergence on ${p.date}`)
    // The total- and price-index return denominators differ on cash ex-dividend dates.
    const payout = payoutRatio > 0.000003 ? payoutRatio * last.close : 0
    distributionPrefix.push(distributionPrefix.at(-1) + payout)
    const distribution = i >= 252 ? distributionPrefix[i + 1] - distributionPrefix[i + 1 - 252] : null
    const priorDistribution = i >= 504 ? distributionPrefix[i + 1 - 252] - distributionPrefix[i + 1 - 504] : null
    const freshRate = rateDate && Date.parse(p.date) - Date.parse(rateDate) <= 7 * dayMs ? rate : null
    const yieldProxy = distribution !== null ? distribution / p.close : null
    return {
      date: p.date, price: p.close, total: t.close, pe: p.pe, earningsProxy: p.close / p.pe,
      yieldProxy, rate: freshRate, carry: yieldProxy !== null && freshRate !== null ? yieldProxy - freshRate : null,
      dividendGrowth: priorDistribution > 0 ? distribution / priorDistribution - 1 : null,
    }
  })
}

function attribution(start, end) {
  const years = (Date.parse(end.date) - Date.parse(start.date)) / dayMs / 365.25
  const price = end.price / start.price
  const total = end.total / start.total
  const multiple = end.pe / start.pe
  const earnings = end.earningsProxy / start.earningsProxy
  const annual = value => value ** (1 / years) - 1
  assert(Math.abs(multiple * earnings - price) < 1e-10)
  return { start: start.date, end: end.date, total: annual(total), price: annual(price), dividends: annual(total / price), earnings: annual(earnings), multiple: annual(multiple) }
}

function buildSignals(rows) {
  const signals = new Map()
  const history = []
  const rank = (value, field) => (history.filter(row => row[field] < value).length + 0.5 * history.filter(row => row[field] === value).length) / history.length
  const snapshot = row => {
    if (row.carry === null || history.length < 36) return null
    return { ...row, peRank: rank(row.pe, 'pe'), carryRank: rank(row.carry, 'carry'), yieldRank: rank(row.yieldProxy, 'yieldProxy') }
  }
  for (const [i, row] of rows.entries()) {
    const next = rows[i + 1]
    if (!next || next.date.slice(0, 7) === row.date.slice(0, 7)) continue
    const observed = rows[i - tradingLag]
    assert(observed?.date.slice(0, 7) === row.date.slice(0, 7))
    if (observed.carry === null) continue
    const signal = snapshot(observed)
    if (signal) signals.set(row.date, signal)
    history.push(observed)
    if (history.length > 36) history.shift()
  }
  return { signals, latest: snapshot(rows.at(-1)) }
}

function weights(signal, lower = 1 / 3) {
  const upper = 1 - lower
  const { peRank, carryRank, yieldRank, dividendGrowth } = signal
  assert(dividendGrowth !== null)
  const pe = peRank <= lower ? 1 : peRank >= upper ? 0.6 : 0.8
  const carry = carryRank >= upper ? 1 : carryRank <= lower ? 0.6 : 0.8
  const income = yieldRank >= upper ? 1 : yieldRank <= lower ? 0.6 : 0.8
  const carryAndIncome = carry === income ? carry : 0.8
  const screened = carry === 1 && dividendGrowth < -0.1 ? 0.8 : carry
  const both = pe === screened ? pe : 0.8
  return { pe, carry, income, carryAndIncome, screened, both }
}

export async function loadFundamentalHistory(get, end) {
  const [price, total, bonds] = await Promise.all([
    indexHistory(get, 'H30269', end), indexHistory(get, 'H20269', end), treasuryHistory(get, end),
  ])
  const rows = joinIndices(price, total, bonds)
  assert.equal(rows.at(-1).date, end)
  return { rows, ...buildSignals(rows) }
}

export async function fundamentals({ get, simulate, fixed, hold, end, includeCurves = false }) {
  const { rows, signals, latest } = await loadFundamentalHistory(get, end)
  const rowByDate = new Map(rows.map(row => [row.date, row]))
  const settings = [
    ['full', '512890', '2019-02-01', end],
    ['early', '512890', '2019-02-01', '2022-12-30'],
    ['late', '512890', '2023-01-03', end],
    ['recent', '512890', '2025-01-02', end],
    ['lowFee', '563020', '2025-01-02', end],
  ]
  const summarize = ({ daily, ...metrics }) => metrics
  const results = Object.fromEntries(settings.map(([key, code, start, finish]) => {
    const rules = { hold: hold(code), fixed80: fixed({ [code]: 0.8 }) }
    for (const name of ['pe', 'carry', 'income', 'carryAndIncome', 'screened', 'both']) {
      for (const [suffix, lower] of [['', 1 / 3], ['20', 0.2]]) {
        rules[name + suffix] = { monthly: true, target(date) {
          const signal = signals.get(date)
          assert(signal, `Missing valuation signal for ${date}`)
          return { [code]: weights(signal, lower)[name] }
        } }
      }
    }
    return [key, Object.fromEntries(Object.entries(rules).map(([name, rule]) => {
      const { daily, ...base } = simulate(start, finish, rule)
      return [name, {
        ...base,
        ...(includeCurves && key === 'full' && ['hold', 'fixed80', 'pe', 'carry'].includes(name) ? { daily } : {}),
        cost20: simulate(start, finish, rule, 20).cagr,
        cash15: simulate(start, finish, rule, 8, 0.015).cagr,
        ...(name !== 'hold' && name !== 'fixed80' ? { matched: summarize(simulate(start, finish, fixed({ [code]: base.exposure }))) } : {}),
      }]
    }))]
  }))

  const slices = [['2019-02-01', end], ['2019-02-01', '2022-12-30'], ['2022-12-30', end], ['2024-12-31', end], ['2025-12-31', end]]
  const report = slices.map(([start, finish]) => attribution(rowByDate.get(start), rowByDate.get(finish)))
  const activeMonths = [...signals.values()].filter(signal => signal.date >= '2019-01-01')
  const blocked = activeMonths.filter(signal => weights(signal).carry === 1 && weights(signal).screened === 0.8)
  const attributionHistory = includeCurves ? rows.filter(row => row.date >= slices[0][0]) : undefined
  return { results, attribution: report, attributionHistory, latest, lastCompletedMonth: [...signals.values()].at(-1), blocked, observations: rows.length }
}
