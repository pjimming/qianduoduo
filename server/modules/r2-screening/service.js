'use strict';

const { RULE_VERSION, screen, yearStart } = require('./policy');
const { collect, VERSION } = require('./source');
const { TIMEZONE, shanghaiTime, nextDue, shift, daysBetween, refreshCalendar, valuationCalendar } = require('./calendar');

const TIMEOUT_MS = 5 * 60 * 1000;
const tickInterval = 10000;
const terminal = new Set(['succeeded', 'degraded', 'failed', 'interrupted']);
const dateTime = day => `${day}T12:00:00+08:00`;
const messageByCode = {
  performance_unavailable: '公开近 1 月业绩来源全局不可用',
  pool_scope: '公开产品池与请求范围不符', pool_identity: '公开产品池份额缺失或重复',
  quota_unavailable: '公开额度来源全局不可用', detail_nav_unavailable: '产品详情或净值来源全局不可用',
  source_unavailable: '公开来源连接、签名或响应异常', collection_timeout: '公开采集超过时间上限',
  publish_failed: '本轮结果校验或保存失败', stopped: '初筛 worker 已停止', superseded: '批次已跨日或有更新批次',
};

function apiError(statusCode, code, message, data) {
  return Object.assign(new Error(message), { statusCode, code, data });
}

function createScreeningService({
  repository = null, enabled = false, issue = null, logger = console,
  clock = () => new Date(), refresh = refreshCalendar, valuation = valuationCalendar, collector = collect,
  timeoutMs = TIMEOUT_MS, schedule = true,
} = {}) {
  const versions = { rule: RULE_VERSION, refresh: refresh.version, valuation: valuation.version, collector: VERSION };
  let running;
  let timer;
  let stopped = false;
  let firstTick = true;

  function status() {
    const now = clock();
    const { date, hour } = shanghaiTime(now);
    const current = repository?.current() ?? null;
    const last = repository?.last() ?? null;
    const active = enabled && !stopped ? repository?.active() ?? null : null;
    const scheduled = repository?.scheduled(date) ?? null;
    const gap = refresh.isOpen(date) === null;
    return {
      availability: issue ? 'unavailable' : !enabled ? 'disabled' : !repository ? 'uninitialized' : current ? 'ready' : 'empty',
      timezone: TIMEZONE,
      scheduler: {
        enabled: Boolean(enabled && repository && schedule && !stopped), calendar_gap: gap,
        refresh_calendar: { version: refresh.version, sources: refresh.sources },
        valuation_calendar: { version: valuation.version, sources: valuation.sources },
        last_scheduled: scheduled, active,
      },
      next_due_at: enabled && repository && schedule && !gap
        ? hour >= 12 && !scheduled && refresh.isOpen(date) ? dateTime(date) : nextDue(now, refresh)
        : null,
      current_run: current, last_attempt: last,
      data_age: current ? {
        date, days: daysBetween(current.business_date, date),
        ...repository.ages(current.id, shift(date, -7), date),
      } : null,
      counts: current?.counts ?? null, source_health: last?.health ?? current?.health ?? null,
      issue,
    };
  }

  function requireRepository() {
    if (!repository) throw apiError(503, issue ? 'store_unavailable' : 'store_uninitialized', '初筛库暂不可读');
    return repository;
  }

  function requireBatch(id) {
    const store = requireRepository();
    const run = id === undefined ? store.current() : store.get(id);
    if (!run) throw apiError(404, 'no_batch', '没有可读取的初筛批次');
    if (!['succeeded', 'degraded'].includes(run.status)) {
      throw apiError(409, 'batch_not_published', '该批次尚无发布结果');
    }
    return run;
  }

  function runDetail(id) {
    const store = requireRepository();
    const run = store.get(id);
    if (!run) throw apiError(404, 'no_batch', '找不到初筛批次');
    const { date } = shanghaiTime(clock());
    return { ...run, attempts: store.attempts(id), current: store.current()?.id === id,
      data_age: run.counts ? { date, ...store.ages(id, shift(date, -7), date) } : null };
  }

  function result(id, channel, code) {
    const run = requireBatch(id);
    const row = repository.result(run.id, channel, code);
    if (!row) throw apiError(404, 'no_match', '此批次没有匹配份额');
    return { run, row, data: JSON.parse(row.detail) };
  }

  async function execute(claim, controller) {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    const heartbeat = setInterval(() => {
      try {
        if (!repository.heartbeat(claim.token, clock().toISOString())) controller.abort();
      } catch {
        controller.abort();
      }
    }, 10000);
    heartbeat.unref();
    let outcome;
    let health;
    let publication = false;
    try {
      const input = await collector({ date: claim.run.business_date, calendar: valuation, signal, clock });
      signal.throwIfAborted();
      health = input.health;
      publication = true;
      const evaluated = screen(input.products, claim.run.business_date, valuation);
      const degraded = Object.entries(health).some(([key, info]) =>
        key === 'shelf' ? info.state === 'request_failed' : info.ok < info.requested ||
          (key === 'quota' && info.matched < info.requested)) ||
        evaluated.results.some(row => row.status === 'pending' || row.hints.includes('calendar_gap'));
      const now = clock();
      if (repository.publish(claim.token, now.toISOString(), shanghaiTime(now).date, input, evaluated, degraded)) return;
      outcome = { status: 'interrupted', code: 'superseded' };
    } catch (error) {
      health = health ?? error.health;
      const code = controller.signal.aborted ? 'stopped'
        : signal.aborted ? 'collection_timeout'
          : publication ? 'publish_failed'
            : Object.hasOwn(messageByCode, error.code ?? '') ? error.code : 'source_unavailable';
      outcome = { status: code === 'stopped' ? 'interrupted' : 'failed', code };
    } finally {
      clearInterval(heartbeat);
    }
    const now = clock();
    const canRetry = claim.run.trigger !== 'manual' && claim.attempt < 3 &&
      !['superseded', 'publish_failed'].includes(outcome.code) &&
      shanghaiTime(now).date === claim.run.business_date;
    const retryAt = canRetry ? new Date(+now + (outcome.code === 'stopped' ? 0 : claim.attempt * 60000)) : null;
    repository.finish(claim.token, now.toISOString(), {
      ...outcome, message: messageByCode[outcome.code], health,
      retryAt: retryAt && shanghaiTime(retryAt).date === claim.run.business_date ? retryAt.toISOString() : null,
    });
  }

  function tick() {
    if (stopped || !enabled || !repository) return;
    const now = clock();
    const { date, hour, minute } = shanghaiTime(now);
    if (schedule && hour >= 12 && refresh.isOpen(date) === true && !repository.scheduled(date)) {
      repository.enqueue({
        trigger: firstTick || hour !== 12 || minute !== 0 ? 'startup' : 'scheduled',
        date, scheduledAt: dateTime(date), now: now.toISOString(), versions,
      });
    }
    firstTick = false;
    if (running) return;
    const claim = repository.take(date, now.toISOString(), versions);
    if (!claim) return;
    const controller = new AbortController();
    running = {
      controller,
      done: execute(claim, controller).catch(() => {
        logger.warn?.('R2 初筛批次状态保存失败，将由租约恢复');
      }).finally(() => { running = null; }),
    };
  }

  function safeTick() {
    try { tick(); } catch { logger.warn?.('R2 初筛调度暂不可用'); }
  }

  function manual(key) {
    if (!enabled || stopped) throw apiError(503, 'screening_disabled', '初筛刷新已暂停');
    const store = requireRepository();
    safeTick();
    const now = clock();
    const accepted = store.enqueue({ trigger: 'manual', date: shanghaiTime(now).date, now: now.toISOString(), key, versions });
    if (!accepted.conflict && !accepted.existing) safeTick();
    return accepted;
  }

  return {
    status, manual, runDetail, tick,
    runs: filters => requireRepository().runs(filters),
    results: (id, filters) => requireRepository().query(requireBatch(id).id, filters),
    detail(id, channel, code) {
      const { run, data } = result(id, channel, code);
      const evidence = repository.evidence(run.id, channel, code);
      return {
        run_id: run.id, business_date: run.business_date, rule_version: run.rule_version,
        result: data, evidence,
        trade_review: [
          { label: '正式最短持有期与申赎条款', evidence: data.term.basis, state: 'confirm', note: data.detail?.redemption_clause ?? null },
          { label: '确认日、赎回截止、确认及到账', state: 'confirm', note: '按实际确认日和银行受理规则推算最早资金可用日' },
          { label: 'App 实际额度与销售限制', state: 'confirm', note: data.restrictions },
          { label: '说明书允许资产和风险敞口', evidence: data.detail?.allowed_assets, state: 'confirm' },
          { label: '最新定期报告的实际资产、久期与风险敞口', state: 'confirm',
            url: evidence.find(item => item.kind === 'reports')?.url ?? null },
        ],
      };
    },
    nav(id, channel, code, { from, to, window, limit, offset }) {
      const { run, row, data } = result(id, channel, code);
      const end = to ?? data.metrics.latest ?? run.business_date;
      const start = from ?? (window === 'year' ? yearStart(end) : shift(end, -60));
      if (start > end) throw apiError(400, 'invalid_parameter', '净值起始日晚于结束日');
      const marks = {
        peak: data.metrics.drawdown.peak_date, trough: data.metrics.drawdown.trough_date,
        repair: data.metrics.drawdown.repair_date,
      };
      const points = repository.points(row.nav_series_id, { from: start, to: end, limit, offset });
      return {
        ...points, run_id: run.id, from: start, to: end, issue: data.metrics.issue,
        items: points.items.map(point => ({
          ...point, marks: [
            ...Object.keys(marks).filter(key => marks[key] === point.date),
            ...(data.metrics.zero_dates?.includes(point.date) ? ['zero'] : []),
          ],
        })),
      };
    },
    start() {
      if (timer || !enabled || !repository || stopped) return;
      safeTick();
      timer = setInterval(safeTick, tickInterval);
      timer.unref();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      running?.controller.abort();
      await running?.done;
    },
    close() { repository?.close(); },
  };
}

module.exports = { apiError, createScreeningService, terminal };
