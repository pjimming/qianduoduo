'use strict';

const { readJsonBody } = require('../../http/middleware/json-body');
const {
  SECURITY_HEADERS,
  sendError,
  sendJson,
} = require('../../http/response');

function sendReviewError(response, error) {
  if (!error.statusCode) throw error;
  sendError(response, error.statusCode, error.message);
}

function createReviewsRoutes(reviews) {
  return [
    {
      method: 'POST',
      path: '/api/review/events',
      async handler(request, response) {
        const body = await readJsonBody(request);
        try {
          sendJson(response, 201, reviews.createEvent(body));
        } catch (error) {
          sendReviewError(response, error);
        }
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/review\/events\/(\d+)$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/review\/events\/(\d+)$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            reviews.updateEvent(Number(match[1]), body),
          );
        } catch (error) {
          sendReviewError(response, error);
        }
      },
    },
    {
      method: 'DELETE',
      path: /^\/api\/review\/events\/(\d+)$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/review\/events\/(\d+)$/,
        );
        try {
          sendJson(response, 200, reviews.deleteEvent(Number(match[1])));
        } catch (error) {
          sendReviewError(response, error);
        }
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/review\/notes\/(\d{4}-(?:0[1-9]|1[0-2]))$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/review\/notes\/(\d{4}-(?:0[1-9]|1[0-2]))$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            reviews.saveMonthlyNote(match[1], body),
          );
        } catch (error) {
          sendReviewError(response, error);
        }
      },
    },
    {
      method: 'PUT',
      path: /^\/api\/review\/quarterly\/(\d{4}-Q[1-4])$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/review\/quarterly\/(\d{4}-Q[1-4])$/,
        );
        const body = await readJsonBody(request);
        try {
          sendJson(
            response,
            200,
            reviews.saveQuarterlyNote(match[1], body),
          );
        } catch (error) {
          sendReviewError(response, error);
        }
      },
    },
    {
      method: 'GET',
      path: '/api/review/export',
      handler(request, response, context) {
        try {
          const exported = reviews.exportReview(
            context.requestUrl.searchParams.get('month'),
          );
          response.writeHead(200, {
            'Content-Type': 'text/markdown; charset=utf-8',
            'Content-Disposition': `attachment; filename="${exported.filename}"`,
            'Content-Length': Buffer.byteLength(exported.markdown),
            'Cache-Control': 'no-store',
            ...SECURITY_HEADERS,
          });
          response.end(exported.markdown);
        } catch (error) {
          sendReviewError(response, error);
        }
      },
    },
    {
      method: 'GET',
      path: /^\/api\/review\/drafts\/(monthly|quarterly)\/(\d{4}-(?:\d{2}|Q[1-4]))$/,
      handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/review\/drafts\/(monthly|quarterly)\/(\d{4}-(?:\d{2}|Q[1-4]))$/,
        );
        try {
          reviews.parseDraftRequest(match[1], match[2], null);
          sendJson(response, 200, reviews.getDraft(match[1], match[2]));
        } catch (error) {
          sendReviewError(response, error);
        }
      },
    },
    {
      method: 'POST',
      path: /^\/api\/review\/drafts\/(monthly|quarterly)\/(\d{4}-(?:\d{2}|Q[1-4]))\/(generate|confirm)$/,
      async handler(request, response, context) {
        const match = context.pathname.match(
          /^\/api\/review\/drafts\/(monthly|quarterly)\/(\d{4}-(?:\d{2}|Q[1-4]))\/(generate|confirm)$/,
        );
        try {
          reviews.parseDraftRequest(match[1], match[2], match[3]);
          if (match[3] === 'generate') {
            sendJson(response, 200, reviews.generateDraft(match[1], match[2]));
            return;
          }
          const body = await readJsonBody(request);
          sendJson(
            response,
            200,
            reviews.confirmDraft(match[1], match[2], body),
          );
        } catch (error) {
          sendReviewError(response, error);
        }
      },
    },
  ];
}

module.exports = {
  createReviewsRoutes,
};
