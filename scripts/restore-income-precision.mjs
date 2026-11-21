import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import dbModule from '../lib/db.js';
import precision from '../lib/income-precision.js';
import backup from '../server/infrastructure/backup/sqlite-backup.js';

function assertExpectedFact(row, item) {
  if (!row || row.product_code !== item.product_code || row.yield_date !== item.yield_date) throw new Error(`目标事实身份变化 #${item.id}`);
  if (row.daily_pnl_1e4 === item.daily_pnl_1e4 && Number(row.daily_pnl_precision ?? row.source_precision) === 4) return;
  if (!Object.hasOwn(item, 'expected_daily_pnl_1e4') || !Object.hasOwn(item, 'expected_source_precision')) throw new Error('清单必须明确记录原精度状态');
  if (Number(row.daily_pnl) !== item.expected_daily_pnl || (row.daily_pnl_1e4 ?? null) !== item.expected_daily_pnl_1e4 ||
      (row.daily_pnl_precision ?? row.source_precision ?? null) !== item.expected_source_precision ||
      (item.expected_updated_at != null && row.updated_at !== item.expected_updated_at)) throw new Error(`目标事实原值或精度变化 #${item.id}`);
}

const args = process.argv.slice(2);
const value = key => args[args.indexOf(key) + 1];
if (!args.includes('--db') || !args.includes('--manifest')) throw new Error('必须显式指定 --db PATH --manifest PATH [--apply]');
const dbPath = path.resolve(value('--db'));
const manifest = JSON.parse(fs.readFileSync(value('--manifest'), 'utf8'));
const probe = new DatabaseSync(dbPath, { readOnly: true });
try {
  for (const item of manifest.records) {
    const row = probe.prepare('SELECT * FROM product_daily_valuations WHERE id=?').get(item.id);
    const inbox = probe.prepare('SELECT sha256,stored_name FROM income_inbox WHERE id=?').get(item.screenshot_id);
    assertExpectedFact(row, item);
    if (!inbox || inbox.sha256 !== item.source_sha256) throw new Error(`截图身份变化 #${item.screenshot_id}`);
    const source = path.resolve(manifest.income_inbox_dir, inbox.stored_name);
    const actualHash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    if (actualHash !== item.source_sha256) throw new Error(`截图文件校验失败 #${item.screenshot_id}`);
    precision.assertIncomeUnits(item.daily_pnl_1e4);
  }
} finally { probe.close(); }
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ mode: 'preflight', verified_records: manifest.records.length }));
} else {
  const backupPath = path.resolve(args.includes('--backup') ? value('--backup') : `${dbPath}.income-restore-${Date.now()}.backup`);
  if (backupPath === dbPath || fs.existsSync(backupPath)) throw new Error('恢复前备份不得覆盖现有文件');
  backup.createConsistentSnapshot(dbPath, backupPath);
  backup.validateDatabase(backupPath);
  const repository = dbModule.openDatabase({ dbPath,
    incomeInboxDir: manifest.income_inbox_dir,
    holdingValuationEvidenceDir: manifest.bank_evidence_dir,
    productCsvPath: null, logger: { info() {}, warn() {} } });
  try {
    let changed = 0;
    repository.transactionManager.run(() => {
      for (const item of manifest.records) {
        const before = repository.productValuationStore.getValuation(item.id);
        assertExpectedFact(before, item);
        if (before.daily_pnl_1e4 === item.daily_pnl_1e4 && before.source_precision === 4) continue;
        const note = `逐图核验恢复原始四位精度；来源截图#${item.screenshot_id}${item.source_qualifier ? '；' + item.source_qualifier : ''}`;
        repository.productValuationStore.updateValuationById(item.id, {
          daily_pnl: precision.roundIncomeUnitsToCents(item.daily_pnl_1e4) / 100,
          daily_pnl_1e4: item.daily_pnl_1e4, source_precision: 4,
          screenshot_id: item.screenshot_id, notes: [before.notes, note].filter(Boolean).join('；'),
        }, { source: 'manual-correction', auditNote: note });
        changed++;
      }
      if (changed) repository.syncAllAccountRecordsFromProducts({ operationId: manifest.operation_id });
    });
    console.log(JSON.stringify({ mode: 'applied', verified_records: manifest.records.length, changed,
      integrity: repository.db.prepare('PRAGMA quick_check').get().quick_check }));
  } finally { repository.close(); }
}
