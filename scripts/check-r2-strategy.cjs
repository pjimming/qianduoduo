'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const folder = path.join(root, 'server/modules/r2-strategy');
const files = fs.readdirSync(folder).filter(name => name.endsWith('.js')).map(name => path.join(folder, name));
files.push(...fs.readdirSync(path.join(root, 'server/jobs'))
  .filter(name => /^r2-(strategy|holding-monitor).*\.js$/.test(name))
  .map(name => path.join(root, 'server/jobs', name)),
  path.join(root, 'scripts/r2-strategy.cjs'), path.join(root, 'scripts/migrate-r2-strategy.mjs'));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { windowsHide: true, encoding: 'utf8' });
  if (result.status !== 0) { process.stderr.write(result.stderr || result.error?.message || '策略语法检查失败'); process.exitCode = 1; break; }
}
