import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import store from '../lib/product-holding-income-store.js';

const [action = 'status', dbArg = 'data/r2_ledger.sqlite'] = process.argv.slice(2);
if (!['status', 'apply', 'verify'].includes(action)) throw new Error('用法：status|apply|verify [database]');
const db = new DatabaseSync(path.resolve(dbArg), { readOnly: action !== 'apply' });
try {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (action === 'apply') store.migrateProductHoldingIncome(db);
  const migrated = store.hasProductHoldingIncomeSchema(db);
  const integrity = db.prepare('PRAGMA quick_check').get().quick_check;
  console.log(JSON.stringify({ version: 'product-holding-income-v1', migrated, integrity }));
  if (action === 'verify' && (!migrated || integrity !== 'ok')) process.exitCode = 1;
} finally { db.close(); }
