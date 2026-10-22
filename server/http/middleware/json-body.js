'use strict';

function readJsonBody(request, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const contentType = String(request.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      request.resume();
      const error = new Error('请求需要 application/json');
      error.statusCode = 415;
      reject(error);
      return;
    }
    let body = '';
    let size = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        const error = new Error('请求内容过大');
        error.statusCode = 413;
        reject(error);
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('请求不是有效的 JSON'));
      }
    });
    request.on('error', reject);
  });
}

module.exports = {
  readJsonBody,
};
