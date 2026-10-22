'use strict';

const IMAGE_MIME_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

function decodeImagePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { error: '图片格式不正确' };
  }
  const raw = String(payload.data || payload.image || '');
  if (!raw) return { error: '请选择成交截图' };
  const dataUrl = raw.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/,
  );
  const mime = String(payload.mime || dataUrl?.[1] || '').toLowerCase();
  if (!IMAGE_MIME_EXTENSIONS[mime]) {
    return { error: '只支持 PNG、JPEG 或 WebP 截图' };
  }
  const base64 = dataUrl ? dataUrl[2] : raw;
  let buffer;
  try {
    buffer = Buffer.from(base64.replace(/\s/g, ''), 'base64');
  } catch {
    return { error: '图片编码不正确' };
  }
  if (!buffer.length) return { error: '图片内容为空' };
  if (buffer.length > 10 * 1024 * 1024) {
    return { error: '单张截图不能超过 10 MB' };
  }
  const isPng =
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer.subarray(1, 4).toString('ascii') === 'PNG';
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;
  const isWebp =
    buffer.length > 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  if (
    (mime === 'image/png' && !isPng) ||
    (mime === 'image/jpeg' && !isJpeg) ||
    (mime === 'image/webp' && !isWebp)
  ) {
    return { error: '图片内容和文件类型不一致' };
  }
  return {
    value: {
      buffer,
      mime,
      original_name: String(payload.filename || payload.original_name || '')
        .trim()
        .slice(0, 200),
    },
  };
}

module.exports = {
  IMAGE_MIME_EXTENSIONS,
  decodeImagePayload,
};
