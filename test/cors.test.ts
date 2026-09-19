/**
 * Tests for the CORS policy.
 *
 * CORS is the one part of this service whose correctness is decided entirely by
 * a third party - the browser - and whose failure mode is a client-side error
 * that says nothing about the server. A missing `Access-Control-Allow-Origin`
 * is not a 4xx; it is a network error in the console, indistinguishable from
 * the API being down. So the headers are pinned here rather than left to
 * whatever the proxy happens to be configured with.
 *
 * Requests go through `node:http` rather than `fetch` on purpose: the `Origin`
 * header is a forbidden header name for a browser `fetch`, and the point of
 * these tests is to send one and read the raw response headers back.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';

import { startTestServer } from './helpers.ts';

const ORIGIN = 'https://converter.alakbaroff.com';
const OTHER_ORIGIN = 'https://not-our-frontend.example';

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<RawResponse> {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** The `Vary` header, which node may hand back as a comma-joined string. */
function varyOf(response: RawResponse): string {
  const vary = response.headers.vary;
  return Array.isArray(vary) ? vary.join(', ') : (vary ?? '');
}

describe('CORS', () => {
  it('is off by default, so the Android client sees no change', async () => {
    // The APK sends no Origin and is unaffected either way, but the default
    // matters for a different reason: a same-origin frontend needs no header,
    // and an origin configured by accident is an origin exposed by accident.
    const server = await startTestServer();
    try {
      const response = await send(server.baseUrl, '/formats', {
        headers: { Origin: ORIGIN },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers['access-control-allow-origin'], undefined);
      assert.equal(response.headers['access-control-expose-headers'], undefined);
    } finally {
      await server.close();
    }
  });

  it('allows the configured origin, and only that origin', async () => {
    const server = await startTestServer({ corsOrigin: ORIGIN });
    try {
      const allowed = await send(server.baseUrl, '/formats', {
        headers: { Origin: ORIGIN },
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.headers['access-control-allow-origin'], ORIGIN);

      const denied = await send(server.baseUrl, '/formats', {
        headers: { Origin: OTHER_ORIGIN },
      });
      assert.equal(denied.status, 200);
      assert.equal(
        denied.headers['access-control-allow-origin'],
        undefined,
        'a different origin must not be echoed back',
      );

      // A request with no Origin at all - the Android client, or curl - is
      // served normally, without the header it has no use for.
      const bare = await send(server.baseUrl, '/formats');
      assert.equal(bare.status, 200);
      assert.equal(bare.headers['access-control-allow-origin'], undefined);
    } finally {
      await server.close();
    }
  });

  it('exposes the two headers the frontend actually reads', async () => {
    // Response headers are opaque to JavaScript unless they are named here.
    // Content-Disposition carries the download's filename; X-Request-Id is the
    // reference the error dialog shows. Neither is decoration - without them
    // the client falls back to a generic filename and an empty reference.
    const server = await startTestServer({ corsOrigin: ORIGIN });
    try {
      const response = await send(server.baseUrl, '/formats', {
        headers: { Origin: ORIGIN },
      });
      const exposed = String(response.headers['access-control-expose-headers'] ?? '');
      assert.match(exposed, /Content-Disposition/i);
      assert.match(exposed, /X-Request-Id/i);
    } finally {
      await server.close();
    }
  });

  it('varies on Origin even when the origin does not match', async () => {
    // The header's value depends on the request's Origin, so a shared cache
    // that ignores it could serve a matching origin's response to a
    // non-matching one. `Vary` has to be on every response, not just allowed
    // ones - which is exactly the case a naive implementation gets wrong.
    const server = await startTestServer({ corsOrigin: ORIGIN });
    try {
      const denied = await send(server.baseUrl, '/formats', {
        headers: { Origin: OTHER_ORIGIN },
      });
      assert.match(varyOf(denied), /Origin/i);
    } finally {
      await server.close();
    }
  });

  it('carries the headers on an error response, not just a success', async () => {
    // The reason the policy is middleware rather than a route decorator. A
    // browser cannot read a 4xx it is not allowed to read: without this, every
    // error message the service goes out of its way to write - the sentences
    // the frontend shows verbatim in a dialog - arrives as an opaque network
    // failure and the user is told nothing.
    const server = await startTestServer({ corsOrigin: ORIGIN });
    try {
      const response = await send(server.baseUrl, '/no-such-endpoint', {
        headers: { Origin: ORIGIN },
      });
      assert.equal(response.status, 404);
      assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
      // Still the JSON envelope, so the header is the only thing that changed.
      assert.match(response.body, /"error"/);
    } finally {
      await server.close();
    }
  });

  it('answers a preflight before the router can answer it instead', async () => {
    const server = await startTestServer({ corsOrigin: ORIGIN });
    try {
      const response = await send(server.baseUrl, '/convert/pdf', {
        method: 'OPTIONS',
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers['access-control-allow-origin'], ORIGIN);
      assert.match(String(response.headers['access-control-allow-methods']), /POST/);
      assert.match(String(response.headers['access-control-allow-headers']), /Content-Type/i);
      assert.ok(response.headers['access-control-max-age']);
      // The 204 is the proof this branch ran: left to the router, an OPTIONS
      // would have been answered there instead - 200, with an `Allow` header.
      // See the bare-OPTIONS test below for that half of the pair.
      assert.equal(response.body, '');
    } finally {
      await server.close();
    }
  });

  it('leaves a bare OPTIONS to the router, rather than calling it a preflight', async () => {
    // Not a preflight, so not CORS's business. Express answers OPTIONS itself
    // for a path that carries routes - 200, with an `Allow` header - and the
    // point of requiring `Access-Control-Request-Method` is that this stays
    // true. Answering on the method alone would quietly take that over.
    const server = await startTestServer({ corsOrigin: ORIGIN });
    try {
      const response = await send(server.baseUrl, '/convert/pdf', {
        method: 'OPTIONS',
        headers: { Origin: ORIGIN },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.allow, 'POST');
      assert.equal(
        response.headers['access-control-allow-methods'],
        undefined,
        'the preflight branch must not have run for a request that never announced one',
      );
    } finally {
      await server.close();
    }
  });
});
