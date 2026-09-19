/**
 * The OpenAPI document and the Swagger UI.
 *
 * Mounted BEFORE the catch-all 404, which would otherwise swallow these paths
 * and answer with the JSON error envelope.
 */
import { Router } from 'express';

import { Errors } from '../errors.ts';
import { DOCS_CONTENT_SECURITY_POLICY, loadOpenApiDocument, swaggerUiHtml } from '../openapi.ts';
import { respondJson } from '../middleware/error-handler.ts';

export function createDocsRouter(): Router {
  const router = Router();

  router.get('/openapi.json', async (_req, res) => {
    const spec = await loadOpenApiDocument();
    if (!spec) {
      respondJson(res, Errors.internal('openapi.yaml could not be loaded'), 500);
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(JSON.stringify(spec.json));
  });

  router.get('/openapi.yaml', async (_req, res) => {
    const spec = await loadOpenApiDocument();
    if (!spec) {
      respondJson(res, Errors.internal('openapi.yaml could not be loaded'), 500);
      return;
    }
    res.setHeader('Content-Type', 'application/yaml');
    res.status(200).end(spec.yaml);
  });

  router.get('/docs', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', DOCS_CONTENT_SECURITY_POLICY);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.status(200).end(swaggerUiHtml());
  });

  return router;
}
