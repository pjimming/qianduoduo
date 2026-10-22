'use strict';

const { URL } = require('node:url');

class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    if (!method || !pattern || typeof handler !== 'function') {
      throw new TypeError('router.add 需要 method、pattern 和 handler');
    }
    const normalizedMethod = String(method).toUpperCase();
    const matcher =
      pattern instanceof RegExp
        ? pattern
        : new RegExp(`^${String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    this.routes.push({
      method: normalizedMethod,
      pattern,
      matcher,
      handler,
    });
    return this;
  }

  get(pattern, handler) {
    return this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler);
  }

  put(pattern, handler) {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern, handler) {
    return this.add('DELETE', pattern, handler);
  }

  match(method, pathname) {
    const normalizedMethod = String(method || '').toUpperCase();
    return (
      this.routes.find(
        (route) =>
          route.method === normalizedMethod && route.matcher.test(pathname),
      ) || null
    );
  }

  async handle(request, response, fallback) {
    const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
    const { pathname } = requestUrl;
    const route = this.match(request.method, pathname);
    const handler = route?.handler || fallback;
    if (!handler) {
      throw new Error(`没有路由处理器：${request.method} ${pathname}`);
    }
    return handler(request, response, {
      pathname,
      requestUrl,
      route,
    });
  }
}

function createRouter() {
  return new Router();
}

module.exports = {
  Router,
  createRouter,
};
