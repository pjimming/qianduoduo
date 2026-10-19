'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/db');
const { createDailyBackup, listBackups } = require('../lib/backup');
const { createServer, resolveProductCsv } = require('../server');

const { productCsv } = require('./fixtures');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'r2-hardening-'));
}

test('product CSV discovery prefers the newest dated snapshot', () => {
  const root = tempDir();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'cmb_r2_products_2026-09-01.csv'), 'name,code\n');
  fs.writeFileSync(path.join(dataDir, 'cmb_r2_products_2026-10-18.csv'), 'name,code\n');
  fs.writeFileSync(path.join(dataDir, 'other.csv'), 'x\n');

  const resolved = resolveProductCsv(root);
  assert.equal(path.basename(resolved), 'cmb_r2_products_2026-10-18.csv');
  fs.rmSync(root, { recursive: true, force: true });
});

test('product CSV discovery prefers the ordinary universe over the selected file', () => {
  const root = tempDir();
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'cmb_r2_products_2026-10-20.csv'), 'name,code\n');
  fs.writeFileSync(path.join(dataDir, 'cmb_r2_universe_2026-10-19.csv'), 'name,code\n');

  const resolved = resolveProductCsv(root);
  assert.equal(path.basename(resolved), 'cmb_r2_universe_2026-10-19.csv');
  fs.rmSync(root, { recursive: true, force: true });
});

test('daily backup creates one snapshot per day and lists it', () => {
  const directory = tempDir();
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: productCsv,
    logger: { warn() {} },
  });
  const result = createDailyBackup(repository.db, repository.dbPath, {
    today: '2026-10-18',
  });
  assert.equal(result.created, true);
  assert.ok(fs.existsSync(result.file));

  const again = createDailyBackup(repository.db, repository.dbPath, {
    today: '2026-10-18',
  });
  assert.equal(again.created, false);

  const backups = listBackups(repository.backupDir);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].date, '2026-10-18');
  assert.ok(backups[0].bytes > 0);

  repository.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function startTestServer(t) {
  const directory = tempDir();
  const repository = openDatabase({
    dbPath: path.join(directory, 'test.sqlite'),
    productCsvPath: productCsv,
    logger: { warn() {} },
  });
  const server = createServer({ repository });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    repository.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${port}`;
}

test('write API rejects cross-site origins and non-JSON bodies', async (t) => {
  const base = await startTestServer(t);

  const crossSite = await fetch(`${base}/api/products/refresh`, {
    method: 'POST',
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(crossSite.status, 403);

  const sameSite = await fetch(`${base}/api/products/refresh`, {
    method: 'POST',
    headers: { Origin: base },
  });
  assert.equal(sameSite.status, 200);

  const plainText = await fetch(`${base}/api/records`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ date: '2026-10-18', daily_pnl: 1 }),
  });
  assert.equal(plainText.status, 415);
});

test('static responses set cache, compression and HEAD headers', async (t) => {
  const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
  const assetsDir = path.join(__dirname, '..', 'dist', 'assets');
  if (!fs.existsSync(distIndex) || !fs.existsSync(assetsDir)) {
    t.skip('需要先执行 npm run build');
    return;
  }
  const base = await startTestServer(t);

  const page = await fetch(`${base}/investment/research`, {
    headers: { 'Accept-Encoding': 'gzip' },
  });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.match(page.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(page.headers.get('content-encoding'), 'gzip');
  assert.match(page.headers.get('vary') || '', /Accept-Encoding/);

  const assetName = fs.readdirSync(assetsDir).find((name) => name.endsWith('.js'));
  const asset = await fetch(`${base}/assets/${assetName}`, { method: 'HEAD' });
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('cache-control') || '', /immutable/);
  assert.equal(await asset.text(), '');

  const mediaRoot = path.join(__dirname, '..', 'dist', 'research', 'media');
  if (fs.existsSync(mediaRoot)) {
    const folder = fs.readdirSync(mediaRoot).find((name) => {
      const full = path.join(mediaRoot, name);
      return fs.statSync(full).isDirectory() && fs.readdirSync(full).length > 0;
    });
    if (folder) {
      const image = fs.readdirSync(path.join(mediaRoot, folder))[0];
      const media = await fetch(
        `${base}/research/media/${encodeURIComponent(folder)}/${encodeURIComponent(image)}`,
        { method: 'HEAD' },
      );
      assert.equal(media.status, 200);
      assert.match(media.headers.get('content-type') || '', /^image\//);
      assert.match(media.headers.get('cache-control') || '', /immutable/);
    }
  }
});
