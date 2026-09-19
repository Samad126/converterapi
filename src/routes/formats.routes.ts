/**
 * GET /formats - what this converter can do, machine-readably.
 *
 * The matrix in formats.ts is already the single source of truth for the
 * server; this exposes the same table so a client does not have to hard-code
 * it. That matters more here than it usually would, because the shipped client
 * is an APK: without this, teaching it a new output format means shipping a new
 * APK, and a client that hard-codes the matrix will silently disagree with the
 * server the first time the server grows.
 *
 * It is a static description of a public contract, so it needs no auth and no
 * rate limiting of its own - it is a few hundred bytes of constants.
 */
import { Router } from 'express';

import { archivesFiles, SOURCES, TARGETS } from '../formats.ts';

export function createFormatsRouter(): Router {
  const router = Router();

  router.get('/formats', (_req, res) => {
    const body = {
      // Every target the service can produce, whether or not any given source
      // can reach it.
      targets: Object.values(TARGETS).map((target) => ({
        id: target.id,
        extension: target.extension,
        mediaType: target.mediaType,
        label: target.label,
        /**
         * True when the response is a ZIP of one file per page rather than a
         * single file - always an archive for these, even for a one-page
         * source, so the content type never depends on the document.
         *
         * Asked of the matrix rather than restated, so that this answer and the
         * one the controller acts on cannot drift apart. See `archivesFiles`.
         */
        multiple: archivesFiles(target),
      })),
      sources: Object.values(SOURCES).map((source) => ({
        extension: source.extension,
        mediaType: source.mediaType,
        /**
         * `null` rather than omitted, for a source LibreOffice does not open -
         * `.psd` today. A client reading this list cannot tell an absent key
         * from a version of the service that never had the field, and the
         * distinction that matters here is "this source is handled by our own
         * code rather than by the conversion engine", which is worth saying
         * out loud rather than leaving to be inferred from a missing key.
         */
        family: source.family ?? null,
        targets: source.targets,
      })),
    };

    res.setHeader('Content-Type', 'application/json');
    res.status(200).end(JSON.stringify(body));
  });

  return router;
}
