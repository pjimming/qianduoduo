'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { SECURITY_HEADERS, sendError } = require('./response');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const HTML_CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

function createStaticService(rootDir) {
  const staticDir = path.resolve(rootDir);

  function sendStaticFile(filePath, response, request, knownStats = null) {
    fs.stat(filePath, (error, stats) => {
      if (error || !stats.isFile()) {
        sendError(response, 404, '页面不存在');
        return;
      }
      const finalStats = knownStats || stats;
      const extension = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[extension] || 'application/octet-stream';
      const isHashedAsset =
        filePath.includes(`${path.sep}assets${path.sep}`) ||
        filePath.includes(`${path.sep}research${path.sep}media${path.sep}`);
      const compressible = /^(text\/|application\/(json|javascript|xml)|image\/svg)/.test(
        contentType,
      );
      const useGzip =
        compressible &&
        /\bgzip\b/.test(String(request.headers['accept-encoding'] || ''));
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': isHashedAsset
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        ...SECURITY_HEADERS,
        ...(compressible ? { Vary: 'Accept-Encoding' } : {}),
        ...(useGzip
          ? { 'Content-Encoding': 'gzip' }
          : { 'Content-Length': finalStats.size }),
        ...(extension === '.html'
          ? { 'Content-Security-Policy': HTML_CSP }
          : {}),
      };
      response.writeHead(200, headers);
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const stream = fs.createReadStream(filePath);
      if (useGzip) {
        stream.pipe(zlib.createGzip()).pipe(response);
      } else {
        stream.pipe(response);
      }
    });
  }

  function serveStatic(request, response, pathname) {
    let relative;
    try {
      relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    } catch {
      sendError(response, 400, '路径格式不正确');
      return;
    }
    const filePath = path.resolve(staticDir, `.${relative}`);
    const expectedPrefix = `${staticDir}${path.sep}`;
    if (!filePath.startsWith(expectedPrefix)) {
      sendError(response, 403, '禁止访问');
      return;
    }
    fs.stat(filePath, (error, stats) => {
      if (error || !stats.isFile()) {
        if (
          !path.extname(filePath) &&
          (request.method === 'GET' || request.method === 'HEAD')
        ) {
          sendStaticFile(path.join(staticDir, 'index.html'), response, request);
          return;
        }
        sendError(response, 404, '页面不存在');
        return;
      }
      sendStaticFile(filePath, response, request, stats);
    });
  }

  return {
    rootDir: staticDir,
    sendStaticFile,
    serveStatic,
  };
}

module.exports = {
  HTML_CSP,
  MIME_TYPES,
  createStaticService,
};
