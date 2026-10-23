'use strict';

const http = require('node:http');
const { ROOT, STATIC_DIR } = require('./config');
const { handleCaughtError } = require('./http/errors');
const { isAllowedOrigin } = require('./http/middleware/origin');
const { createRouter } = require('./http/router');
const {
  API_ROUTE_PATTERNS,
  routeKey,
} = require('./http/routes');
const { sendError } = require('./http/response');
const { createStaticService } = require('./http/static');
const { createDashboardQueryService } = require('./modules/dashboard/service');
const { createDashboardRoutes } = require('./modules/dashboard/routes');
const { createDataTrustService } = require('./modules/data-trust/service');
const { createDataTrustRoutes } = require('./modules/data-trust/routes');
const { createCapitalRepository } = require('./modules/capital/repository');
const { createCapitalRoutes } = require('./modules/capital/routes');
const { createCapitalService } = require('./modules/capital/service');
const { createDecisionsRepository } = require('./modules/decisions/repository');
const { createDecisionsRoutes } = require('./modules/decisions/routes');
const { createDecisionsService } = require('./modules/decisions/service');
const {
  createEvaluationsRepository,
} = require('./modules/evaluations/repository');
const { createEvaluationsRoutes } = require('./modules/evaluations/routes');
const { createEvaluationsService } = require('./modules/evaluations/service');
const { buildCsv } = require('./modules/ledger/export');
const { createLedgerRepository } = require('./modules/ledger/repository');
const { createLedgerRoutes } = require('./modules/ledger/routes');
const { createLedgerService } = require('./modules/ledger/service');
const { validateRecordPayload } = require('./modules/ledger/validation');
const { createIncomeRepository } = require('./modules/income/repository');
const { createIncomeRoutes } = require('./modules/income/routes');
const { createIncomeService } = require('./modules/income/service');
const { createNotificationsService } = require('./modules/notifications/service');
const { createNotificationsRoutes } = require('./modules/notifications/routes');
const { createOperationsService } = require('./modules/operations/service');
const { createOperationsRoutes } = require('./modules/operations/routes');
const { resolveProductCsv } = require('./modules/products/product-csv');
const { createProductsService } = require('./modules/products/service');
const { createProductsRoutes } = require('./modules/products/routes');
const {
  createProposalsRepository,
} = require('./modules/proposals/repository');
const { createProposalsRoutes } = require('./modules/proposals/routes');
const { createProposalsService } = require('./modules/proposals/service');
const {
  createProductValuationsRepository,
} = require('./modules/product-valuations/repository');
const {
  createProductValuationsRoutes,
} = require('./modules/product-valuations/routes');
const {
  createProductValuationsService,
} = require('./modules/product-valuations/service');
const { createTradesRepository } = require('./modules/trades/repository');
const { createTradesRoutes } = require('./modules/trades/routes');
const { createTradesService } = require('./modules/trades/service');
const {
  createIncomeOcrAdapter,
  createTradeOcrAdapter,
} = require('./infrastructure/ocr');
const { createReviewsRepository } = require('./modules/reviews/repository');
const { createReviewsRoutes } = require('./modules/reviews/routes');
const { createReviewsService } = require('./modules/reviews/service');
const { createResearchService } = require('./modules/research/service');

const staticService = createStaticService(STATIC_DIR);
const researchService = createResearchService({
  rootDir: ROOT,
  staticService,
});
const DEFAULT_PRODUCT_CSV = resolveProductCsv(ROOT);

function registerModuleRoutes(router, definitions, migrated) {
  for (const definition of definitions) {
    const key = routeKey(definition.method, definition.path);
    if (migrated.has(key)) {
      throw new Error(`重复注册 API：${key}`);
    }
    router.add(definition.method, definition.path, definition.handler);
    migrated.add(key);
  }
}

function createRequestHandler(repository, options = {}) {
  const automationRunner = options.automationRunner || null;
  const dashboardQuery =
    options.dashboardQuery ||
    createDashboardQueryService(repository, { automationRunner });
  const dataTrust = createDataTrustService({ repository });
  const operations = createOperationsService(repository);
  const products = createProductsService(repository);
  const notifications = createNotificationsService(repository);
  const capital = createCapitalService({
    capitalRepository: createCapitalRepository(repository),
    dashboardQuery,
  });
  const ledger = createLedgerService({
    ledgerRepository: createLedgerRepository(repository),
    dashboardQuery,
  });
  const productValuations = createProductValuationsService({
    productValuationsRepository:
      createProductValuationsRepository(repository),
    dashboardQuery,
  });
  const transactionManager = repository.transactionManager;
  const decisions = createDecisionsService({
    decisionsRepository: createDecisionsRepository(repository),
    dashboardQuery,
    transactionManager,
    automationRunner,
  });
  const proposals = createProposalsService({
    proposalsRepository: createProposalsRepository(repository),
    dashboardQuery,
    transactionManager,
  });
  const evaluations = createEvaluationsService({
    evaluationsRepository: createEvaluationsRepository(repository),
    dashboardQuery,
    transactionManager,
    automationRunner,
  });
  const reviews = createReviewsService({
    reviewsRepository: createReviewsRepository(repository),
    dashboardQuery,
    transactionManager,
  });
  const trades = createTradesService({
    tradesRepository: createTradesRepository(repository),
    dashboardQuery,
    ocr: createTradeOcrAdapter(),
    automationRunner,
  });
  const income = createIncomeService({
    incomeRepository: createIncomeRepository(repository),
    dashboardQuery,
    ocr: createIncomeOcrAdapter(),
  });
  const router = createRouter();
  const migrated = new Set();

  registerModuleRoutes(
    router,
    [
      ...createOperationsRoutes(operations),
      ...createDataTrustRoutes(dataTrust),
      ...createDashboardRoutes(dashboardQuery),
      ...createCapitalRoutes(capital),
      ...createLedgerRoutes(ledger),
      ...createProductsRoutes({
        products,
        dashboardQuery,
        productCsvPath: () => resolveProductCsv(ROOT),
      }),
      ...createProductValuationsRoutes(productValuations),
      ...createTradesRoutes(trades),
      ...createDecisionsRoutes(decisions),
      ...createProposalsRoutes(proposals),
      ...createEvaluationsRoutes(evaluations),
      ...createReviewsRoutes(reviews),
      ...createIncomeRoutes(income),
      ...createNotificationsRoutes({ notifications, dashboardQuery }),
    ],
    migrated,
  );
  const unmigrated = API_ROUTE_PATTERNS
    .map(([method, pattern]) => routeKey(method, pattern))
    .filter((key) => !migrated.has(key));
  if (unmigrated.length) {
    throw new Error(`存在未迁移 API：${unmigrated.join(', ')}`);
  }

  const fallback = async (request, response, context) => {
    if (context.pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (!context.pathname.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendError(response, 405, '请求方法不支持');
        return;
      }
      if (researchService.ownsAsset(context.pathname)) {
        researchService.serveAsset(request, response, context.pathname);
      } else {
        staticService.serveStatic(request, response, context.pathname);
      }
      return;
    }
    sendError(response, 404, '接口不存在');
  };

  return async (request, response) => {
    try {
      if (
        !['GET', 'HEAD'].includes(request.method || '') &&
        !isAllowedOrigin(request)
      ) {
        sendError(response, 403, '拒绝跨站写入请求');
        return;
      }
      await router.handle(request, response, fallback);
    } catch (error) {
      handleCaughtError(response, error);
    }
  };
}

function createServer({ repository, dashboardQuery, automationRunner }) {
  if (!repository) throw new Error('createServer 需要 repository');
  return http.createServer(
    createRequestHandler(repository, {
      dashboardQuery,
      automationRunner,
    }),
  );
}

function createApp({ repository, dashboardQuery, automationRunner }) {
  if (!repository) throw new Error('createApp 需要 repository');
  return {
    server: createServer({ repository, dashboardQuery, automationRunner }),
    repository,
  };
}

function dashboardPayload(repository, options = {}) {
  return createDashboardQueryService(repository).getDashboard(options.today);
}

module.exports = {
  API_ROUTE_PATTERNS,
  DEFAULT_PRODUCT_CSV,
  buildCsv,
  createApp,
  createDashboardQueryService,
  createRequestHandler,
  createServer,
  dashboardPayload,
  isAllowedOrigin,
  resolveProductCsv: (rootDir = ROOT) => resolveProductCsv(rootDir),
  validateRecordPayload,
};
