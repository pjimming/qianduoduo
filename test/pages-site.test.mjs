import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  auditPagesArtifact,
  buildPagesSite,
  PROJECT_ROOT,
  readReportManifest,
} from '../scripts/build-pages-site.mjs'

async function temporaryBuild(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pages-site-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const outputDir = path.join(root, 'pages-site')
  const result = await buildPagesSite({ outputDir })
  return { root, outputDir, result }
}

test('Pages artifact contains every report, the report library, and all tech map views', async (t) => {
  const { result } = await temporaryBuild(t)
  const { manifest, files: reportFiles } = await readReportManifest()

  assert.equal(result.reportCount, manifest.count)
  assert.equal(result.reportCount, reportFiles.length)
  assert.equal(result.techMapViews, 3)
  assert.equal(result.files.length, reportFiles.length + 6)

  for (const expected of [
    'research/index.html',
    'scripts/report-nav.js',
    'public/research/techmap/index.html',
    'public/research/techmap/tree.html',
    'public/research/techmap/table.html',
    '.nojekyll',
    ...reportFiles.map((file) => `report/${file}`),
  ]) {
    assert.ok(result.files.includes(expected), `缺少 Pages 文件：${expected}`)
  }

  const navigation = await readFile(
    path.join(result.outputDir, 'scripts', 'report-nav.js'),
    'utf8',
  )
  assert.equal(
    [...navigation.matchAll(/\{\s*f:\s*"[^"]+"/gu)].length,
    reportFiles.length,
  )
  for (const file of reportFiles) {
    assert.ok(navigation.includes(`f: "${file}"`), `导航缺少报告：${file}`)
  }

  const techMapIndex = await readFile(
    path.join(result.outputDir, 'public', 'research', 'techmap', 'index.html'),
    'utf8',
  )
  assert.match(techMapIndex, /href="\.\/tree\.html"/)
  assert.match(techMapIndex, /href="\.\/table\.html"/)
})

test('Pages artifact excludes R2 data, application code, and unlisted tech map files', async (t) => {
  const { outputDir, result } = await temporaryBuild(t)
  assert.equal(result.files.some((file) => file.split('/').includes('data')), false)
  assert.equal(result.files.some((file) => file.startsWith('src/')), false)
  assert.equal(result.files.some((file) => file.startsWith('server/')), false)
  assert.equal(result.files.some((file) => file.startsWith('dist/')), false)
  assert.equal(result.files.some((file) => file.endsWith('.sqlite')), false)
  assert.equal(result.files.some((file) => file.endsWith('.jpg')), false)
  assert.equal(
    result.files.includes('public/research/techmap/README.md'),
    false,
  )

  const indexHtml = await readFile(
    path.join(outputDir, 'research', 'index.html'),
    'utf8',
  )
  assert.match(indexHtml, /report-nav\.js/)
})

test('artifact audit rejects any file outside the exact allowlist', async (t) => {
  const { outputDir } = await temporaryBuild(t)
  const unexpected = path.join(outputDir, 'data', 'r2_ledger.sqlite')

  await mkdir(path.dirname(unexpected), { recursive: true })
  await writeFile(unexpected, 'forbidden', 'utf8')
  await assert.rejects(
    auditPagesArtifact(outputDir, { rootDir: PROJECT_ROOT }),
    /Pages 白名单不一致/,
  )
})

test('artifact audit rejects R2 references inside otherwise allowed files', async (t) => {
  const { outputDir } = await temporaryBuild(t)
  const indexPath = path.join(outputDir, 'research', 'index.html')
  const html = await readFile(indexPath, 'utf8')

  await writeFile(indexPath, `${html}\n<!-- data/r2_ledger.sqlite -->\n`, 'utf8')
  await assert.rejects(
    auditPagesArtifact(outputDir, { rootDir: PROJECT_ROOT }),
    /Pages 产物包含 R2 数据标记/,
  )
})

test('Pages workflow delegates to the allowlisted builder with Pages permissions', async () => {
  const workflow = await readFile(
    path.join(PROJECT_ROOT, '.github', 'workflows', 'deploy-pages.yml'),
    'utf8',
  )

  assert.match(workflow, /contents:\s*read/u)
  assert.match(workflow, /pages:\s*write/u)
  assert.match(workflow, /id-token:\s*write/u)
  assert.match(workflow, /actions\/setup-node@v4/u)
  assert.match(workflow, /npm ci/u)
  assert.match(workflow, /npm run build/u)
  assert.match(workflow, /npm test/u)
  assert.ok(
    workflow.indexOf("npm run build") < workflow.indexOf("npm test"),
    "GitHub Pages workflow must build production static files before integration tests",
  )
  assert.match(workflow, /node scripts\/build-pages-site\.mjs/u)
  assert.match(workflow, /actions\/upload-pages-artifact@v3/u)
  assert.match(workflow, /actions\/deploy-pages@v4/u)
  assert.doesNotMatch(workflow, /enablement:\s*true/u)
})

test('builder refuses a broad output directory', async () => {
  await assert.rejects(
    buildPagesSite({ outputDir: PROJECT_ROOT }),
    /拒绝使用过宽的 Pages 输出目录/,
  )
})
