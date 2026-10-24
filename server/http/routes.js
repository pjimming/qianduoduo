'use strict';

const API_ROUTE_PATTERNS = Object.freeze([
  ['GET', '/api/health'],
  ['GET', '/api/backups'],
  ['POST', '/api/backups'],
  ['GET', '/api/dashboard'],
  ['POST', '/api/dashboard/refresh'],
  ['GET', '/api/data-trust/status'],
  ['GET', /^\/api\/evidence\/\d+\/trace$/],
  ['GET', /^\/api\/facts\/[^/]+\/[^/]+\/trace$/],

  ['POST', '/api/capital/init'],
  ['PUT', '/api/capital/init'],
  ['POST', '/api/capital/events'],
  ['DELETE', /^\/api\/capital\/events\/\d+$/],

  ['POST', '/api/products/refresh'],
  ['PUT', '/api/products/allocation'],
  ['PUT', /^\/api\/holding-reviews\/[^/]+$/],

  ['GET', '/api/review/workspace'],
  ['GET', '/api/inbox'],
  ['POST', '/api/inbox/confirmations'],
  ['POST', '/api/inbox/read-all'],
  ['POST', /^\/api\/inbox\/\d+\/(?:read|unread|snooze|unsnooze)$/],

  ['GET', '/api/automation/workspace'],
  ['GET', '/api/calibration/monthly'],
  ['POST', /^\/api\/calibration\/predictions\/[^/]+\/confirm$/],
  ['GET', /^\/api\/calibration\/predictions\/[^/]+$/],
  ['GET', '/api/decision-proposals'],
  ['POST', /^\/api\/decision-proposals\/\d+\/(?:adopt|reject)$/],
  ['POST', '/api/automation/run'],
  ['PUT', '/api/automation/settings'],
  ['POST', /^\/api\/evaluations\/\d+\/apply$/],
  ['POST', /^\/api\/evaluations\/\d+\/undo$/],

  ['POST', '/api/notifications/read-all'],
  ['POST', /^\/api\/notifications\/\d+\/(?:read|unread|resolve)$/],
  ['POST', /^\/api\/automation\/jobs\/\d+\/resolve$/],
  [
    'GET',
    /^\/api\/review\/drafts\/(?:monthly|quarterly)\/\d{4}-(?:\d{2}|Q[1-4])$/,
  ],
  [
    'POST',
    /^\/api\/review\/drafts\/(?:monthly|quarterly)\/\d{4}-(?:\d{2}|Q[1-4])\/(?:generate|confirm)$/,
  ],

  ['GET', '/api/income/inbox'],
  ['POST', '/api/income/inbox/prune'],
  ['POST', '/api/income/inbox'],
  ['GET', /^\/api\/income\/inbox\/\d+\/image$/],
  ['POST', /^\/api\/income\/inbox\/\d+\/apply$/],
  ['POST', /^\/api\/income\/inbox\/\d+\/ignore$/],

  ['GET', '/api/product-valuations'],
  ['GET', '/api/product-yield-settings'],
  ['PUT', /^\/api\/product-yield-settings\/[A-Za-z0-9-]+$/],
  ['POST', '/api/product-valuations'],
  ['PUT', /^\/api\/product-valuations\/\d+$/],
  ['GET', '/api/holding-valuations'],
  ['POST', '/api/holding-valuations'],
  ['POST', '/api/holding-valuations/evidence'],
  ['GET', /^\/api\/holding-valuations\/evidence\/\d+\/image$/],

  ['GET', '/api/trades'],
  ['POST', '/api/trades'],
  ['POST', /^\/api\/trades\/\d+\/confirm$/],
  ['POST', /^\/api\/trades\/\d+\/cancel$/],
  ['GET', /^\/api\/trades\/\d+\/audit$/],
  ['PUT', /^\/api\/trades\/\d+$/],
  ['POST', '/api/trades/inbox/prune'],
  ['GET', '/api/trades/inbox'],
  ['POST', '/api/trades/inbox'],
  ['GET', /^\/api\/trades\/inbox\/\d+\/image$/],
  ['POST', /^\/api\/trades\/inbox\/\d+\/apply$/],
  ['POST', /^\/api\/trades\/inbox\/\d+\/vision-apply$/],
  ['POST', /^\/api\/trades\/inbox\/\d+\/ignore$/],
  ['PUT', /^\/api\/trades\/inbox\/\d+$/],

  ['POST', '/api/review/decisions'],
  ['POST', /^\/api\/review\/decisions\/\d+\/predictions$/],
  ['PUT', /^\/api\/review\/decisions\/\d+$/],
  ['DELETE', /^\/api\/review\/decisions\/\d+$/],
  ['POST', '/api/review/holdings'],
  ['PUT', /^\/api\/review\/holdings\/\d+$/],
  ['DELETE', /^\/api\/review\/holdings\/\d+$/],
  ['POST', '/api/review/events'],
  ['PUT', /^\/api\/review\/events\/\d+$/],
  ['DELETE', /^\/api\/review\/events\/\d+$/],
  ['PUT', /^\/api\/review\/notes\/\d{4}-(?:0[1-9]|1[0-2])$/],
  ['PUT', /^\/api\/review\/quarterly\/\d{4}-Q[1-4]$/],
  ['GET', '/api/review/export'],

  ['POST', '/api/records'],
  ['PUT', /^\/api\/records\/\d{4}-\d{2}-\d{2}$/],
  ['DELETE', /^\/api\/records\/\d{4}-\d{2}-\d{2}$/],
  ['GET', '/api/export.csv'],
]);

function routeKey(method, pattern) {
  const normalizedPattern =
    pattern instanceof RegExp
      ? `/${pattern.source
          .replace(/\(\?:/g, '(')
          .replace(/[()]/g, '')}/${pattern.flags}`
      : String(pattern);
  return `${String(method).toUpperCase()} ${
    normalizedPattern
  }`;
}

module.exports = {
  API_ROUTE_PATTERNS,
  routeKey,
};
