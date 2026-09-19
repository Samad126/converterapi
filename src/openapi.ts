/**
 * The OpenAPI description of the client-facing contract.
 *
 * The document itself lives in `openapi.yaml` at the repository root rather
 * than being generated from code. With two endpoints, generating it would mean
 * another dependency and a restructured router for very little gain, and the
 * thing worth pinning down here is the exact wire contract - which reads
 * better as a document than as annotations.
 *
 * The obvious risk with a hand-written spec is that it drifts. That is what
 * `test/openapi.test.ts` is for: it compares the statuses, codes and the exact
 * user-facing messages in this document against what the service actually
 * returns, and fails the build when they disagree. A spec nobody checks is
 * worse than no spec, because it is confidently wrong.
 */
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';

/**
 * Resolves to the repository root from both `src/` (type stripping) and
 * `dist/` (build output), because both are one level below it.
 */
const SPEC_URL = new URL('../openapi.yaml', import.meta.url);

export interface OpenApiDocument {
  /** The raw file, served verbatim so the comments survive. */
  yaml: string;
  /** Parsed once at startup and cached. */
  json: unknown;
}

let cached: OpenApiDocument | null = null;
let unavailable = false;

/**
 * Load the spec, once.
 *
 * Returns `null` rather than throwing if it cannot be read. Documentation is
 * not worth an outage: a missing file means `/docs` reports that it is
 * unavailable while conversion carries on working.
 */
export async function loadOpenApiDocument(): Promise<OpenApiDocument | null> {
  if (cached) return cached;
  if (unavailable) return null;

  try {
    const yaml = await readFile(SPEC_URL, 'utf8');
    const json: unknown = parseYaml(yaml);
    cached = { yaml, json };
    return cached;
  } catch (error) {
    unavailable = true;
    console.warn(
      JSON.stringify({
        outcome: 'openapi_unavailable',
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/** Test seam: forget any cached load. */
export function resetOpenApiCache(): void {
  cached = null;
  unavailable = false;
}

/**
 * Swagger UI, loaded from a CDN.
 *
 * The browser fetches the bundle, not this container, so this works even though
 * the service itself has no network egress.
 *
 * The CSP is a deliberate, narrow relaxation: Swagger UI needs inline script
 * and style to bootstrap, so `unsafe-inline` is allowed for those two
 * directives - but script sources are still restricted to this origin and
 * jsdelivr, which is the part that matters. This page renders a static document
 * and displays no user data.
 */
export function swaggerUiHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Word to PDF converter - API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
<style>body { margin: 0; }</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin="anonymous"></script>
<script>
  window.ui = SwaggerUIBundle({
    url: '/openapi.json',
    dom_id: '#swagger-ui',
    deepLinking: true,
    displayRequestDuration: true,
    // Lets you pick a .docx and download the PDF straight from /docs, which is
    // the only way to exercise a POST-with-a-file-body from a browser. Safe to
    // leave on: the endpoint is public and rate-limited by design, and anyone
    // who can click Execute here could equally run curl. Turn the whole page
    // off with ENABLE_DOCS=0 if you would rather not offer it.
    tryItOutEnabled: true
  });
</script>
</body>
</html>
`;
}

export const DOCS_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
  "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
  "img-src 'self' data: https://cdn.jsdelivr.net",
  "font-src https://cdn.jsdelivr.net",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');
