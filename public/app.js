'use strict';

const state = {
  dashboard: null,
  ranges: { assets: 30, pnl: 30 },
  editingDate: null,
  ledgerPage: 1,
  ledgerPageSize: 10,
  ledgerSort: { key: 'date', direction: 'desc' },
  reviewMonth: null,
  productSort: { key: 'return_1y', direction: 'desc' },
  productTermFilter: 'all',
  capitalEventType: 'deposit',
  capitalDialogMode: 'init',
  capitalPromptShown: false,
  toastTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const SVG_NS = 'http://www.w3.org/2000/svg';
const DAY_MS = 24 * 60 * 60 * 1000;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function dateMs(value) {
  return Date.parse(`${value}T00:00:00Z`);
}

function normalizeNumber(value) {
  return Math.abs(value) < 0.000000001 ? 0 : value;
}

function formatMoney(value, digits = 2) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(normalizeNumber(number));
}

function formatSignedMoney(value, digits = 2) {
  const number = normalizeNumber(Number(value) || 0);
  const prefix = number > 0 ? '+' : number < 0 ? '−' : '';
  return `${prefix}¥${formatMoney(Math.abs(number), digits)}`;
}

function formatPct(value, digits = 2, signed = false) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const number = normalizeNumber(Number(value));
  const prefix = signed && number > 0 ? '+' : number < 0 ? '−' : '';
  return `${prefix}${Math.abs(number).toFixed(digits)}%`;
}

function formatPp(value, digits = 2, signed = false) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const number = normalizeNumber(Number(value));
  const prefix = signed && number > 0 ? '+' : number < 0 ? '−' : '';
  return `${prefix}${Math.abs(number).toFixed(digits)}pp`;
}

function formatCompactMoney(value) {
  const number = Number(value) || 0;
  const absolute = Math.abs(number);
  if (absolute >= 1e8) return `${(number / 1e8).toFixed(2)}亿`;
  if (absolute >= 1e4) return `${(number / 1e4).toFixed(1)}万`;
  if (absolute >= 1e3) return `${(number / 1e3).toFixed(1)}千`;
  return number.toFixed(0);
}

function formatAxisPct(value) {
  const absolute = Math.abs(value);
  if (absolute > 0 && absolute < 0.01) return `${value.toFixed(4)}%`;
  if (absolute < 1) return `${value.toFixed(3)}%`;
  return `${value.toFixed(2)}%`;
}

function formatDateCN(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatDateShort(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(`${value}T00:00:00Z`))
    .replaceAll('/', '.');
}

function formatAxisDate(value, spanDays) {
  const date = new Date(`${value}T00:00:00Z`);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  if (spanDays > 330) {
    return `${String(date.getUTCFullYear()).slice(2)}/${month}`;
  }
  return `${month}/${day}`;
}

function formatTerm(termDays, bucket) {
  if (termDays === 0) return '日开';
  if (termDays === null || termDays === undefined) return bucket === 'long' ? '长期' : '期限未定';
  return `${termDays}天`;
}

function bucketLabel(bucket) {
  if (bucket === 'short') return '短期限';
  if (bucket === 'medium') return '中期限';
  if (bucket === 'long') return '长期限';
  return '观察';
}

function applyTone(element, value) {
  element.classList.remove('positive', 'negative', 'neutral');
  const number = Number(value);
  if (number > 0) element.classList.add('positive');
  else if (number < 0) element.classList.add('negative');
  else element.classList.add('neutral');
}

function rangeRecords(records, range) {
  if (!records.length || range === 'all') return records;
  const days = Number(range);
  const last = dateMs(records.at(-1).date);
  const cutoff = last - (days - 1) * DAY_MS;
  const selected = records.filter((record) => dateMs(record.date) >= cutoff);
  return selected.length ? selected : records.slice(-1);
}

function periodReturn(records) {
  if (!records.length) return 0;
  return records.reduce((nav, record) => nav * (1 + record.daily_return), 1) - 1;
}

function apiRequest(url, options = {}) {
  return fetch(url, {
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  }).then(async (response) => {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      throw new Error(payload?.error || `请求失败（${response.status}）`);
    }
    return payload;
  });
}

function showToast(message, options = {}) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('is-error', Boolean(options.error));
  toast.classList.add('is-visible');
  window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(() => {
    toast.classList.remove('is-visible');
  }, options.duration || 3400);
}

async function loadDashboard() {
  try {
    const payload = await apiRequest('/api/dashboard');
    state.dashboard = payload;
    renderDashboard();
    setFormMode(null);
  } catch (error) {
    showToast(error.message || '读取数据失败', { error: true, duration: 6000 });
  }
}

function renderDashboard() {
  renderHeaderMeta();
  renderSummary();
  renderCapital();
  renderCharts();
  renderReview();
  renderWatchlist();
  renderLedger();
  renderProductTable();
  renderTodayNotice();
}

function renderHeaderMeta() {
  const { meta } = state.dashboard;
  $('#heroDate').textContent = formatDateCN(meta.today);
  $('#recordDate').max = meta.today;
}

function renderSummary() {
  const { summary, windows, records, meta } = state.dashboard;
  const hasRecords = records.length > 0;
  const last = records.at(-1);

  $('#statNetValue').textContent = hasRecords ? `¥${formatMoney(summary.latest_net_value)}` : '—';
  $('#netValueDate').textContent = hasRecords ? formatDateShort(summary.last_date) : '最新';
  $('#statNetSub').textContent = hasRecords
    ? `本金 ¥${formatMoney(summary.latest_principal)} · 累计 ${formatSignedMoney(summary.latest_cumulative_pnl)}`
    : '本金 + 累计收益';

  $('#statTotalPnl').textContent = hasRecords ? formatSignedMoney(summary.total_pnl) : '—';
  applyTone($('#statTotalPnl'), summary.total_pnl);
  $('#statPnlSub').textContent = hasRecords
    ? `${summary.calendar_days} 天 · ${summary.record_count} 条记录 · ${formatPct(summary.period_return_pct, 3, true)}`
    : '记录期累计';

  $('#statDailyPnl').textContent = hasRecords ? formatSignedMoney(summary.latest_daily_pnl) : '—';
  applyTone($('#statDailyPnl'), summary.latest_daily_pnl);
  $('#statDailySub').textContent = hasRecords
    ? `${formatDateShort(last.date)} · 日收益率 ${formatPct(summary.latest_daily_return * 100, 4, true)}`
    : '等待第一条记录';

  const window30 = windows['30'];
  const annualized = window30.annualized_pct;
  $('#statAnnualized').textContent =
    annualized === null ? '—' : formatPct(annualized, 2, true);
  applyTone($('#statAnnualized'), annualized);
  if (annualized === null) {
    $('#statAnnualizedSub').textContent = '至少需要两天记录';
  } else if (window30.target_gap_pct === null) {
    $('#statAnnualizedSub').textContent = '近 30 日 · 样本不足';
  } else {
    $('#statAnnualizedSub').textContent = `近 30 日 · 距 3% ${formatPp(
      window30.target_gap_pct,
      2,
      true,
    )}`;
  }

  $('#statDrawdown').textContent = hasRecords
    ? formatPct(summary.max_drawdown_pct, 4)
    : '—';
  applyTone($('#statDrawdown'), summary.max_drawdown_pct);
  $('#statDrawdownSub').textContent = hasRecords
    ? `负收益 ${summary.negative_days}/${summary.record_count} 天 · 最差 ${formatSignedMoney(
        summary.worst_day,
      )}`
    : '按日收益复利净值计算';

  const targetAnnualized = summary.annualized_pct;
  $('#targetAnnualized').textContent =
    targetAnnualized === null ? '—' : formatPct(targetAnnualized, 2, true);
  $('#targetStatus').textContent = summary.target_status;
  const barValue =
    targetAnnualized === null ? 0 : Math.max(0, Math.min(100, (targetAnnualized / 3) * 100));
  $('#targetBar').style.width = `${barValue}%`;

  if (!hasRecords) {
    $('#targetHint').textContent = '记录满 28 天、20 条后，年化与目标差距才具参考意义。';
  } else if (summary.record_count < 2) {
    $('#targetHint').textContent = '已经记下第一天。再记录一天后，就能看到年化参考值。';
  } else if (!summary.sample_sufficient) {
    $('#targetHint').textContent = `已记录 ${summary.calendar_days} 天 / ${summary.record_count} 条；满 28 天后，目标差距更适合做判断。`;
  } else if (summary.target_gap_pct !== null && summary.target_gap_pct >= 0) {
    $('#targetHint').textContent = `记录期年化高于 3% 目标 ${formatPp(
      summary.target_gap_pct,
      2,
      true,
    )}，仍需同时看回撤和流动性。`;
  } else if (summary.target_gap_pct !== null) {
    $('#targetHint').textContent = `距 3% 目标还差 ${formatPp(
      Math.abs(summary.target_gap_pct),
      2,
    )}；不要用杠杆或短期年化补缺口。`;
  }

  renderSparkline(records);
  void meta;
}

function renderSparkline(records) {
  const svg = $('#netSparkline');
  const values = records.slice(-24).map((record) => record.net_value);
  if (values.length < 2) {
    svg.innerHTML = '';
    return;
  }
  const width = 180;
  const height = 44;
  const padding = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(max * 0.001, 1);
  const points = values.map((value, index) => {
    const x = padding + (index / (values.length - 1)) * (width - padding * 2);
    const y = height - padding - ((value - min) / span) * (height - padding * 2);
    return { x, y };
  });
  const line = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`)
    .join(' ');
  const area = `${line} L${points.at(-1).x.toFixed(1)},${height} L${points[0].x.toFixed(
    1,
  )},${height} Z`;
  svg.innerHTML = `
    <defs>
      <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2d8069" stop-opacity=".24"></stop>
        <stop offset="100%" stop-color="#2d8069" stop-opacity="0"></stop>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#sparkFill)"></path>
    <path d="${line}" fill="none" stroke="#176456" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
    <circle cx="${points.at(-1).x.toFixed(1)}" cy="${points.at(-1).y.toFixed(
      1,
    )}" r="2.6" fill="#176456" stroke="#fffefa" stroke-width="1.2"></circle>
  `;
}

function getCapitalState() {
  return (
    state.dashboard?.capital || {
      initialized: false,
      initial_principal: null,
      initial_date: null,
      current_principal: 0,
      total_deposits: 0,
      total_withdrawals: 0,
      events: [],
    }
  );
}

function principalForDate(date) {
  const capital = getCapitalState();
  if (!capital.initialized || !date || date < capital.initial_date) return null;
  let principal = Number(capital.initial_principal);
  for (const event of capital.events || []) {
    if (event.date > date) break;
    principal += event.type === 'deposit' ? event.amount : -event.amount;
  }
  return Math.round((principal + Number.EPSILON) * 100) / 100;
}

function updateCapitalEventType(type) {
  state.capitalEventType = type === 'withdraw' ? 'withdraw' : 'deposit';
  $('#capitalEventType').value = state.capitalEventType;
  $$('.capital-type-switch button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.capitalType === state.capitalEventType);
  });
  $('#capitalEventSubmit').textContent =
    state.capitalEventType === 'deposit' ? '记录转入' : '记录转出';
}

function renderCapitalEvents(events) {
  const list = $('#capitalEventList');
  const ordered = [...events].reverse();
  $('#capitalEventCount').textContent = `${events.length} 笔`;
  $('#capitalHistoryEmpty').hidden = events.length > 0;
  list.innerHTML = ordered
    .map((event) => {
      const deposit = event.type === 'deposit';
      return `
        <li class="capital-event-item">
          <span class="capital-event-icon ${deposit ? '' : 'is-withdraw'}">${deposit ? '↗' : '↙'}</span>
          <div class="capital-event-main">
            <strong>${deposit ? '转入' : '转出'} ¥${formatMoney(event.amount)}</strong>
            <span title="${escapeHtml(event.note)}">${escapeHtml(event.date)}${
              event.note ? ` · ${escapeHtml(event.note)}` : ''
            }</span>
          </div>
          <span class="capital-event-after" title="变动后本金">余 ¥${formatMoney(
            event.principal_after ?? 0,
          )}</span>
          <button
            class="icon-button is-danger"
            type="button"
            data-capital-delete="${event.id}"
            aria-label="删除 ${escapeHtml(event.date)} 的${deposit ? '转入' : '转出'}记录"
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M4 6h12M8 3.5h4M6 6l.7 10h6.6L14 6M8.2 9v4.2M11.8 9v4.2" />
            </svg>
          </button>
        </li>
      `;
    })
    .join('');
}

function renderCapital() {
  const { meta } = state.dashboard;
  const capital = getCapitalState();
  const initialized = Boolean(capital.initialized);
  $('#capitalCurrent').textContent = initialized
    ? `¥${formatMoney(capital.current_principal)}`
    : '—';
  $('#capitalBreakdown').textContent = initialized
    ? `起始 + 转入 − 转出 · 截至 ${capital.as_of || meta.today}`
    : '等待初始化本金账户';
  $('#capitalInitial').textContent = initialized
    ? `¥${formatMoney(capital.initial_principal)}`
    : '—';
  $('#capitalDeposits').textContent = initialized
    ? `+¥${formatMoney(capital.total_deposits)}`
    : '—';
  $('#capitalWithdrawals').textContent = initialized
    ? `−¥${formatMoney(capital.total_withdrawals)}`
    : '—';
  $('#capitalUninitialized').hidden = initialized;
  $('#editCapitalInit').textContent = initialized ? '调整起始' : '初始化本金';

  const eventForm = $('#capitalEventForm');
  $$('input, button', eventForm).forEach((control) => {
    control.disabled = !initialized;
  });
  const eventDate = $('#capitalEventDate');
  eventDate.max = meta.today;
  eventDate.min = initialized ? capital.initial_date : '';
  if (initialized && !eventDate.value) eventDate.value = meta.today;
  updateCapitalEventType(state.capitalEventType);
  renderCapitalEvents(capital.events || []);
  updatePreview();

  if (!initialized && !state.capitalPromptShown) {
    state.capitalPromptShown = true;
    window.setTimeout(() => {
      if (!getCapitalState().initialized && !$('#capitalInitDialog').open) {
        openCapitalInitDialog('init');
      }
    }, 240);
  }
}

const GRADE_CLASS_MAP = {
  不及格: 'grade-fail',
  及格: 'grade-pass',
  良好: 'grade-good',
  优秀: 'grade-excellent',
  卓越: 'grade-outstanding',
};

function applyGradeBadge(element, grade) {
  element.classList.remove(
    'grade-fail',
    'grade-pass',
    'grade-good',
    'grade-excellent',
    'grade-outstanding',
  );
  element.textContent = grade || '—';
  const gradeClass = GRADE_CLASS_MAP[grade];
  if (gradeClass) element.classList.add(gradeClass);
}

function nextGradeMessage(returnPct) {
  if (!Number.isFinite(returnPct)) return '还没有足够的月度数据。';
  const levels = [
    [0.16, '及格'],
    [0.20, '良好'],
    [0.25, '优秀'],
    [0.30, '卓越'],
  ];
  for (const [threshold, grade] of levels) {
    if (returnPct < threshold) {
      return `距${grade}档还差 ${(threshold - returnPct).toFixed(3)} 个百分点`;
    }
  }
  return '已达到最高档，继续保持节奏。';
}

function renderReview() {
  const review = state.dashboard.review;
  const daily = review?.daily;
  const history = review?.monthly || [];
  if (state.reviewMonth && !history.some((item) => item.month === state.reviewMonth)) {
    state.reviewMonth = null;
  }
  const monthly = state.reviewMonth
    ? history.find((item) => item.month === state.reviewMonth) || null
    : review?.current_month || history[0] || null;
  const hasData = Boolean(daily && monthly);

  $('#dailyReviewDate').textContent = daily ? formatDateCN(daily.date) : '—';
  $('#dailyReviewPnl').textContent = daily ? formatSignedMoney(daily.daily_pnl) : '—';
  applyTone($('#dailyReviewPnl'), daily?.daily_pnl ?? 0);
  $('#dailyReviewRate').textContent = daily
    ? `当日收益率 ${formatPct(daily.daily_return_pct, 4, true)}`
    : '等待第一条记录';
  $('#dailyReviewPrincipal').textContent = daily ? `¥${formatMoney(daily.principal)}` : '—';
  $('#dailyReviewMonthPnl').textContent = daily
    ? formatSignedMoney(daily.month_pnl)
    : '—';
  applyTone($('#dailyReviewMonthPnl'), daily?.month_pnl ?? 0);
  $('#dailyReviewMonthReturn').textContent = daily
    ? formatPct(daily.month_return_pct, 3, true)
    : '—';
  applyGradeBadge($('#dailyReviewGrade'), daily?.month_grade);
  $('#dailyReviewProvisional').textContent = daily?.provisional ? '月中参考' : '';

  const monthSelect = $('#reviewMonthSelect');
  monthSelect.innerHTML = history.length
    ? history
        .map(
          (item) =>
            `<option value="${escapeHtml(item.month)}">${escapeHtml(item.month_label)} · ${escapeHtml(
              item.grade,
            )}${item.provisional ? '（月中）' : ''}</option>`,
        )
        .join('')
    : '<option value="">暂无记录</option>';
  monthSelect.disabled = history.length === 0;
  if (monthly) monthSelect.value = monthly.month;
  $('#monthlyReviewReturn').textContent = monthly
    ? formatPct(monthly.return_pct, 3, true)
    : '—';
  applyTone($('#monthlyReviewReturn'), monthly?.return_pct ?? 0);
  applyGradeBadge($('#monthlyReviewGrade'), monthly?.grade);
  $('#monthlyReviewNext').textContent = monthly
    ? nextGradeMessage(monthly.return_pct)
    : '记录收益后自动生成月度评分。';
  $('#monthlyReviewPnl').textContent = monthly ? formatSignedMoney(monthly.pnl) : '—';
  $('#monthlyReviewPrincipal').textContent = monthly
    ? `¥${formatMoney(monthly.avg_principal)}`
    : '—';
  $('#monthlyReviewDays').textContent = monthly ? `${monthly.record_days} 天` : '—';
  $$('#gradeSteps span').forEach((step) => {
    step.classList.toggle('is-current', step.dataset.grade === monthly?.grade);
  });

  $('#reviewHistoryCount').textContent = `${history.length} 个月`;
  $('#reviewHistoryEmpty').hidden = history.length > 0;
  $('#reviewHistoryList').innerHTML = history
    .map(
      (item) => `
        <div
          class="review-history-row ${item.is_current ? 'is-current' : ''} ${
            monthly?.month === item.month ? 'is-selected' : ''
          }"
          data-review-month="${escapeHtml(item.month)}"
          role="button"
          tabindex="0"
        >
          <div class="review-history-main">
            <strong>${escapeHtml(item.month_label)}</strong>
            <span>${item.record_days} 天 · 月均 ¥${formatMoney(item.avg_principal)}</span>
          </div>
          <div class="review-history-value">
            <strong>${formatSignedMoney(item.pnl)}</strong>
            <span>${formatPct(item.return_pct, 3, true)}</span>
          </div>
          <span class="grade-badge ${GRADE_CLASS_MAP[item.grade] || ''}">${escapeHtml(
            item.grade,
          )}</span>
        </div>
      `,
    )
    .join('');

  if (!hasData) {
    $('#dailyReviewDate').textContent = '暂无记录';
    monthSelect.value = '';
  }
}

function niceStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(rawStep));
  const error = rawStep / power;
  let factor = 10;
  if (error <= 1) factor = 1;
  else if (error <= 2) factor = 2;
  else if (error <= 5) factor = 5;
  return factor * power;
}

function niceTicks(min, max, count = 4) {
  if (min === max) {
    const padding = Math.abs(min) * 0.1 || 1;
    min -= padding;
    max += padding;
  }
  const step = niceStep((max - min) / Math.max(1, count));
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = niceMin; value <= niceMax + step * 0.5; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }
  return { min: niceMin, max: niceMax, ticks };
}

function chartGeometry(records, width, height, margins) {
  const times = records.map((record) => dateMs(record.date));
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const timeSpan = maxTime - minTime;
  const plotWidth = width - margins.left - margins.right;
  const plotHeight = height - margins.top - margins.bottom;
  const xForIndex = (index) => {
    if (records.length === 1 || timeSpan === 0) {
      return margins.left + plotWidth / 2;
    }
    return margins.left + ((times[index] - minTime) / timeSpan) * plotWidth;
  };
  return {
    plotWidth,
    plotHeight,
    plotBottom: margins.top + plotHeight,
    minTime,
    maxTime,
    spanDays: Math.max(1, Math.round(timeSpan / DAY_MS) + 1),
    xForIndex,
  };
}

function xAxisMarkup(records, geometry, margins, width) {
  const maxLabels = width < 520 ? 4 : width < 760 ? 5 : 6;
  const labelCount = Math.min(maxLabels, records.length);
  if (labelCount === 0) return '';
  const indices = [];
  for (let index = 0; index < labelCount; index += 1) {
    const point = Math.round((index * (records.length - 1)) / Math.max(1, labelCount - 1));
    if (!indices.includes(point)) indices.push(point);
  }
  return indices
    .map((index) => {
      const x = geometry.xForIndex(index);
      const anchor = x < margins.left + 20 ? 'start' : x > width - margins.right - 20 ? 'end' : 'middle';
      return `<text x="${x.toFixed(1)}" y="${(margins.top + geometry.plotHeight + 22).toFixed(
        1,
      )}" fill="#8b958e" font-size="11.5" text-anchor="${anchor}" font-family="Cascadia Mono, Consolas, monospace">${formatAxisDate(
        records[index].date,
        geometry.spanDays,
      )}</text>`;
    })
    .join('');
}

function chartEmpty(host, message) {
  host.innerHTML = `
    <div class="chart-empty" style="min-height: inherit">
      <div class="chart-empty-inner">
        <span class="chart-empty-mark">+</span>
        <p>${escapeHtml(message)}</p>
      </div>
    </div>
  `;
}

function attachTooltip(host, tooltip, svg, points, width, height, content) {
  if (!points.length) return;
  const hoverLine = document.createElementNS(SVG_NS, 'line');
  hoverLine.setAttribute('stroke', '#60756a');
  hoverLine.setAttribute('stroke-width', '1');
  hoverLine.setAttribute('stroke-dasharray', '3 4');
  hoverLine.setAttribute('opacity', '0');
  svg.appendChild(hoverLine);

  const hoverDot = document.createElementNS(SVG_NS, 'circle');
  hoverDot.setAttribute('r', '4.6');
  hoverDot.setAttribute('fill', '#fffefa');
  hoverDot.setAttribute('stroke', '#176456');
  hoverDot.setAttribute('stroke-width', '2');
  hoverDot.setAttribute('opacity', '0');
  svg.appendChild(hoverDot);

  const overlay = document.createElementNS(SVG_NS, 'rect');
  overlay.setAttribute('x', '0');
  overlay.setAttribute('y', '0');
  overlay.setAttribute('width', String(width));
  overlay.setAttribute('height', String(height));
  overlay.setAttribute('fill', 'transparent');
  overlay.setAttribute('style', 'cursor: crosshair');
  svg.appendChild(overlay);

  const hide = () => {
    hoverLine.setAttribute('opacity', '0');
    hoverDot.setAttribute('opacity', '0');
    tooltip.hidden = true;
  };

  overlay.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const pointerX = ((event.clientX - rect.left) / rect.width) * width;
    let nearest = 0;
    let distance = Infinity;
    points.forEach((point, index) => {
      const current = Math.abs(point.x - pointerX);
      if (current < distance) {
        distance = current;
        nearest = index;
      }
    });
    const point = points[nearest];
    hoverLine.setAttribute('x1', String(point.x));
    hoverLine.setAttribute('x2', String(point.x));
    hoverLine.setAttribute('y1', String(point.top));
    hoverLine.setAttribute('y2', String(point.bottom));
    hoverLine.setAttribute('opacity', '1');
    hoverDot.setAttribute('cx', String(point.x));
    hoverDot.setAttribute('cy', String(point.y));
    hoverDot.setAttribute('opacity', '1');
    tooltip.innerHTML = content(point.record);
    tooltip.hidden = false;

    const wrapper = host.parentElement;
    const wrapperRect = wrapper.getBoundingClientRect();
    const localX = event.clientX - wrapperRect.left;
    const localY = event.clientY - wrapperRect.top;
    const tooltipWidth = Math.min(220, tooltip.offsetWidth || 190);
    let left = localX + 15;
    if (left + tooltipWidth + 8 > wrapperRect.width) {
      left = localX - tooltipWidth - 15;
    }
    left = Math.max(8, Math.min(left, wrapperRect.width - tooltipWidth - 8));
    let top = localY - 18;
    top = Math.max(8, Math.min(top, wrapperRect.height - tooltip.offsetHeight - 8));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  });
  overlay.addEventListener('pointerleave', hide);
  overlay.addEventListener('pointercancel', hide);
}

function renderCharts() {
  renderAssetChart();
  renderPnlChart();
}

function renderAssetChart() {
  const host = $('#assetChart');
  const tooltip = $('#assetTooltip');
  tooltip.hidden = true;
  const records = rangeRecords(state.dashboard.records, state.ranges.assets);
  if (!records.length) {
    chartEmpty(host, '记录第一天收益后，这里会画出累计收益曲线。');
    $('#assetChartRange').textContent = '暂无记录';
    $('#assetChartDelta').textContent = '—';
    return;
  }

  const width = Math.max(320, host.clientWidth || 700);
  const measuredHeight = host.clientHeight;
  const height = Math.max(252, measuredHeight || (width < 620 ? 252 : 312));
  const margins = { top: 18, right: 22, bottom: 34, left: 66 };
  const geometry = chartGeometry(records, width, height, margins);
  const values = records.map((record) => record.cumulative_pnl);
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  const rawSpan = rawMax - rawMin;
  const padding = rawSpan > 0 ? rawSpan * 0.13 : 1;
  const scale = niceTicks(rawMin - padding * 0.2, rawMax + padding, 4);
  const yFor = (value) =>
    margins.top + (1 - (value - scale.min) / (scale.max - scale.min)) * geometry.plotHeight;

  const cumulativePoints = records.map((record, index) => ({
    x: geometry.xForIndex(index),
    y: yFor(record.cumulative_pnl),
    top: margins.top,
    bottom: margins.top + geometry.plotHeight,
    record,
  }));
  const linePath = (points) =>
    points
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`,
      )
      .join(' ');
  const cumulativeLine = linePath(cumulativePoints);
  const zeroY = yFor(0);
  const area = `${cumulativeLine} L${cumulativePoints.at(-1).x.toFixed(
    1,
  )},${zeroY.toFixed(1)} L${cumulativePoints[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`;

  const grid = scale.ticks
    .map((tick) => {
      const y = yFor(tick);
      return `
        <line x1="${margins.left}" x2="${width - margins.right}" y1="${y.toFixed(
          1,
        )}" y2="${y.toFixed(1)}" stroke="#e6ebe3" stroke-width="1" stroke-dasharray="2 5"></line>
        <text x="${margins.left - 10}" y="${(y + 3).toFixed(
          1,
        )}" fill="#8b958e" font-size="11" text-anchor="end" font-family="Cascadia Mono, Consolas, monospace">${formatCompactMoney(
          tick,
        )}</text>
      `;
    })
    .join('');

  host.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="累计收益曲线">
      <defs>
        <linearGradient id="assetAreaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#397c68" stop-opacity=".2"></stop>
          <stop offset="78%" stop-color="#397c68" stop-opacity=".035"></stop>
          <stop offset="100%" stop-color="#397c68" stop-opacity="0"></stop>
        </linearGradient>
      </defs>
      ${grid}
      <line x1="${margins.left}" x2="${width - margins.right}" y1="${zeroY.toFixed(
        1,
      )}" y2="${zeroY.toFixed(
        1,
      )}" stroke="#c5d0c7" stroke-width="1" stroke-dasharray="4 5"></line>
      <path d="${area}" fill="url(#assetAreaFill)"></path>
      <path d="${cumulativeLine}" fill="none" stroke="#176456" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>
      <circle cx="${cumulativePoints.at(-1).x.toFixed(1)}" cy="${cumulativePoints.at(-1).y.toFixed(
        1,
      )}" r="8" fill="#176456" opacity=".1"></circle>
      <circle cx="${cumulativePoints.at(-1).x.toFixed(1)}" cy="${cumulativePoints.at(-1).y.toFixed(
        1,
      )}" r="3.2" fill="#176456" stroke="#fffefa" stroke-width="1.5"></circle>
      ${xAxisMarkup(records, geometry, margins, width)}
    </svg>
  `;

  const svg = host.querySelector('svg');
  attachTooltip(host, tooltip, svg, cumulativePoints, width, height, (record) => `
    <strong>${formatDateCN(record.date)}</strong>
    <span>累计收益 <b class="${record.cumulative_pnl >= 0 ? 'positive' : 'negative'}">${formatSignedMoney(
      record.cumulative_pnl,
    )}</b></span>
    <span>当日收益 <b>${formatSignedMoney(record.daily_pnl)}</b></span>
    <span>当日收益率 <b>${formatPct(record.daily_return * 100, 4, true)}</b></span>
  `);

  $('#assetChartRange').textContent = `${formatDateShort(records[0].date)} — ${formatDateShort(
    records.at(-1).date,
  )} · ${records.length} 条`;
  const totalPnl = records.reduce((sum, record) => sum + record.daily_pnl, 0);
  $('#assetChartDelta').textContent = `区间累计收益 ${formatSignedMoney(
    totalPnl,
  )} · ${formatPct(periodReturn(records) * 100, 3, true)}`;
}

function renderPnlChart() {
  const host = $('#pnlChart');
  const tooltip = $('#pnlTooltip');
  tooltip.hidden = true;
  const records = rangeRecords(state.dashboard.records, state.ranges.pnl);
  if (!records.length) {
    chartEmpty(host, '每一笔收益和收益率，会在这里按日排成柱子和折线。');
    $('#pnlChartRange').textContent = '暂无记录';
    $('#pnlChartSummary').textContent = '—';
    return;
  }

  const width = Math.max(320, host.clientWidth || 900);
  const height = width < 620 ? 260 : 324;
  const margins = { top: 20, right: 58, bottom: 34, left: 66 };
  const geometry = chartGeometry(records, width, height, margins);
  const pnlValues = records.map((record) => record.daily_pnl);
  let pnlMin = Math.min(0, ...pnlValues);
  let pnlMax = Math.max(0, ...pnlValues);
  if (pnlMin === pnlMax) {
    pnlMin = -1;
    pnlMax = 1;
  }
  const pnlSpan = pnlMax - pnlMin;
  if (pnlSpan > 0) {
    pnlMin -= pnlSpan * 0.08;
    pnlMax += pnlSpan * 0.08;
  }
  const pnlScale = niceTicks(pnlMin, pnlMax, 4);
  const yPnl = (value) =>
    margins.top + (1 - (value - pnlScale.min) / (pnlScale.max - pnlScale.min)) * geometry.plotHeight;
  const zeroY = yPnl(0);

  const rateValues = records.map((record) => record.daily_return * 100);
  let rateMin = Math.min(0, ...rateValues);
  let rateMax = Math.max(0, ...rateValues);
  if (rateMin === rateMax) {
    rateMin = -0.001;
    rateMax = 0.001;
  }
  const ratePadding = (rateMax - rateMin) * 0.18 || 0.0002;
  const rateScale = niceTicks(rateMin - ratePadding, rateMax + ratePadding, 4);
  const yRate = (value) =>
    margins.top + (1 - (value - rateScale.min) / (rateScale.max - rateScale.min)) * geometry.plotHeight;

  const grid = pnlScale.ticks
    .map((tick) => {
      const y = yPnl(tick);
      return `
        <line x1="${margins.left}" x2="${width - margins.right}" y1="${y.toFixed(
          1,
        )}" y2="${y.toFixed(1)}" stroke="#e6ebe3" stroke-width="1" stroke-dasharray="2 5"></line>
        <text x="${margins.left - 10}" y="${(y + 3).toFixed(
          1,
        )}" fill="#8b958e" font-size="11" text-anchor="end" font-family="Cascadia Mono, Consolas, monospace">${formatCompactMoney(
          tick,
        )}</text>
      `;
    })
    .join('');
  const rightGrid = rateScale.ticks
    .map((tick) => {
      const y = yRate(tick);
      return `<text x="${width - margins.right + 10}" y="${(y + 3).toFixed(
        1,
      )}" fill="#a79470" font-size="10.5" text-anchor="start" font-family="Cascadia Mono, Consolas, monospace">${formatAxisPct(
        tick,
      )}</text>`;
    })
    .join('');

  const step = geometry.plotWidth / Math.max(records.length, 1);
  const barWidth = Math.max(2.5, Math.min(22, step * 0.56));
  const bars = records
    .map((record, index) => {
      const x = geometry.xForIndex(index) - barWidth / 2;
      const yValue = yPnl(record.daily_pnl);
      const top = Math.min(yValue, zeroY);
      const barHeight = Math.max(1, Math.abs(yValue - zeroY));
      const color = record.daily_pnl >= 0 ? '#c25243' : '#2c7d60';
      return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(
        1,
      )}" height="${barHeight.toFixed(1)}" rx="${Math.min(3, barWidth / 2).toFixed(
        1,
      )}" fill="${color}" opacity="${record.daily_pnl === 0 ? 0.26 : 0.82}"></rect>`;
    })
    .join('');

  const ratePoints = records.map((record, index) => ({
    x: geometry.xForIndex(index),
    y: yRate(record.daily_return * 100),
    top: margins.top,
    bottom: margins.top + geometry.plotHeight,
    record,
  }));
  const rateLine = ratePoints
    .map(
      (point, index) =>
        `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`,
    )
    .join(' ');
  const rateDots =
    records.length <= 45
      ? ratePoints
          .map(
            (point) =>
              `<circle cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(
                1,
              )}" r="2.2" fill="#fffefa" stroke="#b77c2d" stroke-width="1.4"></circle>`,
          )
          .join('')
      : '';

  host.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="每日收益柱状图与日收益率折线">
      ${grid}
      ${rightGrid}
      <line x1="${margins.left}" x2="${width - margins.right}" y1="${zeroY.toFixed(
        1,
      )}" y2="${zeroY.toFixed(1)}" stroke="#c7d0c8" stroke-width="1"></line>
      ${bars}
      <path d="${rateLine}" fill="none" stroke="#b77c2d" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"></path>
      ${rateDots}
      ${xAxisMarkup(records, geometry, margins, width)}
    </svg>
  `;

  const svg = host.querySelector('svg');
  attachTooltip(host, tooltip, svg, ratePoints, width, height, (record) => `
    <strong>${formatDateCN(record.date)}</strong>
    <span>当日收益 <b class="${record.daily_pnl >= 0 ? 'positive' : 'negative'}">${formatSignedMoney(
      record.daily_pnl,
    )}</b></span>
    <span>日收益率 <b>${formatPct(record.daily_return * 100, 4, true)}</b></span>
    <span>R2 本金 <b>¥${formatMoney(record.principal)}</b></span>
  `);

  const totalPnl = records.reduce((sum, record) => sum + record.daily_pnl, 0);
  const positiveDays = records.filter((record) => record.daily_pnl > 0).length;
  const negativeDays = records.filter((record) => record.daily_pnl < 0).length;
  $('#pnlChartRange').textContent = `${formatDateShort(records[0].date)} — ${formatDateShort(
    records.at(-1).date,
  )} · ${records.length} 条`;
  $('#pnlChartSummary').textContent = `合计 ${formatSignedMoney(
    totalPnl,
  )} · 正收益 ${positiveDays} 天 / 负收益 ${negativeDays} 天`;
}

function renderWatchlist() {
  const { products } = state.dashboard;
  const watchlist = products.watchlist;
  const container = $('#watchlist');
  if (!watchlist.length) {
    container.innerHTML = `
      <div class="product-card">
        <div class="product-name">产品快照暂不可用</div>
        <p class="product-benchmark">请确认 data/cmb_r2_products_2026-10-18.csv 仍在原位，并重新启动服务。</p>
      </div>
    `;
    $('#poolGoalTitle').textContent = '观察池目标可行性';
    $('#poolGoalText').textContent = '没有可读取的历史产品快照。';
    $('#poolGap').textContent = '—';
    return;
  }

  container.innerHTML = watchlist
    .map((product) => {
      const gapClass = product.target_gap_pct !== null && product.target_gap_pct >= 0 ? 'positive' : '';
      return `
        <article class="product-card bucket-${escapeHtml(product.bucket)}">
          <div class="product-top">
            <span class="term-badge">${bucketLabel(product.bucket)} · ${escapeHtml(
              formatTerm(product.term_days, product.bucket),
            )}</span>
            <span class="product-code">${escapeHtml(product.code)}</span>
          </div>
          <h3 class="product-name">${escapeHtml(product.name)}</h3>
          <div class="product-yield">
            <strong>${formatPct(product.return_1y, 2)}</strong>
            <span>近 1 年历史年化</span>
          </div>
          <div class="product-stats">
            <div class="product-stat">
              <span>近 3 月</span>
              <strong>${formatPct(product.return_3m, 2)}</strong>
            </div>
            <div class="product-stat">
              <span>近 6 月</span>
              <strong>${formatPct(product.return_6m, 2)}</strong>
            </div>
          </div>
          <p class="product-benchmark" title="${escapeHtml(product.benchmark)}">${escapeHtml(
            product.benchmark || '底层与业绩基准待核验',
          )}</p>
          <div class="product-foot">
            <span>${escapeHtml(product.data_date || '日期待核')} · 历史快照</span>
            <span class="product-gap ${gapClass}">距 3% ${
              product.target_gap_pct === null
                ? '—'
                : formatPp(product.target_gap_pct, 2, true)
            }</span>
          </div>
        </article>
      `;
    })
    .join('');

  const stats = products.stats;
  if (stats.median_1y === null) {
    $('#poolGoalTitle').textContent = '产品池数据不足';
    $('#poolGoalText').textContent = '没有足够的近 1 年历史数据。';
    $('#poolGap').textContent = '—';
    $('#poolProgressBar').style.width = '0%';
    return;
  }
  $('#poolGoalTitle').textContent = `观察池近 1 年中位 ${formatPct(stats.median_1y, 2)}`;
  $('#poolGoalText').textContent = `开放产品 ${stats.observation_ready}/${
    stats.total
  } 只入池 · 近 3 月中位 ${formatPct(stats.median_3m, 2)} · 目标覆盖 ${formatPct(
    stats.target_coverage_pct,
    1,
  )}`;
  $('#poolGap').textContent =
    stats.target_gap_pct === null
      ? '—'
      : `距 3% ${formatPp(stats.target_gap_pct, 2, true)}`;
  $('#poolGap').classList.toggle('positive', stats.target_gap_pct >= 0);
  $('#poolProgressBar').style.width = `${Math.max(
    0,
    Math.min(100, stats.target_coverage_pct || 0),
  )}%`;
}

const PRODUCT_SORT_LABELS = {
  term: '按期限',
  return_1m: '近 1 月收益率',
  return_3m: '近 3 月收益率',
  return_6m: '近 6 月收益率',
  return_1y: '近 1 年收益率',
};

function compareProducts(a, b, key, direction) {
  const nameCompare = a.name.localeCompare(b.name, 'zh-CN');
  if (key === 'term') {
    const diff = (a.term_days ?? 9999) - (b.term_days ?? 9999);
    if (diff !== 0) return direction === 'asc' ? diff : -diff;
    return nameCompare;
  }

  const aValue = a[key];
  const bValue = b[key];
  const aMissing = !Number.isFinite(aValue);
  const bMissing = !Number.isFinite(bValue);
  if (aMissing || bMissing) {
    if (aMissing === bMissing) return nameCompare;
    return aMissing ? 1 : -1;
  }
  const diff = aValue - bValue;
  if (diff !== 0) return direction === 'asc' ? diff : -diff;
  return nameCompare;
}

function sortProductRows(products) {
  return [...products].sort((a, b) =>
    compareProducts(a, b, state.productSort.key, state.productSort.direction),
  );
}

function renderProductSortState() {
  const { key, direction } = state.productSort;
  const directionText =
    key === 'term' ? (direction === 'asc' ? '短到长' : '长到短') : direction === 'asc' ? '升序' : '降序';
  $('#productSortState').textContent = `当前：${PRODUCT_SORT_LABELS[key]} · ${directionText}`;
  $$('.product-table th[data-sort-key]').forEach((header) => {
    const active = header.dataset.sortKey === key;
    header.classList.toggle('is-sorted', active);
    header.setAttribute(
      'aria-sort',
      active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none',
    );
    const glyph = $('.sort-glyph', header);
    if (glyph) glyph.textContent = active ? (direction === 'asc' ? '↑' : '↓') : '↕';
  });
}

function renderProductTable() {
  const { products, meta } = state.dashboard;
  $('#dialogSubtitle').textContent = `快照 ${
    meta.product_snapshot_date || '待核'
  } · 历史业绩 ${meta.product_history_date || '待核'} · 共 ${products.all.length} 只`;
  const filteredProducts =
    state.productTermFilter === 'all'
      ? products.all
      : products.all.filter((product) => product.bucket === state.productTermFilter);
  $('#productFilterCount').textContent =
    state.productTermFilter === 'all'
      ? `${products.all.length} 只`
      : `${filteredProducts.length} / ${products.all.length} 只`;
  $$('#productTermFilter button').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.termFilter === state.productTermFilter);
  });
  $('#productTableBody').innerHTML = sortProductRows(filteredProducts)
    .map((product) => {
      const isNew = !product.observation_ready;
      return `
        <tr>
          <td><span class="term-badge">${escapeHtml(formatTerm(product.term_days, product.bucket))}</span></td>
          <td class="product-name-cell">
            <strong>${escapeHtml(product.name)}</strong>
            <span>${escapeHtml(product.code)} · ${escapeHtml(product.risk_level || '风险待核')}</span>
          </td>
          <td class="align-right money-cell">${formatPct(product.return_1m, 2)}</td>
          <td class="align-right money-cell">${formatPct(product.return_3m, 2)}</td>
          <td class="align-right money-cell">${formatPct(product.return_6m, 2)}</td>
          <td class="align-right money-cell">${formatPct(product.return_1y, 2)}</td>
          <td>
            <span class="status-pill ${isNew ? 'is-new' : ''}">${
              isNew ? '新品 / 待补数据' : escapeHtml(product.status || '观察')
            }</span>
          </td>
        </tr>
      `;
    })
    .join('') ||
    `<tr><td class="product-filter-empty" colspan="7">这个期限暂时没有产品。</td></tr>`;
  renderProductSortState();
}

function renderLedger() {
  const records = [...state.dashboard.records];
  const { key, direction } = state.ledgerSort;
  records.sort((a, b) => {
    const comparison =
      key === 'date'
        ? a.date.localeCompare(b.date)
        : Number(a[key]) - Number(b[key]) || a.date.localeCompare(b.date);
    return direction === 'asc' ? comparison : -comparison;
  });
  const body = $('#ledgerBody');
  const table = $('.ledger-table');
  const allRecords = state.ledgerPageSize === 'all';
  const pageSize = allRecords
    ? Math.max(1, records.length)
    : Number(state.ledgerPageSize) || 10;
  const totalPages = allRecords ? 1 : Math.max(1, Math.ceil(records.length / pageSize));
  state.ledgerPage = Math.min(Math.max(1, state.ledgerPage), totalPages);
  const start = allRecords ? 0 : (state.ledgerPage - 1) * pageSize;
  const visible = allRecords ? records : records.slice(start, start + pageSize);
  $('#recordCount').textContent = `${records.length} 条`;
  $('#emptyLedger').hidden = records.length > 0;
  table.style.display = records.length ? '' : 'none';
  $('#ledgerPagination').hidden = records.length === 0;
  $('#ledgerPageSize').value = allRecords ? 'all' : String(pageSize);
  $('#ledgerJumpPage').max = String(totalPages);
  $('#ledgerJumpPage').value = String(state.ledgerPage);
  $('#ledgerJumpPage').disabled = records.length === 0 || totalPages <= 1;
  $('#ledgerJumpButton').disabled = records.length === 0 || totalPages <= 1;
  $('#ledgerPageInfo').textContent = records.length
    ? `第 ${state.ledgerPage} / ${totalPages} 页 · 共 ${records.length} 条`
    : '—';
  $('#ledgerPrevPage').disabled = state.ledgerPage <= 1;
  $('#ledgerNextPage').disabled = state.ledgerPage >= totalPages;
  renderLedgerSortState();

  body.innerHTML = visible
    .map(
      (record) => `
      <tr>
        <td><span class="ledger-date">${escapeHtml(record.date)}</span></td>
        <td class="align-right money-cell">¥${formatMoney(record.principal)}</td>
        <td class="align-right money-cell ${record.daily_pnl >= 0 ? 'positive' : 'negative'}">${formatSignedMoney(
          record.daily_pnl,
        )}</td>
        <td class="align-right money-cell ${record.daily_return >= 0 ? 'positive' : 'negative'}">${formatPct(
          record.daily_return * 100,
          4,
          true,
        )}</td>
        <td class="align-right money-cell">¥${formatMoney(record.net_value)}</td>
        <td><span class="action-badge ${
          record.action !== '无操作' ? 'is-trade' : ''
        }">${escapeHtml(record.action)}</span></td>
        <td class="notes-cell" title="${escapeHtml(record.notes)}">${escapeHtml(
          record.notes || '—',
        )}</td>
        <td class="align-right">
          <span class="row-actions">
            <button class="icon-button" type="button" data-edit="${escapeHtml(
              record.date,
            )}" aria-label="修改 ${escapeHtml(record.date)} 的记录" title="修改">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="m12.8 3.6 3.6 3.6M4 16l.8-4.2L13.6 3a1.4 1.4 0 0 1 2 0l1.4 1.4a1.4 1.4 0 0 1 0 2l-8.8 8.8L4 16Z" />
              </svg>
            </button>
            <button class="icon-button is-danger" type="button" data-delete="${escapeHtml(
              record.date,
            )}" aria-label="删除 ${escapeHtml(record.date)} 的记录" title="删除">
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path d="M4 6h12M8 3.5h4M6 6l.7 10h6.6L14 6M8.2 9v4.2M11.8 9v4.2" />
              </svg>
            </button>
          </span>
        </td>
      </tr>
    `,
    )
    .join('');
}

function renderLedgerSortState() {
  const { key, direction } = state.ledgerSort;
  $$('.ledger-table th[data-sort-key]').forEach((header) => {
    const active = header.dataset.sortKey === key;
    header.classList.toggle('is-sorted', active);
    header.setAttribute(
      'aria-sort',
      active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none',
    );
    const glyph = $('.sort-glyph', header);
    if (glyph) glyph.textContent = active ? (direction === 'asc' ? '↑' : '↓') : '↕';
  });
}

function renderTodayNotice() {
  const { meta } = state.dashboard;
  const notice = $('#todayNotice');
  const show = meta.has_today_record && state.editingDate !== meta.today;
  notice.hidden = !show;
}

function recordByDate(date) {
  return state.dashboard?.records.find((record) => record.date === date) || null;
}

function updateEntryChip() {
  const { meta } = state.dashboard || {};
  const date = $('#recordDate').value;
  $('#entryDateChip').textContent = date && date === meta?.today ? '今天' : formatDateShort(date);
}

function updatePreview() {
  const principal = principalForDate($('#recordDate').value);
  const pnl = Number($('#dailyPnl').value);
  const preview = $('#previewRate');
  if (
    principal === null ||
    principal <= 0 ||
    !Number.isFinite(pnl) ||
    $('#dailyPnl').value === ''
  ) {
    preview.textContent = '—';
    preview.classList.remove('positive', 'negative');
    return;
  }
  const rate = (pnl / principal) * 100;
  preview.textContent = formatPct(rate, 4, true);
  preview.classList.toggle('positive', rate > 0);
  preview.classList.toggle('negative', rate < 0);
}

function setFormMode(date) {
  const { meta } = state.dashboard;
  state.editingDate = date || null;
  const dateInput = $('#recordDate');
  const record = date ? recordByDate(date) : null;

  if (record) {
    dateInput.value = record.date;
    dateInput.readOnly = true;
    $('#dailyPnl').value = record.daily_pnl;
    $('#action').value = record.action;
    $('#notes').value = record.notes;
    $('#formTitle').textContent = '修改这笔记录';
    $('#submitButton span').textContent = '保存修改';
    $('#cancelEdit').hidden = false;
    $('#formMode').value = 'edit';
  } else {
    dateInput.readOnly = false;
    dateInput.value = meta.today;
    $('#dailyPnl').value = '';
    $('#action').value = '无操作';
    $('#notes').value = '';
    $('#formTitle').textContent = '记一笔收益';
    $('#submitButton span').textContent = '保存记录';
    $('#cancelEdit').hidden = true;
    $('#formMode').value = 'create';
  }
  updateEntryChip();
  updatePreview();
  renderTodayNotice();
}

function loadRecordForEdit(date) {
  const record = recordByDate(date);
  if (!record) {
    showToast('没有找到这条记录', { error: true });
    return;
  }
  setFormMode(date);
  $('.entry-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => $('#dailyPnl').focus(), 380);
}

async function handleSubmit(event) {
  event.preventDefault();
  const meta = state.dashboard.meta;
  const date = $('#recordDate').value;
  const principal = principalForDate(date);
  const dailyPnl = Number($('#dailyPnl').value);
  const action = $('#action').value;
  const notes = $('#notes').value.trim();

  if (!date) {
    showToast('请选择日期', { error: true });
    return;
  }
  if (date > meta.today) {
    showToast('不能记录未来日期', { error: true });
    return;
  }
  if (principal === null) {
    showToast('请先初始化本金账户，并确认记录日期不早于起始日期', { error: true });
    return;
  }
  if (principal <= 0) {
    showToast('该日期本金为 0，无法记录收益', { error: true });
    return;
  }
  if (!Number.isFinite(dailyPnl) || $('#dailyPnl').value === '') {
    showToast('请填写当日收益，亏损填负数', { error: true });
    return;
  }
  const button = $('#submitButton');
  const original = button.querySelector('span').textContent;
  button.disabled = true;
  button.querySelector('span').textContent = '保存中…';
  try {
    const isEdit = Boolean(state.editingDate);
    const payload = await apiRequest(
      isEdit ? `/api/records/${encodeURIComponent(state.editingDate)}` : '/api/records',
      {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify({
          date,
          daily_pnl: dailyPnl,
          action,
          notes,
        }),
      },
    );
    state.dashboard = payload.dashboard;
    state.ledgerPage = 1;
    renderDashboard();
    setFormMode(payload.record.date);
    showToast(isEdit ? '记录已更新' : '收益已记入账本');
  } catch (error) {
    showToast(error.message || '保存失败', { error: true, duration: 5000 });
    button.querySelector('span').textContent = original;
  } finally {
    button.disabled = false;
    if (button.querySelector('span').textContent === '保存中…') {
      button.querySelector('span').textContent = original;
    }
  }
}

async function deleteRecord(date) {
  const confirmed = window.confirm(`确认删除 ${date} 的记录？删除后无法恢复。`);
  if (!confirmed) return;
  try {
    const payload = await apiRequest(`/api/records/${encodeURIComponent(date)}`, {
      method: 'DELETE',
    });
    state.dashboard = payload.dashboard;
    if (state.editingDate === date) setFormMode(null);
    renderDashboard();
    showToast('记录已删除');
  } catch (error) {
    showToast(error.message || '删除失败', { error: true });
  }
}

function bindRangeSwitches() {
  $$('.range-switch').forEach((group) => {
    group.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-range]');
      if (!button) return;
      const groupName = group.dataset.rangeGroup;
      state.ranges[groupName] = button.dataset.range;
      $$('button', group).forEach((item) => item.classList.toggle('is-active', item === button));
      if (groupName === 'assets') renderAssetChart();
      else renderPnlChart();
    });
  });
}

function bindProductSorting() {
  $('.product-table thead').addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-sort-key]');
    if (!trigger) return;
    const key = trigger.dataset.sortKey;
    if (!PRODUCT_SORT_LABELS[key]) return;
    if (state.productSort.key === key) {
      state.productSort.direction = state.productSort.direction === 'asc' ? 'desc' : 'asc';
    } else {
      state.productSort.key = key;
      state.productSort.direction = key === 'term' ? 'asc' : 'desc';
    }
    renderProductTable();
  });
  $('#productTermFilter').addEventListener('click', (event) => {
    const button = event.target.closest('[data-term-filter]');
    if (!button) return;
    state.productTermFilter = button.dataset.termFilter;
    renderProductTable();
  });
}

async function refreshProductSnapshot() {
  const button = $('#refreshProducts');
  const original = button.textContent.trim();
  button.disabled = true;
  button.textContent = '读取中…';
  try {
    const payload = await apiRequest('/api/products/refresh', { method: 'POST' });
    state.dashboard = payload.dashboard;
    renderDashboard();
    const meta = payload.dashboard.meta;
    showToast(
      `已重新读取 ${payload.refreshed} 只产品 · 快照 ${meta.product_snapshot_date || '待核'} · 历史业绩 ${meta.product_history_date || '待核'}`,
      { duration: 4600 },
    );
  } catch (error) {
    showToast(error.message || '产品快照刷新失败', { error: true, duration: 5000 });
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function openCapitalInitDialog(mode = null) {
  const capital = getCapitalState();
  const meta = state.dashboard.meta;
  state.capitalDialogMode =
    mode === 'edit' || (mode === null && capital.initialized) ? 'edit' : 'init';
  const editing = state.capitalDialogMode === 'edit';
  $('#capitalInitTitle').textContent = editing ? '调整起始本金' : '设定起始本金';
  $('#capitalInitHint').textContent = editing
    ? '修改起始本金或日期后，历史收益记录的本金快照会自动重算。'
    : '先确定进入本账本时的 R2 本金，之后资金变化用转入/转出记录。';
  $('#capitalInitNote').textContent = editing
    ? '已有转入/转出记录会保留；如果新起始日期晚于已有记录或资金变动，系统会拒绝保存。'
    : '起始本金是进入账本时的 R2 总本金，不包含累计收益，也不包含组合外应急金。';
  $('#capitalInitSubmit').textContent = editing ? '保存修改' : '完成初始化';
  const dateInput = $('#capitalInitDate');
  dateInput.max = meta.today;
  dateInput.value = editing ? capital.initial_date : meta.today;
  $('#capitalInitAmount').value = editing ? capital.initial_principal : 540000;
  $('#capitalInitDialog').showModal();
  window.setTimeout(() => $('#capitalInitAmount').focus(), 100);
}

async function handleCapitalInitSubmit(event) {
  event.preventDefault();
  const amount = Number($('#capitalInitAmount').value);
  const date = $('#capitalInitDate').value;
  if (!date) {
    showToast('请选择起始日期', { error: true });
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast('起始本金需要大于 0', { error: true });
    return;
  }
  const editing = state.capitalDialogMode === 'edit';
  const button = $('#capitalInitSubmit');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    const payload = await apiRequest('/api/capital/init', {
      method: editing ? 'PUT' : 'POST',
      body: JSON.stringify({ initial_principal: amount, initial_date: date }),
    });
    state.dashboard = payload.dashboard;
    $('#capitalInitDialog').close();
    renderDashboard();
    if (state.editingDate) setFormMode(state.editingDate);
    else updatePreview();
    showToast(editing ? '起始本金已更新，历史本金快照已重算' : '本金账户已初始化');
  } catch (error) {
    showToast(error.message || '本金初始化失败', { error: true, duration: 5000 });
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function handleCapitalEventSubmit(event) {
  event.preventDefault();
  const capital = getCapitalState();
  if (!capital.initialized) {
    openCapitalInitDialog('init');
    return;
  }
  const date = $('#capitalEventDate').value;
  const amount = Number($('#capitalEventAmount').value);
  const type = state.capitalEventType;
  const note = $('#capitalEventNote').value.trim();
  if (!date) {
    showToast('请选择资金变动日期', { error: true });
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    showToast('转入/转出金额需要大于 0', { error: true });
    return;
  }
  const button = $('#capitalEventSubmit');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    const payload = await apiRequest('/api/capital/events', {
      method: 'POST',
      body: JSON.stringify({
        event_date: date,
        event_type: type,
        amount,
        note,
      }),
    });
    state.dashboard = payload.dashboard;
    renderDashboard();
    $('#capitalEventAmount').value = '';
    $('#capitalEventNote').value = '';
    showToast(
      `${type === 'deposit' ? '转入' : '转出'} ¥${formatMoney(amount)} 已记录，相关本金快照已更新`,
      { duration: 4200 },
    );
  } catch (error) {
    showToast(error.message || '本金变动保存失败', { error: true, duration: 5000 });
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function deleteCapitalEvent(id) {
  const confirmed = window.confirm('确认删除这笔本金变动？历史记录的本金快照会重新计算。');
  if (!confirmed) return;
  try {
    const payload = await apiRequest(`/api/capital/events/${id}`, { method: 'DELETE' });
    state.dashboard = payload.dashboard;
    renderDashboard();
    if (state.editingDate) setFormMode(state.editingDate);
    showToast('本金变动已删除，本金快照已重算');
  } catch (error) {
    showToast(error.message || '删除本金变动失败', { error: true, duration: 5000 });
  }
}

function bindEvents() {
  bindRangeSwitches();
  bindProductSorting();
  $('#recordForm').addEventListener('submit', handleSubmit);
  $('#recordDate').addEventListener('change', () => {
    updateEntryChip();
    updatePreview();
  });
  $('#dailyPnl').addEventListener('input', updatePreview);
  $('#cancelEdit').addEventListener('click', () => setFormMode(null));
  $('#loadTodayButton').addEventListener('click', () => loadRecordForEdit(state.dashboard.meta.today));

  $('#capitalEventForm').addEventListener('submit', handleCapitalEventSubmit);
  $$('.capital-type-switch button').forEach((button) => {
    button.addEventListener('click', () => updateCapitalEventType(button.dataset.capitalType));
  });
  $('#capitalEventList').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-capital-delete]');
    if (remove) deleteCapitalEvent(Number(remove.dataset.capitalDelete));
  });
  $('#editCapitalInit').addEventListener('click', () => openCapitalInitDialog());
  $('#capitalInitButton').addEventListener('click', () => openCapitalInitDialog('init'));
  $('#capitalInitForm').addEventListener('submit', handleCapitalInitSubmit);
  $('#closeCapitalInit').addEventListener('click', () => $('#capitalInitDialog').close());
  $('#capitalInitDialog').addEventListener('click', (event) => {
    const dialog = $('#capitalInitDialog');
    const rect = dialog.getBoundingClientRect();
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;
    if (outside) dialog.close();
  });

  $('#ledgerBody').addEventListener('click', (event) => {
    const edit = event.target.closest('[data-edit]');
    if (edit) {
      loadRecordForEdit(edit.dataset.edit);
      return;
    }
    const remove = event.target.closest('[data-delete]');
    if (remove) deleteRecord(remove.dataset.delete);
  });

  $('#ledgerPrevPage').addEventListener('click', () => {
    if (state.ledgerPage <= 1) return;
    state.ledgerPage -= 1;
    renderLedger();
  });
  $('#ledgerNextPage').addEventListener('click', () => {
    const totalPages =
      state.ledgerPageSize === 'all'
        ? 1
        : Math.ceil(state.dashboard.records.length / state.ledgerPageSize);
    if (state.ledgerPage >= totalPages) return;
    state.ledgerPage += 1;
    renderLedger();
  });
  $('#ledgerPageSize').addEventListener('change', (event) => {
    state.ledgerPageSize =
      event.target.value === 'all' ? 'all' : Number(event.target.value) || 10;
    state.ledgerPage = 1;
    renderLedger();
  });
  $('.ledger-table thead').addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-sort-key]');
    if (!trigger) return;
    const key = trigger.dataset.sortKey;
    if (state.ledgerSort.key === key) {
      state.ledgerSort.direction = state.ledgerSort.direction === 'desc' ? 'asc' : 'desc';
    } else {
      state.ledgerSort.key = key;
      state.ledgerSort.direction = 'desc';
    }
    state.ledgerPage = 1;
    renderLedger();
  });
  const jumpToLedgerPage = () => {
    const totalPages = Math.max(
      1,
      state.ledgerPageSize === 'all'
        ? 1
        : Math.ceil(state.dashboard.records.length / state.ledgerPageSize),
    );
    const requested = Number($('#ledgerJumpPage').value);
    if (!Number.isFinite(requested)) return;
    state.ledgerPage = Math.min(totalPages, Math.max(1, Math.trunc(requested)));
    renderLedger();
  };
  $('#ledgerJumpButton').addEventListener('click', jumpToLedgerPage);
  $('#ledgerJumpPage').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jumpToLedgerPage();
    }
  });

  $('#reviewMonthSelect').addEventListener('change', (event) => {
    state.reviewMonth = event.target.value || null;
    renderReview();
  });
  $('#reviewHistoryList').addEventListener('click', (event) => {
    const row = event.target.closest('[data-review-month]');
    if (!row) return;
    state.reviewMonth = row.dataset.reviewMonth;
    renderReview();
  });
  $('#reviewHistoryList').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const row = event.target.closest('[data-review-month]');
    if (!row) return;
    event.preventDefault();
    state.reviewMonth = row.dataset.reviewMonth;
    renderReview();
  });

  $('#showAllProducts').addEventListener('click', () => {
    $('#productsDialog').showModal();
  });
  $('#refreshProducts').addEventListener('click', refreshProductSnapshot);
  $('#closeProductsDialog').addEventListener('click', () => {
    $('#productsDialog').close();
  });
  $('#productsDialog').addEventListener('click', (event) => {
    const dialog = $('#productsDialog');
    const rect = dialog.getBoundingClientRect();
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;
    if (outside) dialog.close();
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(renderCharts, 120);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindEvents();
  loadDashboard();
});
