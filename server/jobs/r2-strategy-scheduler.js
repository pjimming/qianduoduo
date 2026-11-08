'use strict';

// The strategy derivation loop deliberately shares the HTTP use case. A tick is
// skipped unless the ledger is activatable (shadow/v9); recompute itself dedupes
// on the frozen input fingerprint and advances the watermark only in the same
// transaction as the result. Legacy/0 is therefore preview-only.
function createStrategyScheduler({ strategy, runner = null, logger, intervalMs = 300000, startupDelayMs = 5000, onDerived = null }) {
  if (!strategy || typeof strategy.status !== 'function' || typeof strategy.recompute !== 'function') {
    throw new TypeError('策略调度器需要与HTTP共用的策略用例');
  }
  let timer = null;
  let startupTimer = null;
  let running = false;
  let last = null;
  let stopped = false;
  let projectionPending = false;
  function tick(trigger = 'periodic') {
    if (stopped) return { skipped: true, reason: 'stopped' };
    if (running) return { skipped: true, reason: 'already_running' };
    let status;
    try { status = strategy.status(); }
    catch (error) {
      last = { trigger, at: new Date().toISOString(), ok: false, code: error.code ?? 'strategy_status_failed',
        error: error instanceof Error ? error.message : String(error) };
      return last;
    }
    if (!['shadow', 'v9'].includes(status.mode)) {
      projectionPending = false;
      last = { trigger, at: new Date().toISOString(), skipped: true, reason: 'mode_not_active', mode: status.mode,
        activation_seq: status.activation_seq };
      return last;
    }
    running = true;
    const fail = error => {
      last = { trigger, at: new Date().toISOString(), ok: false, mode: status.mode,
        activation_seq: status.activation_seq, code: error?.code ?? 'strategy_tick_failed',
        error: error instanceof Error ? error.message : String(error) };
      logger?.warn?.(`  v9派生失败（${last.code}）：${last.error}`);
      return last;
    };
    const complete = result => {
      if (stopped) return { skipped: true, reason: 'stopped' };
      last = { trigger, at: new Date().toISOString(), ok: true, mode: status.mode,
        activation_seq: status.activation_seq, persisted: result?.persisted === true,
        pending: result?.pending === true, job_id: result?.job_id ?? null,
        input_fingerprint: result?.input_fingerprint ?? null };
      // Only a fresh result changes the strategy projection. An unchanged
      // fingerprint returns existing=true, so a periodic tick must not rewrite
      // the message center every five minutes.
      if (typeof onDerived === 'function' && result?.result && (result.existing !== true || projectionPending)) {
        try {
          onDerived({ job_id: result.job_id ?? null, result: result.result });
          projectionPending = false;
        } catch (error) {
          projectionPending = true;
          last.projection_pending = true;
          logger?.warn?.(`  策略派生后投影失败：${error instanceof Error ? error.message : error}`);
        }
      }
      return last;
    };
    try {
      const result = runner ? runner.run(status) : strategy.recompute();
      if (result && typeof result.then === 'function') {
        return result.then(complete, fail).finally(() => { running = false; });
      }
      const completed = complete(result);
      running = false;
      return completed;
    } catch (error) {
      // The repository keeps the job for bounded retries and leaves the
      // watermark unchanged, so a later tick or restart replays the same input.
      running = false;
      return fail(error);
    }
  }
  function start() {
    if (stopped || timer || startupTimer) return;
    startupTimer = setTimeout(() => { startupTimer = null; tick('startup'); }, startupDelayMs);
    startupTimer.unref?.();
    timer = setInterval(() => tick('periodic'), intervalMs);
    timer.unref?.();
  }
  function stop() {
    stopped = true;
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    if (timer) { clearInterval(timer); timer = null; }
    return runner?.stop?.();
  }
  return { start, stop, run: tick, getStatus: () => ({ interval_ms: intervalMs, running, projection_pending: projectionPending, last }) };
}

module.exports = { createStrategyScheduler };
