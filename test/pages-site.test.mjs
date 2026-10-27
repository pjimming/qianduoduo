import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
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

async function serveArtifact(t, outputDir) {
  const rootDir = path.resolve(outputDir)
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url || '/', 'http://127.0.0.1').pathname,
      )
      const filePath = path.resolve(rootDir, `.${pathname}`)
      if (
        filePath !== rootDir &&
        !filePath.startsWith(`${rootDir}${path.sep}`)
      ) {
        response.writeHead(403)
        response.end()
        return
      }
      const content = await readFile(filePath)
      response.writeHead(200, {
        'content-type': filePath.endsWith('.html')
          ? 'text/html; charset=utf-8'
          : 'application/octet-stream',
      })
      response.end(content)
    } catch {
      response.writeHead(404)
      response.end()
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve)
      }),
  )
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

function artifactUrl(origin, relativePath) {
  const encoded = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${origin}/${encoded}`
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

test('every published report and tech map view returns to the report library', async (t) => {
  const { outputDir, result } = await temporaryBuild(t)
  const { files: reportFiles } = await readReportManifest()
  const origin = await serveArtifact(t, outputDir)
  const pages = [
    ...reportFiles.map((file) => ({
      path: `report/${file}`,
      marker: 'data-report-page-home',
      href: '../research/index.html',
    })),
    ...['index.html', 'tree.html', 'table.html'].map((file) => ({
      path: `public/research/techmap/${file}`,
      marker: 'data-research-home',
      href: '../../../research/index.html',
    })),
  ]

  for (const page of pages) {
    const response = await fetch(artifactUrl(origin, page.path))
    assert.equal(response.status, 200, `${page.path} 未返回 200`)
    const html = await response.text()
    const links = [
      ...html.matchAll(
        new RegExp(
          `<a\\b(?=[^>]*\\b${page.marker}\\b)[^>]*>[\\s\\S]*?<\\/a>`,
          'gi',
        ),
      ),
    ]
    assert.equal(links.length, 1, `${page.path} 应有且仅有一个首页链接`)
    assert.ok(
      links[0][0].includes(`href="${page.href}"`),
      `${page.path} 的首页链接应指向 ${page.href}`,
    )
    assert.match(links[0][0], /返回首页/u)

    const homeResponse = await fetch(
      new URL(page.href, response.url),
    )
    assert.equal(homeResponse.status, 200, `${page.path} 的首页链接未返回 200`)
    assert.match(await homeResponse.text(), /股票调研报告库/u)
  }

  assert.equal(result.reportCount, reportFiles.length)
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
