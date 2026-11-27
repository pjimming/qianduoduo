import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const end = '2026-11-25'
const root = process.argv[2] ?? 'D:/dfcf'
const dcaOnly = process.argv.includes('--dca')
const fundamentalOnly = dcaOnly || process.argv.includes('--fundamentals')
const combinationsOnly = process.argv.includes('--combinations')
assert(!(combinationsOnly && fundamentalOnly), 'Run --combinations separately from --fundamentals or --dca')
const longPool = ['512890', '515450', '515300', '515100']
const recentPool = ['563020', '515450', '515300', '159307']
const localCodes = ['512890', '515450', '563020']
const codes = fundamentalOnly ? ['512890', '563020', '510300'] : [...new Set([...longPool, ...recentPool, '510300'])]
const dayMs = 86_400_000
const suspension = { code: '512890', date: '2021-10-22' }

async function get(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.text()
    } catch (error) {
      if (attempt === 3) throw new Error(`Cannot read ${url}`, { cause: error })
    }
  }
}

async function publicPrices(code) {
  const market = code.startsWith('5') ? 1 : 0
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${market}.${code}&klt=101&fqt=0&beg=20190101&end=${end.replaceAll('-', '')}&lmt=4000&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57`
  const { data } = JSON.parse(await get(url))
  assert.equal(data?.code, code)
  return data.klines.map(line => {
    const [date, open, close, high, low, volume, amount] = line.split(',')
    return { date, open: +open, close: +close, high: +high, low: +low, amount: +amount, volume: +volume }
  })
}

// Eastmoney V43 stores 516-byte directory entries and 400 daily bars per block.
function readLocalPrices(buffer, code) {
  const header = 48
  const entrySize = 516
  const blockSize = 16_000
  const barsPerBlock = 400
  const blockCount = buffer.readUInt32LE(12)
  const startOfBlocks = buffer.length - blockCount * blockSize
  assert.equal(startOfBlocks, header + 20_000 * entrySize)
  assert.equal(buffer.readUInt32LE(16), barsPerBlock)
  assert.equal(buffer.readUInt16LE(30), 40)
  const entries = buffer.readUInt32LE(8)
  let entry = header
  while (entry < header + entries * entrySize && buffer.toString('ascii', entry, entry + 6) !== code) {
    entry += entrySize
  }
  assert(entry < header + entries * entrySize, `Missing local daily bars for ${code}`)
  const count = buffer.readUInt32LE(entry + 24)
  assert(count > 0 && count <= ((entrySize - 28) / 4) * barsPerBlock)
  return Array.from({ length: count }, (_, index) => {
    const block = buffer.readUInt32LE(entry + 28 + 4 * Math.floor(index / barsPerBlock))
    assert(block < blockCount, `Invalid block for ${code}`)
    const offset = startOfBlocks + block * blockSize + 40 * (index % barsPerBlock)
    const date = String(buffer.readUInt32LE(offset)).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')
    const [open, close, high, low] = [8, 12, 16, 20].map(field => +buffer.readFloatLE(offset + field).toFixed(3))
    return { date, open, close, high, low, volume: Number(buffer.readBigUInt64LE(offset + 24)), amount: buffer.readDoubleLE(offset + 32) }
  }).filter(bar => bar.date <= end)
}

async function corporateActions(code) {
  const url = `https://fundf10.eastmoney.com/fhsp_${code}.html`
  // The unparameterized 563020 page can serve 515450's dividend table under the right title.
  const html = await get(code === '563020' ? `${url}?fund=${code}` : url)
  const tables = [...html.matchAll(/<table[^>]*class=['"][^'"]*\b(?:cfxq|fhxq)\b[^'"]*['"][^>]*>[\s\S]*?<\/table>/g)]
  const dividendTable = tables.find(([table]) => table.includes('除息日'))?.[0]
  const splitTable = tables.find(([table]) => table.includes('拆分折算日'))?.[0]
  assert(dividendTable && splitTable, `Missing corporate action tables for ${code}`)
  function rows(table) {
    return [...table.matchAll(/<tbody[^>]*>([\s\S]*?)<\/tbody>/g)].flatMap(([, body]) =>
      [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
        [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(([, cell]) => cell.trim())))
  }
  const dividends = rows(dividendTable).flatMap(row => {
    if (row[0]?.includes('暂无分红')) return []
    const [, record, date, description, pay] = row
    const dividend = description?.match(/^每(\d+)份派现金([\d.]+)元$/)
    assert(dividend && date && record && pay, `Unrecognized dividend ${code}: ${row}`)
    return [{ date, dividend: +dividend[2] / +dividend[1], record, pay }]
  })
  const splits = rows(splitTable).flatMap(row => {
    if (row[0]?.includes('暂无拆分')) return []
    const [, date, , ratio] = row
    const split = ratio?.match(/^([\d.]+)\s*[:：]\s*([\d.]+)$/)
    assert(date && split, `Unrecognized split ${code}: ${row}`)
    return [{ date, split: +split[2] / +split[1] }]
  })
  const actions = [...dividends, ...splits].filter(action => action.date <= end)
  if (code === '563020') {
    assert.equal(actions.length, 10, '563020: unexpected corporate-action count through the report cutoff')
    assert(actions.some(action => action.date === '2026-09-11' && action.dividend === 0.012), '563020: missing verified 2026-09 distribution')
  }
  if (fundamentalOnly && code === '512890') assert.deepEqual(actions, [{ date: '2021-10-22', split: 2 }])
  return actions
}

function adjust(prices, actions, code) {
  const actionsByDate = new Map(actions.map(action => [
    code === suspension.code && action.date === suspension.date && action.split ? '2021-10-25' : action.date,
    action,
  ]))
  assert.equal(actionsByDate.size, actions.length, `${code} overlapping corporate actions`)
  const dates = new Set(prices.map(bar => bar.date))
  for (const date of actionsByDate.keys()) if (date >= prices[0].date) assert(dates.has(date), `${code} missing ex-date ${date}`)
  let factor = 1
  return prices.map((bar, i) => {
    assert(/^\d{4}-\d{2}-\d{2}$/.test(bar.date) && (!i || bar.date > prices[i - 1].date), `${code} unsorted date: ${bar.date}`)
    assert(bar.low > 0 && bar.low <= Math.min(bar.open, bar.close) && bar.high >= Math.max(bar.open, bar.close) && bar.volume > 0 && bar.amount > 0, `${code} invalid OHLC: ${bar.date}`)
    const { dividend = 0, split = 1 } = actionsByDate.get(bar.date) ?? {}
    // Reinvest the cash distribution at the ex-date open in the total-return series.
    factor *= split + dividend / bar.open
    const adjusted = { ...bar, o: bar.open * factor, c: bar.close * factor, h: bar.high * factor, l: bar.low * factor }
    if (i) {
      const exReference = (prices[i - 1].close - dividend) / split
      const openGap = bar.open / exReference - 1
      assert(Math.abs(openGap) < 0.15, `${code} large opening gap on ${bar.date}: ${openGap}`)
      adjusted.openGap = openGap
    }
    return adjusted
  })
}

const buffer = combinationsOnly ? null : await readFile(join(root, 'data', 'SHANGHAI', 'DayData_SH_V43.dat'))
const series = Object.fromEntries(await Promise.all(codes.map(async code => {
  if (fundamentalOnly && code === '510300') return [code, { prices: await publicPrices(code) }]
  const [online, actions] = await Promise.all([publicPrices(code), corporateActions(code)])
  const local = buffer && localCodes.includes(code)
  const raw = local ? readLocalPrices(buffer, code) : online
  if (local) {
    assert.equal(raw.length, online.length, `${code} local and public daily-bar counts differ`)
    for (const [index, bar] of raw.entries()) {
      const reference = online[index]
      for (const key of ['date', 'open', 'close', 'high', 'low']) assert.equal(bar[key], reference[key], `${code} ${bar.date} ${key}`)
    }
  }
  const prices = adjust(raw, actions, code)
  return [code, { prices, actions, source: local ? 'D:/dfcf (全样本 OHLC 与公开行情逐日核对)' : '东方财富公开不复权日线' }]
})))

const calendar = series['510300'].prices.map(bar => bar.date)
const byDate = Object.fromEntries(codes.map(code => [code, new Map(series[code].prices.map((bar, index) => [bar.date, index]))]))
for (const code of codes) {
  const missing = calendar.filter(date => date >= series[code].prices[0].date && !byDate[code].has(date))
  assert.deepEqual(missing, code === suspension.code ? [suspension.date] : [], `${code} missing dates`)
}
const lastBarIndex = (code, date) => byDate[code].get(code === suspension.code && date === suspension.date ? '2021-10-21' : date)
const equal = pool => Object.fromEntries(pool.map(code => [code, 1 / pool.length]))
const fixed = (target, interval = 1) => ({ target: () => target, monthly: true, interval })
const hold = code => ({ target: () => ({ [code]: 1 }) })

function trend(code, days, monthly = false) {
  return { monthly, target(date) {
    const close = series[code].prices
    const i = lastBarIndex(code, date)
    assert(i >= days - 1, `${code} needs ${days} trading days before ${date}`)
    const average = close.slice(i - days + 1, i + 1).reduce((sum, bar) => sum + bar.c, 0) / days
    return close[i].c > average ? { [code]: 1 } : {}
  } }
}

function pullback(code, threshold = 0.03) {
  let entered = null
  let lastSignal = -1
  return { target(date) {
    const close = series[code].prices
    const i = lastBarIndex(code, date)
    assert(i >= 19)
    if (i !== lastSignal) {
      const average = close.slice(i - 19, i + 1).reduce((sum, bar) => sum + bar.c, 0) / 20
      if (entered === null && close[i].c <= average * (1 - threshold)) entered = i
      else if (entered !== null && (close[i].c >= average || i - entered >= 20)) entered = null
      lastSignal = i
    }
    return { [code]: entered === null ? 0.8 : 1 }
  } }
}

function macd(bars) {
  let fast = bars[0].c
  let slow = fast
  let dea = 0
  return bars.map(({ c }) => {
    fast += (c - fast) * 2 / 13
    slow += (c - slow) * 2 / 27
    const dif = fast - slow
    dea += (dif - dea) * 2 / 10
    return { dif, dea }
  })
}

function kdj(bars) {
  let k = 50
  let d = 50
  return bars.map(({ c }, index) => {
    if (index >= 8) {
      const window = bars.slice(index - 8, index + 1)
      const high = Math.max(...window.map(bar => bar.h))
      const low = Math.min(...window.map(bar => bar.l))
      const rsv = high === low ? 50 : 100 * (c - low) / (high - low)
      k = (2 * k + rsv) / 3
      d = (2 * d + k) / 3
    }
    return { k, d }
  })
}

function rsi(bars) {
  const period = 14
  let averageGain = 0
  let averageLoss = 0
  return bars.map(({ c }, index) => {
    if (!index) return null
    const change = c - bars[index - 1].c
    const gain = Math.max(0, change)
    const loss = Math.max(0, -change)
    if (index <= period) {
      averageGain += gain / period
      averageLoss += loss / period
    } else {
      averageGain += (gain - averageGain) / period
      averageLoss += (loss - averageLoss) / period
    }
    if (index < period) return null
    const movement = averageGain + averageLoss
    return movement ? 100 * averageGain / movement : 50
  })
}

function weekStart(date) {
  const stamp = Date.parse(date)
  return stamp - ((new Date(stamp).getUTCDay() + 6) % 7) * dayMs
}

const weekCloses = new Set(calendar.filter((date, i) => calendar[i + 1] && weekStart(date) !== weekStart(calendar[i + 1])))

function weeklyMacd(code, bars) {
  const closingIndices = new Set([...weekCloses]
    .filter(date => date >= bars[0].date)
    .map(date => lastBarIndex(code, date)))
  const closes = bars.filter((bar, index) => closingIndices.has(index))
  const weekly = macd(closes)
  let current = -1
  return bars.map(({ date }) => {
    if (closes[current + 1]?.date === date) current++
    return current >= 25 && weekly[current].dif > weekly[current].dea
  })
}

function kdjCross(values, ceiling = 100, weeklyBullish) {
  let holding = false
  return values.map(({ k, d }, i) => {
    const previous = values[i - 1]
    if (k <= d || (weeklyBullish && !weeklyBullish[i])) holding = false
    else if (previous?.k <= previous?.d && Math.max(k, d) <= ceiling) holding = true
    return holding
  })
}

function rsiRebound(values, oversold) {
  let entered = null
  return values.map((value, i) => {
    if (value === null || values[i - 1] === null) return false
    if (entered !== null && (value >= 55 || value < oversold || i - entered >= 20)) entered = null
    else if (entered === null && values[i - 1] <= oversold && value > oversold) entered = i
    return entered !== null
  })
}

function swingRules(pool) {
  const rules = {}
  for (const code of pool) {
    const { prices } = series[code]
    const kd = kdj(prices)
    const momentum = macd(prices)
    const weekly = weeklyMacd(code, prices)
    const strength = rsi(prices)
    const signals = {
      kdj: kdjCross(kd),
      kdj20: kdjCross(kd, 20),
      kdj30: kdjCross(kd, 30),
      kdj40: kdjCross(kd, 40),
      macd: momentum.map(({ dif, dea }) => dif > dea),
      macd0: momentum.map(({ dif, dea }) => dif > dea && dif > 0),
      macdWeek: weekly,
      rsi30: rsiRebound(strength, 30),
      rsi35: rsiRebound(strength, 35),
      rsi40: rsiRebound(strength, 40),
      kdjMacdWeek: kdjCross(kd, 50, weekly),
    }
    rules[`${code}-hold`] = () => hold(code)
    rules[`${code}-cash80`] = () => fixed({ [code]: 0.8 })
    rules[`${code}-cash90`] = () => fixed({ [code]: 0.9 })
    for (const [key, active] of Object.entries(signals)) {
      const make = (floor) => () => ({ target(date) {
        const index = lastBarIndex(code, date)
        assert(index >= 26 && typeof active[index] === 'boolean', `${code} lacks swing indicator history for ${date}`)
        if (active[index]) return { [code]: 1 }
        return floor ? { [code]: floor } : {}
      } })
      rules[`${code}-${key}`] = make(0)
      rules[`${code}-${key}-core`] = make(0.8)
    }
  }
  return rules
}

function rotate(pool, days, slots = 1) {
  return { monthly: true, target(date) {
    const rank = pool.map(code => {
      const close = series[code].prices
      const i = lastBarIndex(code, date)
      assert(i >= days, `${code} needs ${days + 1} trading days before ${date}`)
      return { code, momentum: close[i].c / close[i - days].c - 1 }
    }).sort((a, b) => b.momentum - a.momentum || a.code.localeCompare(b.code))
    return equal(rank.slice(0, slots).map(item => item.code))
  } }
}

function simulate(start, finish, rule, feeBp = 8, cashRate = 0, signalDelay = 0) {
  const dates = calendar.filter(date => date >= start && date <= finish)
  assert(dates.length > 1 && dates[0] === start && dates.at(-1) === finish)
  const firstIndex = calendar.indexOf(start)
  const prior = calendar[firstIndex - 1]
  let cash = 1
  let units = {}
  let target = null
  let currentYear = ''
  let annualBase = 1
  let peak = 1
  let peakDate = dates[0]
  let maxDrawdown = { value: 0, peak: peakDate, trough: peakDate }
  let exposure = 0
  let turnover = 0
  let changes = 0
  let tickets = 0
  let fees = 0
  let smallestTradeDayAmount = Infinity
  const daily = []
  const years = {}
  const rate = feeBp / 10_000

  for (const [index, date] of dates.entries()) {
    const previous = dates[index - 1] ?? prior
    const year = date.slice(0, 4)
    const monthStart = date.slice(0, 7) !== previous.slice(0, 7)
    const scheduled = monthStart && (+date.slice(5, 7) - 1) % (rule.interval ?? 1) === 0
    const bar = code => {
      const data = series[code].prices[lastBarIndex(code, date)]
      assert(data, `${code} missing trade date ${date}`)
      return data
    }
    if (index) cash *= (1 + cashRate) ** ((Date.parse(date) - Date.parse(previous)) / dayMs / 365.25)
    const signalDate = calendar[firstIndex + index - 1 - signalDelay]
    const next = !index || !rule.monthly || scheduled ? rule.target(signalDate, date) : target
    const tradedCodes = [...new Set([...Object.keys(units), ...Object.keys(next)])]
    const canRebalance = date !== suspension.date || !tradedCodes.includes(suspension.code)
    if (canRebalance && (!index || (rule.monthly ? scheduled : JSON.stringify(next) !== JSON.stringify(target)))) {
      const openValues = Object.fromEntries(tradedCodes.map(code => [code, (units[code] ?? 0) * bar(code).o]))
      const nav = cash + Object.values(openValues).reduce((a, b) => a + b, 0)
      const tradeValue = (code, net) => net * (next[code] ?? 0) - openValues[code]
      const cost = net => tradedCodes.reduce((sum, code) => sum + Math.abs(tradeValue(code, net)) * rate, 0)
      let low = 0
      let high = nav
      for (let i = 0; i < 45; i++) {
        const mid = (low + high) / 2
        if (mid + cost(mid) > nav) high = mid
        else low = mid
      }
      const net = (high + low) / 2
      const filled = tradedCodes.filter(code => Math.abs(tradeValue(code, net)) > 1e-10)
      if (filled.length) changes++
      for (const code of filled) {
        const value = tradeValue(code, net)
        const { openGap, amount } = bar(code)
        assert(!(value > 0 && openGap >= 0.099) && !(value < 0 && openGap <= -0.099), `${code} potentially unfillable opening order ${date}`)
        tickets++
        turnover += Math.abs(value) / nav
        smallestTradeDayAmount = Math.min(smallestTradeDayAmount, amount)
      }
      fees += cost(net)
      units = Object.fromEntries(Object.entries(next).map(([code, weight]) => [code, (net * weight) / bar(code).o]))
      cash = net * (1 - Object.values(next).reduce((a, b) => a + b, 0))
      target = next
    }
    const assetValue = Object.entries(units).reduce((sum, [code, quantity]) => sum + quantity * bar(code).c, 0)
    const equity = cash + assetValue
    if (equity > peak) { peak = equity; peakDate = date }
    const drawdown = equity / peak - 1
    if (drawdown < maxDrawdown.value) maxDrawdown = { value: drawdown, peak: peakDate, trough: date }
    if (year !== currentYear) { currentYear = year; annualBase = daily.at(-1)?.equity ?? 1 }
    years[year] = equity / annualBase - 1
    exposure += assetValue / equity
    daily.push({ date, equity })
  }
  const total = daily.at(-1).equity - 1
  const elapsed = (Date.parse(dates.at(-1)) - Date.parse(dates[0])) / dayMs / 365.25
  const dailyReturns = daily.map(({ equity }, index) => equity / (daily[index - 1]?.equity ?? 1) - 1)
  const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / daily.length
  const volatility = Math.sqrt(dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (daily.length - 1) * 252)
  return { timespan: [dates[0], dates.at(-1)], days: dates.length, total, cagr: (1 + total) ** (1 / elapsed) - 1, maxDrawdown, volatility, exposure: exposure / dates.length, changes, tickets, turnover: turnover / elapsed, fees, smallestTradeDayAmount: smallestTradeDayAmount === Infinity ? null : smallestTradeDayAmount, years, daily }
}

const specs = code => ({
  hold: () => hold(code),
  'cash80': () => fixed({ [code]: 0.8 }),
  'cash85': () => fixed({ [code]: 0.85 }),
  'ma120': () => trend(code, 120),
  'ma200': () => trend(code, 200),
  'ma250': () => trend(code, 250),
  'ma200monthly': () => trend(code, 200, true),
  'dip2': () => pullback(code, 0.02),
  'dip3': () => pullback(code),
  'dip4': () => pullback(code, 0.04),
})
const baskets = pool => ({
  equal: () => fixed(equal(pool)),
  equalQuarter: () => fixed(equal(pool), 3),
  equal80: () => fixed(Object.fromEntries(pool.map(code => [code, 0.8 / pool.length]))),
  'rot63': () => rotate(pool, 63),
  'rot126': () => rotate(pool, 126),
  'rot63top2': () => rotate(pool, 63, 2),
})
const longRules = { ...baskets(longPool), benchmark: () => hold('510300') }
const recentRules = { ...baskets(recentPool), benchmark: () => hold('510300') }
for (const code of longPool) for (const [key, factory] of Object.entries(specs(code))) longRules[`${code}-${key}`] = factory
for (const code of recentPool) recentRules[`${code}-hold`] = () => hold(code)
for (const [key, factory] of Object.entries(specs('563020'))) recentRules[`563020-${key}`] = factory

function run(rules, start, finish, includeDaily = false) {
  return Object.fromEntries(Object.entries(rules).map(([name, make]) => {
    const { daily, ...base } = simulate(start, finish, make())
    const sensitivities = [20, 40].map(fee => simulate(start, finish, make(), fee).cagr)
    return [name, { ...base, sensitivities, cash15: simulate(start, finish, make(), 8, 0.015).cagr, ...(includeDaily ? { daily } : {}) }]
  }))
}

function runSwing(rules, start, finish) {
  const results = run(rules, start, finish)
  for (const [name, base] of Object.entries(results)) {
    if (name.endsWith('-hold') || /-cash\d+$/.test(name)) continue
    const code = name.split('-')[0]
    const matched = fixed({ [code]: base.exposure })
    const { cagr, maxDrawdown } = simulate(start, finish, matched)
    base.matched = { cagr, maxDrawdown }
    base.oneDayLater = simulate(start, finish, rules[name](), 8, 0, 1).cagr
  }
  return results
}

if (dcaOnly) {
  const { runDca } = await import('./dividend-low-vol-dca.mjs')
  await runDca({ get, series, end })
  process.exit(0)
}

if (fundamentalOnly) {
  const { fundamentals } = await import('./dividend-low-vol-fundamentals.mjs')
  console.log(JSON.stringify({ fundamentals: await fundamentals({ get, simulate, fixed, hold, end }) }))
  process.exit(0)
}

const longStart = '2021-08-02'

if (combinationsOnly) {
  const highPriority = ['512890', '563020', '159307', '515450']
  const proxies = {
    '563020': { code: '512890', listing: '2023-12-14', switchAt: '2024-01-02' },
    '159307': { code: '515100', listing: '2024-04-25', switchAt: '2024-07-01' },
  }
  const quarterStarts = ['01', '04', '07', '10']
  for (const [code, { listing, switchAt }] of Object.entries(proxies)) {
    assert.equal(series[code].prices[0].date, listing)
    const nextQuarter = calendar.find((date, i) => date >= listing &&
      quarterStarts.includes(date.slice(5, 7)) && date.slice(0, 7) !== calendar[i - 1]?.slice(0, 7))
    assert.equal(nextQuarter, switchAt)
  }
  const commonStart = highPriority.map(code => series[code].prices[0].date).sort().at(-1)

  function quarterlyWeights(pool, useProxies) {
    if (!useProxies) return fixed(equal(pool), 3)
    return {
      monthly: true,
      interval: 3,
      target: (_, date) => {
        const weights = {}
        for (const code of pool) {
          const proxy = proxies[code]
          const heldCode = proxy && date < proxy.switchAt ? proxy.code : code
          weights[heldCode] = (weights[heldCode] ?? 0) + 1 / pool.length
        }
        return weights
      },
    }
  }

  function result(start, rule) {
    const { daily, ...metrics } = simulate(start, end, rule)
    return { ...metrics, cagrAt20Bp: simulate(start, end, rule, 20).cagr }
  }

  const pairs = highPriority.flatMap((code, i) => highPriority.slice(i + 1).map(next => [code, next]))
  const triples = highPriority.map((_, omitted) => highPriority.filter((_, i) => i !== omitted))
  const combinations = [...pairs, ...triples].map(pool => ({
    pool,
    long: result(longStart, quarterlyWeights(pool, true)),
    common: result(commonStart, quarterlyWeights(pool, false)),
  }))
  const benchmarks = {
    fourRoutes: {
      long: result(longStart, fixed(equal(longPool), 3)),
      common: result(commonStart, fixed(equal(['512890', '159307', '515450', '515300']), 3)),
    },
    '515450': { long: result(longStart, hold('515450')), common: result(commonStart, hold('515450')) },
  }
  console.log(JSON.stringify({ proxies, combinations, benchmarks }))
  process.exit(0)
}

const laterStart = '2024-01-02'
const recentStart = '2025-01-02'
const windows = {
  full: run(longRules, longStart, end, true),
  early: run(longRules, longStart, '2023-12-29'),
  late: run(longRules, laterStart, end),
  recent: run(recentRules, recentStart, end, true),
  recentSameIndex: run({ '512890-hold': () => hold('512890'), '515100-hold': () => hold('515100') }, recentStart, end),
}

const longSwing = swingRules(longPool)
const recentSwing = swingRules(recentPool)
const swing = {
  full: runSwing(longSwing, longStart, end),
  early: runSwing(longSwing, longStart, '2023-12-29'),
  late: runSwing(longSwing, laterStart, end),
  recent: runSwing(recentSwing, recentStart, end),
}

// Independent buy-and-hold check. Only dividends earned after entry are reinvested.
function holdCheck(code, start, usePaymentDate = false) {
  const { prices, actions } = series[code]
  const from = prices[byDate[code].get(start)]
  const last = prices.at(-1)
  let shares = 1 / (from.open * 1.0008)
  for (const action of actions.filter(action => action.date > start).sort((a, b) => a.date.localeCompare(b.date))) {
    if (action.split) shares *= action.split
    else {
      const ref = prices[byDate[code].get(usePaymentDate ? action.pay : action.date)]
      assert(ref, `${code} has no reinvestment price for ${action.date}`)
      shares *= 1 + action.dividend / ref.open
    }
  }
  return shares * last.close - 1
}
const payoutSensitivity = {}
for (const [window, pool, start] of [['full', longPool, longStart], ['recent', recentPool, recentStart]]) {
  payoutSensitivity[window] = {}
  for (const code of [...pool, '510300']) {
    const strategy = code === '510300' ? 'benchmark' : `${code}-hold`
    assert(Math.abs(holdCheck(code, start) - windows[window][strategy].total) < 1e-10)
    const years = (Date.parse(end) - Date.parse(start)) / dayMs / 365.25
    payoutSensitivity[window][code] = (1 + holdCheck(code, start, true)) ** (1 / years) - 1
  }
}
const provenance = Object.fromEntries(codes.map(code => {
  const { prices, actions, source } = series[code]
  return [code, { first: prices[0].date, last: prices.at(-1).date, days: prices.length, source, actions, last20Amount: prices.slice(-20).reduce((sum, bar) => sum + bar.amount, 0) / 20 }]
}))
console.log(JSON.stringify({ provenance, windows, swing, payoutSensitivity }))
