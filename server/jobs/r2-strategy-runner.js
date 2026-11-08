'use strict';

const { Worker } = require('node:worker_threads');

function createStrategyRunner({ dbPath, screeningPath = null, timeoutMs = 330000,
  workerFactory = (file, options) => new Worker(file, options) }) {
  let active = null, stopped = false;
  function run({ mode, activation_seq: expectedSeq } = {}) {
    if (stopped) return Promise.reject(Object.assign(new Error('策略运行器已停止'), { code: 'strategy_stopped' }));
    if (active) return active.promise;
    let worker, timer, settle;
    const promise = new Promise((resolve, reject) => {
      let message, error, finished = false;
      settle = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); active = null;
        if (error) reject(error);
        else if (message?.ok) resolve(message.result);
        else reject(Object.assign(new Error(message?.error ?? '策略worker退出时未返回结果'), { code: message?.code ?? 'strategy_worker_failed' }));
      };
      try {
        worker = workerFactory(require.resolve('./r2-strategy-worker'), { workerData: {
          action: 'recompute', dbPath, screeningPath, expectedSeq, mode, refreshHoldings: true,
        } });
        worker.once('message', value => { message = value; });
        worker.once('error', value => { error = value; });
        worker.once('exit', settle);
        timer = setTimeout(() => {
          error = Object.assign(new Error(`策略worker超过${timeoutMs}ms，已终止`), { code: 'strategy_timeout' });
          Promise.resolve(worker.terminate()).then(settle, settle);
        }, timeoutMs);
        timer.unref?.();
      } catch (value) { error = value; queueMicrotask(settle); }
    });
    active = { promise, worker, settle };
    return promise;
  }
  async function stop() {
    stopped = true;
    if (!active) return;
    const current = active;
    let graceTimer;
    current.worker?.postMessage?.({ action: 'stop' });
    // Give the collector's AbortSignal/finally a chance to close its browser.
    await Promise.race([current.promise.catch(() => {}), new Promise(resolve => {
      graceTimer = setTimeout(resolve, 5000); graceTimer.unref?.();
    })]);
    clearTimeout(graceTimer);
    if (active === current) {
      await current.worker?.terminate();
      current.settle();
    }
    await current.promise.catch(() => {});
  }
  return { run, stop, isRunning: () => Boolean(active) };
}

module.exports = { createStrategyRunner };
