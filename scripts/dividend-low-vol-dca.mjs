import assert from 'node:assert/strict'
import { loadFundamentalHistory } from './dividend-low-vol-fundamentals.mjs'

const DAY = 86_400_000
const YEAR = 365 * DAY
const WEEKLY = 1_000
const RESERVE = 12 * WEEKLY
const week = day => Math.floor((day + 3 * DAY) / (7 * DAY))

// With deposits only and one closing value there is at most one XIRR.
function xirr(deposits, time, value) {
  const fv = logRate => deposits.reduce((sum, [date, amount]) => sum + amount * Math.exp(logRate * (time - date) / YEAR), 0)
  if (time === deposits[0][0]) return null
  const [lastDate, lastDeposit] = deposits.at(-1)
  if (lastDate === time && value <= lastDeposit) return null
  let low = -2
  let high = 2
  while (fv(low) > value) low *= 2
  while (fv(high) < value) high *= 2
  for (let i = 0; i < 48; i++) {
    const mid = (low + high) / 2
    if (fv(mid) > value) high = mid
    else low = mid
  }
  return Math.expm1((low + high) / 2)
}

assert(Math.abs(xirr([[0, 1000], [YEAR, 1000]], 2 * YEAR, 2310) - 0.1) < 1e-12)

const rules = {
  weekly: {},
  fullBudget: { fullBudget: true },
  monthly: { monthly: true },
  earlyReserve: { earlyReserve: true },
  spreadReserve: { spreadReserve: true },
  dip: { add: ({ drawdown }) => drawdown <= -0.10 },
  dipPe: { add: ({ drawdown, valuation }) => drawdown <= -0.10 && valuation.peRank <= 0.2 },
  dipPeThird: { add: ({ drawdown, valuation }) => drawdown <= -0.10 && valuation.peRank <= 1 / 3 },
  dipPe8: { add: ({ drawdown, valuation }) => drawdown <= -0.08 && valuation.peRank <= 0.2 },
  dipPe12: { add: ({ drawdown, valuation }) => drawdown <= -0.12 && valuation.peRank <= 0.2 },
  carryBuy: { add: ({ valuation }) => valuation.carryRank >= 0.8 },
  dipCarry: { add: ({ drawdown, valuation }) => drawdown <= -0.10 && valuation.carryRank >= 0.8 },
  peSell: { sell: valuation => valuation.pe >= 9 },
  peRankSell: { sell: valuation => valuation.peRank >= 0.8 },
  yieldRankSell: { sell: valuation => valuation.yieldRank < 0.035 },
  yieldAbsSell: { sell: valuation => valuation.yieldProxy < 0.035 },
  carrySell: { sell: valuation => valuation.carryRank < 0.20 },
  target15: { target: 0.15 },
  target20: { target: 0.20 },
}
rules.dipPePeSell = { ...rules.dipPe, ...rules.peSell }
rules.dipPeTarget15 = { ...rules.dipPe, ...rules.target15 }
rules.dipPeTarget20 = { ...rules.dipPe, ...rules.target20 }
rules.carryBoth = { ...rules.carryBuy, ...rules.carrySell }

function buildInputs(prices, rows, signals) {
  let valuation
  const previousDrawdown = new Map()
  for (let i = 252; i < rows.length; i++) {
    const prior = rows[i - 1]
    const peak = Math.max(...rows.slice(i - 252, i).map(row => row.total))
    previousDrawdown.set(rows[i].date, prior.total / peak - 1)
  }
  const valuations = [...signals.entries()]
  let j = 0
  return prices.map(bar => {
    while (j < valuations.length && valuations[j][0] < bar.date) valuation = valuations[j++][1]
    assert(valuation && previousDrawdown.has(bar.date), `Missing point-in-time valuation for ${bar.date}`)
    const time = Date.parse(bar.date)
    return { ...bar, time, valuation, drawdown: previousDrawdown.get(bar.date), week: week(time), month: bar.date.slice(0, 7) }
  })
}

function simulate(bars, rule, {
  reserve = RESERVE, weeklyReserve = 0, feeBp = 8, cashRate = 0, minCommission = 0, detailed = false,
} = {}) {
  let shares = 0
  let reserves = reserve
  let regular = 0
  let proceeds = 0
  let lastValue = 0
  let nav = 1
  let peak = 1
  let drawdown = 0
  let targetWasReached = false
  let totalDeposits = 0
  let fees = 0
  let buys = 0
  let sells = 0
  let addAmount = 0
  let sellAmount = 0
  let exposure = 0
  const deposits = []
  const adds = []
  const exits = []
  const times = bars[0].time

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    const prev = bars[i - 1]
    const newWeek = !prev || prev.week !== bar.week
    const newMonth = !prev || prev.month !== bar.month
    let sellFraction = 0

    if (newMonth && shares > 0) {
      if (rule.sell?.(bar.valuation)) sellFraction = 0.025
      if (rule.target && prev.time - times >= YEAR) {
        const performance = xirr(deposits, prev.time, lastValue)
        const reached = performance !== null && performance >= rule.target
        if (reached && !targetWasReached) sellFraction = 0.5
        targetWasReached = reached
      }
    }

    if (prev && cashRate) {
      const factor = (1 + cashRate) ** ((bar.time - prev.time) / YEAR)
      reserves *= factor
      regular *= factor
      proceeds *= factor
    }
    const equityAtOpen = shares * bar.o
    const priorCapital = equityAtOpen + reserves + regular + proceeds
    const weeklyDeposit = newWeek ? WEEKLY + weeklyReserve : 0
    const deposit = weeklyDeposit + (prev ? 0 : reserve)
    if (deposit) {
      deposits.push([bar.time, deposit])
      totalDeposits += deposit
    }
    if (newWeek) {
      regular += rule.fullBudget ? weeklyDeposit : WEEKLY
      if (!rule.fullBudget) reserves += weeklyReserve
    }
    let buy = 0
    if (rule.monthly ? newMonth : newWeek) {
      buy = regular
      regular = 0
    }
    let extra = 0
    if (!prev && rule.earlyReserve) extra = reserves
    if (newWeek && rule.spreadReserve && adds.length < 60) extra = Math.min(200, reserves)
    const reservePrincipal = totalDeposits - deposits.length * WEEKLY - addAmount
    if (newWeek && rule.add?.(bar) && Math.min(reserves, reservePrincipal) >= WEEKLY) extra = WEEKLY
    if (extra > 1e-7) {
      reserves -= extra
      addAmount += extra
      buy += extra
      adds.push(bar.date)
    }

    // Offset opposite orders scheduled for the same open. A sale's retained cash is
    // measured at the simulated open; transaction costs apply only to the net order.
    const sale = equityAtOpen * sellFraction
    const order = buy - sale
    let fee = 0
    if (Math.abs(order) > 1e-7) {
      const magnitude = Math.abs(order)
      fee = Math.min(magnitude, magnitude * (feeBp - 3) / 10_000 + Math.max(minCommission, magnitude * 3 / 10_000))
      shares += (order - (order > 0 ? fee : 0)) / bar.o
      fees += fee
      if (order > 0) buys++
      else sells++
    }
    if (sale > 0) {
      proceeds += sale - (order < 0 ? fee : 0)
      sellAmount += sale
      exits.push(bar.date)
    }
    assert(shares >= -1e-9 && reserves >= -1e-9 && regular >= -1e-9 && proceeds >= -1e-9)
    const cash = reserves + regular + proceeds
    const equity = shares * bar.c
    const value = cash + equity
    const atOpen = priorCapital + weeklyDeposit
    assert(Math.abs(shares * bar.o + cash - (atOpen - fee)) < 1e-6, `Cash/units out of balance on ${bar.date}`)
    if (prev) nav *= priorCapital / lastValue
    nav *= value / atOpen
    peak = Math.max(peak, nav)
    drawdown = Math.min(drawdown, nav / peak - 1)
    exposure += equity / value
    lastValue = value
  }
  const time = bars.at(-1).time
  return {
    xirr: xirr(deposits, time, lastValue), twrAnnual: nav ** (YEAR / (time - times)) - 1,
    drawdown, close: lastValue, totalDeposits, grossGain: lastValue - totalDeposits,
    adds: adds.length, addAmount, exits: exits.length, sellAmount,
    exposure: exposure / bars.length, endCash: reserves + regular + proceeds,
    buys, sells, fees,
    ...(detailed ? { addDates: adds, exitDates: exits } : {}),
  }
}

const quantile = (values, p) => values.toSorted((a, b) => a - b)[Math.round((values.length - 1) * p)]

function rolling(bars, code, years, withReserve) {
  const comparisons = withReserve
    ? ['monthly', 'earlyReserve', 'spreadReserve', 'dip', 'dipPe', 'dipPeThird', 'carryBuy', 'dipCarry', 'dipPePeSell', 'carryBoth']
    : ['monthly', 'peSell', 'peRankSell', 'yieldRankSell', 'carrySell', 'target15', 'target20']
  const windows = []
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    if (!['01', '04', '07', '10'].includes(bar.month.slice(-2)) || bars[i - 1]?.month === bar.month) continue
    const expiry = new Date(bar.time)
    expiry.setUTCFullYear(expiry.getUTCFullYear() + years)
    if (+expiry > bars.at(-1).time) break
    const until = bars.findIndex(row => row.time >= +expiry)
    const window = bars.slice(i, until + (bars[until].time === +expiry ? 1 : 0))
    const selected = ['weekly', ...comparisons]
    const metrics = Object.fromEntries(selected.map(name => [name, simulate(window, rules[name], { reserve: withReserve ? RESERVE : 0 })]))
    windows.push({ start: bar.date, end: window.at(-1).date, metrics })
  }
  assert(windows.length)
  const baseline = windows.map(row => row.metrics.weekly.xirr)
  const relativeTo = (name, reference) => {
    const deltas = windows.map(row => row.metrics[name].xirr - row.metrics[reference].xirr)
    return {
      wins: deltas.filter(delta => delta > 1e-9).length,
      ties: deltas.filter(delta => Math.abs(delta) <= 1e-9).length,
      medianDelta: quantile(deltas, 0.5), worstDelta: Math.min(...deltas), bestDelta: Math.max(...deltas),
      active: windows.filter(row => row.metrics[name].adds || row.metrics[name].exits).length,
      medianDrawdown: quantile(windows.map(row => row.metrics[name].drawdown), 0.5),
    }
  }
  const variants = Object.fromEntries(comparisons.map(name => [name, relativeTo(name, 'weekly')]))
  const matched = withReserve ? {
    dipPeVsEarly: relativeTo('dipPe', 'earlyReserve'),
    dipPeVsSpread: relativeTo('dipPe', 'spreadReserve'),
    carryBuyVsEarly: relativeTo('carryBuy', 'earlyReserve'),
    carryBuyVsSpread: relativeTo('carryBuy', 'spreadReserve'),
  } : {}
  return {
    code, years, withReserve, count: windows.length, from: windows[0].start, to: windows.at(-1).start,
    weekly: { min: Math.min(...baseline), median: quantile(baseline, 0.5), max: Math.max(...baseline),
      medianDrawdown: quantile(windows.map(row => row.metrics.weekly.drawdown), 0.5) },
    variants, matched,
  }
}

export async function runDca({ get, series, end }) {
  const { rows, signals } = await loadFundamentalHistory(get, end)
  const bars = Object.fromEntries(['512890', '563020'].map(code => [code, buildInputs(series[code].prices, rows, signals)]))
  const settings = [
    ['full', '512890', '2019-02-01', end],
    ['early', '512890', '2019-02-01', '2022-12-30'],
    ['late', '512890', '2023-01-03', end],
    ['recent', '512890', '2025-01-02', end],
    ['recent563020', '563020', '2025-01-02', end],
  ]
  const results = Object.fromEntries(settings.map(([name, code, start, finish]) => {
    const window = bars[code].filter(bar => bar.date >= start && bar.date <= finish)
    assert.equal(window[0].date, start)
    assert.equal(window.at(-1).date, finish)
    const main = Object.fromEntries(Object.entries(rules).filter(([key]) => key !== 'fullBudget').map(([key, rule]) => [key, {
      ...simulate(window, rule, { detailed: true }),
      cost20: simulate(window, rule, { feeBp: 20 }).xirr,
      cash15: simulate(window, rule, { cashRate: 0.015 }).xirr,
    }]))
    const basic = Object.fromEntries(['weekly', 'monthly', 'peSell', 'peRankSell', 'yieldRankSell', 'yieldAbsSell', 'carrySell', 'target15', 'target20'].map(key => [
      key, {
        ...simulate(window, rules[key], { reserve: 0, detailed: true }),
        min5: simulate(window, rules[key], { reserve: 0, minCommission: 5 }).xirr,
      },
    ]))
    const budget = main.weekly.totalDeposits
    assert(Object.values(main).every(row => row.totalDeposits === budget))
    assert(Object.values(basic).every(row => row.totalDeposits === budget - RESERVE))
    const continuingReserve = Object.fromEntries(['fullBudget', 'weekly', 'dip', 'dipPe', 'carryBuy', 'dipCarry'].map(key => [
      key, simulate(window, rules[key], { reserve: 0, weeklyReserve: 200, detailed: true }),
    ]))
    assert(Object.values(continuingReserve).every(row => row.totalDeposits === (budget - RESERVE) * 1.2))
    const monthOpens = window.slice(1).filter((bar, i) => window[i].month !== bar.month)
    const triggerRange = {
      maxPe: Math.max(...monthOpens.map(row => row.valuation.pe)),
      minCarryRank: Math.min(...monthOpens.map(row => row.valuation.carryRank)),
    }
    return [name, { code, start, finish, main, basic, continuingReserve, triggerRange }]
  }))
  const roll = [3, 5].flatMap(years => [true, false].map(withReserve => rolling(bars['512890'], '512890', years, withReserve)))
  console.log(JSON.stringify({ results, roll }, null, 2))
}
