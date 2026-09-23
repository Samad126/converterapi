/**
 * The 429 contract: once a source has used its budget, the next request is
 * refused with the error envelope AND a `Retry-After` the browser is allowed to
 * read. The limit is 2 here rather than the production 30 - same code path,
 * without thirty requests.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { request, type Server } from 'node:http';

import '../../support/helpers.ts';

const { createApp } = await import('../../../src/app.ts');
const { BoundedQueue, RateLimiter } = await import('../../../src/lib/queue.ts');

const ORIGIN = 'https://converter.alakbaroff.com';

function post(baseUrl: string, path: string) {
  const url = new URL(path, baseUrl);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const req = request(
        { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST', headers: { Origin: ORIGIN } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      req.end();
    },
  );
}

describe('rate limit', () => {
  it('answers the request over the limit with 429, Retry-After, and CORS exposure', async () => {
    const app = createApp({
      queue: new BoundedQueue(4, 64),
      rateLimiter: new RateLimiter(2, 60_000),
      corsOrigin: ORIGIN,
    });
    const server: Server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

    try {
      for (let i = 0; i < 2; i += 1) {
        const allowed = await post(baseUrl, '/convert/pdf');
        assert.notEqual(allowed.status, 429, `request ${i + 1} is inside the budget`);
      }

      const limited = await post(baseUrl, '/convert/pdf');
      assert.equal(limited.status, 429);
      assert.equal(JSON.parse(limited.body).error.code, 'E_RATE_LIMITED');

      const retryAfter = Number(limited.headers['retry-after']);
      assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, `Retry-After was ${retryAfter}`);

      const exposed = String(limited.headers['access-control-expose-headers']);
      assert.ok(exposed.includes('Retry-After'), `not exposed: ${exposed}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
