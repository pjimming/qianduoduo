#!/usr/bin/env node
/**
 * Build the public GitHub Pages artifact.
 *
 * Only stock research reports, the standalone report library, and the static
 * A-share technology map are allowed. R2 application code and data are never
 * copied into the artifact.
 */

import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
export const PROJECT_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')

const FIXED_FILES = Object.freeze([
  ['research/index.html', 'research/index.html'],
  ['scripts/report-nav.js', 'scripts/report-nav.js'],
  ['public/research/techmap/index.html', 'public/research/techmap/index.html'],
  ['public/research/techmap/tree.html', 'public/research/techmap/tree.html'],
  ['public/research/techmap/table.html', 'public/research/techmap/table.html'],
])

const FORBIDDEN_SEGMENTS = new Set([
  '.git',
  '.github',
  'backups',
  'data',
  'dist',
  'income-inbox',
  'node_modules',
  'run',
  'server',
  'src',
  'trade-inbox',
])

const FORBIDDEN_CONTENT_MARKERS = Object.freeze([
  'data/r2_ledger',
  'cmb_r2_',
  'holding-valuation-evidence',
  'yield-observations',
])

function toPosix(filePath) {
  return filePath.split(path.sep).join('/')
}

function assertSafeOutput(outputDir) {
  const resolved = path.resolve(outputDir)
  const root = path.parse(resolved).root
  if (resolved === root || resolved === PROJECT_ROOT) {
    throw new Error(`拒绝使用过宽的 Pages 输出目录：${resolved}`)
  }
  if (path.basename(resolved) !== 'pages-site') {
    throw new Error(`Pages 输出目录必须命名为 pages-site：${resolved}`)
  }
  if (resolved.includes(`${path.sep}.git${path.sep}`)) {
    throw new Error(`Pages 输出目录不能位于 .git 内：${resolved}`)
  }
  return resolved
}

async function listFiles(rootDir) {
  const files = []

  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name)
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, relative)
      } else if (entry.isFile()) {
        files.push(relative)
      }
    }
  }

  await walk(rootDir)
  return files.sort((left, right) => left.localeCompare(right, 'en'))
}

function expectedFiles(reportFiles) {
  return [
    ...FIXED_FILES.map(([, target]) => target),
    ...reportFiles.map((file) => `report/${file}`),
    '.nojekyll',
  ].sort((left, right) => left.localeCompare(right, 'en'))
}

export async function readReportManifest(rootDir = PROJECT_ROOT) {
  const manifestPath = path.join(rootDir, 'src', 'data', 'stockReports.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const reports = Array.isArray(manifest.reports) ? manifest.reports : []
  const files = reports.map((report) => String(report.file || '')).filter(Boolean)

  if (!files.length) {
    throw new Error('stockReports.json 没有可发布的报告')
  }
  if (Number(manifest.count) !== files.length) {
    throw new Error(
      `stockReports.json 数量不一致：count=${manifest.count}，reports=${files.length}`,
    )
  }
  if (new Set(files).size !== files.length) {
    throw new Error('stockReports.json 存在重复报告文件名')
  }
  if (files.some((file) => path.basename(file) !== file || !file.endsWith('.html'))) {
    throw new Error('stockReports.json 含非法报告文件名')
  }

  return {
    manifest,
    files: files.sort((left, right) => left.localeCompare(right, 'zh-Hans-CN')),
  }
}

export async function auditPagesArtifact(outputDir, options = {}) {
  const { rootDir = PROJECT_ROOT } = options
  const { files: manifestReports } = await readReportManifest(rootDir)
  const actualFiles = await listFiles(outputDir)
  const expected = expectedFiles(manifestReports)

  if (JSON.stringify(actualFiles) !== JSON.stringify(expected)) {
    const actualSet = new Set(actualFiles)
    const expectedSet = new Set(expected)
    const unexpected = actualFiles.filter((file) => !expectedSet.has(file))
    const missing = expected.filter((file) => !actualSet.has(file))
    throw new Error(
      `Pages 白名单不一致；多余=${unexpected.join(',') || '无'}；缺少=${missing.join(',') || '无'}`,
    )
  }

  for (const file of actualFiles) {
    const segments = file.split('/')
    const forbidden = segments.find((segment) => FORBIDDEN_SEGMENTS.has(segment))
    if (forbidden) {
      throw new Error(`Pages 产物包含禁止路径 ${forbidden}：${file}`)
    }
    if (
      file !== '.nojekyll' &&
      !file.endsWith('.html') &&
      !file.endsWith('.js')
    ) {
      throw new Error(`Pages 产物包含非白名单文件类型：${file}`)
    }

    const fileStat = await stat(path.join(outputDir, ...segments))
    if (!fileStat.isFile() || (file !== '.nojekyll' && fileStat.size === 0)) {
      throw new Error(`Pages 产物文件为空或不是普通文件：${file}`)
    }
    if (file.endsWith('.html') || file.endsWith('.js')) {
      const content = await readFile(path.join(outputDir, ...segments), 'utf8')
      const marker = FORBIDDEN_CONTENT_MARKERS.find((value) => content.includes(value))
      if (marker) {
        throw new Error(`Pages 产物包含 R2 数据标记 ${marker}：${file}`)
      }
    }
  }

  return {
    files: actualFiles,
    reportCount: manifestReports.length,
    techMapViews: 3,
  }
}

export async function buildPagesSite(options = {}) {
  const {
    rootDir = PROJECT_ROOT,
    outputDir = path.join(rootDir, 'run', 'pages-site'),
  } = options
  const sourceRoot = path.resolve(rootDir)
  const targetRoot = assertSafeOutput(outputDir)
  const { files: manifestReports } = await readReportManifest(sourceRoot)
  const reportDir = path.join(sourceRoot, 'report')
  const sourceReports = (await readdir(reportDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))

  if (JSON.stringify(sourceReports) !== JSON.stringify(manifestReports)) {
    throw new Error('report/ 源文件与 stockReports.json 清单不一致，请重新生成报告索引')
  }

  await rm(targetRoot, { recursive: true, force: true })
  await mkdir(targetRoot, { recursive: true })

  for (const [source, target] of FIXED_FILES) {
    const destination = path.join(targetRoot, ...target.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(path.join(sourceRoot, ...source.split('/')), destination)
  }

  const reportTargetDir = path.join(targetRoot, 'report')
  await mkdir(reportTargetDir, { recursive: true })
  for (const file of sourceReports) {
    await copyFile(path.join(reportDir, file), path.join(reportTargetDir, file))
  }

  await writeFile(path.join(targetRoot, '.nojekyll'), '', 'utf8')

  const audit = await auditPagesArtifact(targetRoot, { rootDir: sourceRoot })
  return {
    outputDir: targetRoot,
    relativeOutputDir: toPosix(path.relative(sourceRoot, targetRoot)),
    ...audit,
  }
}

async function main() {
  const outputDir = path.resolve(
    process.argv[2] || path.join(PROJECT_ROOT, 'run', 'pages-site'),
  )
  const result = await buildPagesSite({ outputDir })
  console.log(
    `已生成 GitHub Pages 白名单产物 -> ${result.outputDir}（${result.reportCount} 篇报告、${result.techMapViews} 个科技图谱视图、共 ${result.files.length} 个文件）`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
