#!/usr/bin/env node
/**
 * 把一张多笔交易的截图按文本行切成单笔凭证，供视觉识别逐条处理。
 * 纯几何切分：不调用 OCR，也不需要联网。
 *
 * 用法：
 *   node scripts/split-trade-rows.mjs <截图> <输出目录> [--gap=70] [--min-height=90] [--padding=18]
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

function readOptions(argv) {
  const options = { gap: 70, minHeight: 90, padding: 18 };
  const positional = [];
  for (const arg of argv) {
    const match = arg.match(/^--(gap|min-height|padding)=(\d+)$/);
    if (match) {
      const key = match[1] === 'min-height' ? 'minHeight' : match[1];
      options[key] = Number(match[2]);
      continue;
    }
    if (arg.startsWith('--')) continue;
    positional.push(arg);
  }
  return { options, positional };
}

const { options, positional } = readOptions(process.argv.slice(2));
const [input, outputDir] = positional;
if (!input || !outputDir) {
  console.error(
    '用法：node scripts/split-trade-rows.mjs <截图> <输出目录> [--gap=70] [--min-height=90] [--padding=18]',
  );
  process.exit(2);
}

const { data, info } = await sharp(input)
  .grayscale()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;

const darkPerRow = new Array(height).fill(0);
for (let y = 0; y < height; y += 1) {
  const base = y * width * channels;
  let dark = 0;
  for (let x = 0; x < width; x += 1) {
    if (data[base + x * channels] < 160) dark += 1;
  }
  darkPerRow[y] = dark;
}

const bands = [];
let bandStart = -1;
for (let y = 0; y < height; y += 1) {
  const active = darkPerRow[y] > 3;
  if (active && bandStart < 0) bandStart = y;
  if (!active && bandStart >= 0) {
    bands.push([bandStart, y - 1]);
    bandStart = -1;
  }
}
if (bandStart >= 0) bands.push([bandStart, height - 1]);

const groups = [];
for (const band of bands) {
  const last = groups[groups.length - 1];
  if (last && band[0] - last[1] <= options.gap) {
    last[1] = band[1];
  } else {
    groups.push([band[0], band[1]]);
  }
}

const rows = groups.filter(
  ([top, bottom]) => bottom - top + 1 >= options.minHeight,
);
// 首段通常是状态栏/标题/筛选栏。若它与第一笔之间的空隙明显大于行间
// 常规间距，就把这一段当作页头丢掉，避免每条截图多一次识图。
if (rows.length > 1) {
  const gaps = rows.slice(1).map((row, index) => row[0] - rows[index][1]);
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)] || 0;
  if (gaps[0] > Math.max(120, medianGap * 1.8)) rows.shift();
}
if (!rows.length) {
  console.log(JSON.stringify({ count: 0, rows: [], error: '没有找到可切分的文本行' }));
  process.exit(1);
}

fs.mkdirSync(outputDir, { recursive: true });
const written = [];
rows.forEach(([top, bottom], index) => {
  const cropTop = Math.max(0, top - options.padding);
  const cropBottom = Math.min(height - 1, bottom + options.padding);
  const file = path.join(
    outputDir,
    `row-${String(index + 1).padStart(2, '0')}.png`,
  );
  written.push({
    file,
    y: cropTop,
    height: cropBottom - cropTop + 1,
  });
});

for (const row of written) {
  await sharp(input)
    .extract({ left: 0, top: row.y, width, height: row.height })
    .png()
    .toFile(row.file);
}

console.log(
  JSON.stringify({ count: written.length, source: input, rows: written }, null, 2),
);
