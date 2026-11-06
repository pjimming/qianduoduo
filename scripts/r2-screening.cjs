#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseArgs } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { openScreeningRepository } = require('../server/modules/r2-screening/repository');
const { createScreeningService, terminal } = require('../server/modules/r2-screening/service');

async function dryRun(fixture) {
  const input = fixture ? JSON.parse(fs.readFileSync(fixture, 'utf8')) : null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qdd-screening-'));
  const repository = openScreeningRepository(path.join(dir, 'screening.sqlite'), { initialize: true });
  const service = createScreeningService({
    repository, enabled: true, schedule: false,
    ...(input && { collector: async () => input, clock: () => new Date(input.date + 'T12:00:00+08:00') }),
  });
  try {
    const { run } = service.manual(randomUUID());
    for (let elapsed = 0; elapsed <= 330000; elapsed += 200) {
      const result = service.runDetail(run.id);
      if (terminal.has(result.status)) {
        if (!result.counts) process.exitCode = 1;
        return { dry_run: true, ...result };
      }
      await delay(200);
    }
    throw new Error('等待初筛完成超过上限');
  } finally {
    await service.stop();
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { 'dry-run': { type: 'boolean' }, fixture: { type: 'string' }, port: { type: 'string' }, key: { type: 'string' } },
  });
  if (values.fixture && !values['dry-run']) throw new Error('--fixture 只用于 --dry-run');
  if (values['dry-run']) return console.log(JSON.stringify(await dryRun(values.fixture), null, 2));
  const [action = 'status'] = positionals;
  const port = Number(values.port ?? process.env.PORT ?? 8765);
  if (!['status', 'refresh'].includes(action) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('使用 status、refresh 或 --dry-run [--fixture <文件>]');
  }
  const response = await fetch(`http://127.0.0.1:${port}/api/r2-screening/${action === 'status' ? 'status' : 'runs'}`, {
    ...(action === 'refresh' && { method: 'POST', headers: { 'Idempotency-Key': values.key ?? randomUUID() } }),
    signal: AbortSignal.timeout(8000),
  });
  console.log(JSON.stringify(await response.json(), null, 2));
  if (!response.ok) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
