'use strict';

function sanitizeLogText(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  text = text.replace(
    /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi,
    (match, prefix) => `${prefix}[REDACTED]`,
  );
  text = text.replace(
    /\b(password|passwd|token|secret|api[_-]?key)(\s*[:=]\s*)[^\s,;]+/gi,
    (match, key, separator) => `${key}${separator}[REDACTED]`,
  );
  return text;
}

function createSafeLogger(base = console) {
  const emit = (method, args) => {
    const target = base?.[method] || base?.log;
    if (typeof target !== 'function') return;
    target.call(base, ...args.map(sanitizeLogText));
  };
  return {
    log: (...args) => emit('log', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  };
}

module.exports = {
  createSafeLogger,
  sanitizeLogText,
};
