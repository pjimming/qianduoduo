'use strict';

const { createMarketBriefSource } = require('./source');

function createMarketBriefService({ source = createMarketBriefSource(), now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  async function load(key, ttl, read) {
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return hit.value;
    if (pending.has(key)) return pending.get(key);
    const work = Promise.resolve().then(read).then((value) => {
      cache.delete(key);
      cache.set(key, { value, expires: now() + ttl });
      while (cache.size > 100) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  }
  return {
    async dates() {
      return { dates: await load('dates', 60000, () => source.dates()), source: '投资科学' };
    },
    async daily(date) {
      return { ...await load(date, 30000, () => source.daily(date)), source: '投资科学' };
    },
  };
}

module.exports = { createMarketBriefService };
