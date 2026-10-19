'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const OCR_SCRIPT = path.join(__dirname, '..', 'scripts', 'ocr-image.ps1');

function parseOcrOutput(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      return {
        ok: Boolean(parsed.ok),
        text: String(parsed.text || ''),
        language: parsed.language || null,
        error: parsed.error || '',
        available: Array.isArray(parsed.available) ? parsed.available : [],
      };
    } catch {
      continue;
    }
  }
  return {
    ok: false,
    text: '',
    language: null,
    error: 'OCR 没有返回可解析结果',
    available: [],
  };
}

/**
 * 使用 Windows 自带的 OCR 引擎识别本地截图。它只读取图片，
 * 不上传、不登录银行，也不会保存任何凭据。
 */
function ocrImage(filePath, options = {}) {
  if (process.env.R2_OCR === '0') {
    return Promise.resolve({
      ok: false,
      text: '',
      language: null,
      error: '已通过 R2_OCR=0 关闭本地 OCR',
      available: [],
    });
  }
  return new Promise((resolve) => {
    const child = spawn(
      options.powershell || 'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        OCR_SCRIPT,
        '-Path',
        filePath,
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({
        ok: false,
        text: '',
        language: null,
        error: 'OCR 超时',
        available: [],
      });
    }, options.timeoutMs || 25000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        text: '',
        language: null,
        error: `无法启动本地 OCR：${error.message}`,
        available: [],
      });
    });
    child.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const parsed = parseOcrOutput(stdout);
      if (!parsed.ok && !parsed.error && stderr.trim()) {
        parsed.error = stderr.trim().slice(0, 500);
      }
      resolve(parsed);
    });
  });
}

module.exports = {
  OCR_SCRIPT,
  ocrImage,
  parseOcrOutput,
};
