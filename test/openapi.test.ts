/**
 * Keeps the hand-written OpenAPI document honest.
 *
 * A spec nobody checks is worse than no spec, because it is confidently wrong:
 * a client generated from it fails in ways the document said were impossible.
 * These tests are the mitigation for having written it by hand. They compare
 * the document against what the service actually returns - the statuses, the
 * codes, and the exact sentences shown to the user - and fail the build when
 * the two disagree.
 *
 * If you change a message in `src/errors.ts`, change it in `openapi.yaml` in
 * the same commit. That is the point.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer, upload, type TestServer } from './helpers.ts';
import { loadOpenApiDocument } from '../src/openapi.ts';
import { Errors, AppError } from '../src/errors.ts';
import { TARGET_IDS, targetsFor } from '../src/formats.ts';
import { MAX_UPLOAD_BYTES } from '../src/config.ts';
import { buildMinimalDocx } from '../src/lib/probe-documents.ts';
import { buildEncryptedDocxContainer, buildMalformedDocx } from './fixtures.ts';

interface SpecDocument {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  components: {
    schemas: { ErrorCode: { enum: string[] }; TargetId: { enum: string[] } };
    responses: Record<string, unknown>;
  };
}

let spec: SpecDocument;
let server: TestServer;

const SAMPLE_DOCX = buildMinimalDocx(['OpenAPI contract check']);

before(async () => {
  const loaded = await loadOpenApiDocument();
  assert.ok(loaded, 'openapi.yaml could not be loaded');
  spec = loaded.json as SpecDocument;
  server = await startTestServer();
});

after(async () => {
  await server.close();
});

/**
 * Follow a `$ref` to the component it points at.
 *
 * The document factors the shared pieces out into `components`, so a response
 * is often a reference rather than an inline object. A test that reads
 * `responses['200'].content` directly would silently see `undefined` and then
 * fail for the wrong reason.
 */
function resolve(node: unknown): Record<string, unknown> {
  if (node && typeof node === 'object' && '$ref' in node) {
    const pointer = String((node as { $ref: unknown }).$ref);
    return pointer
      .replace(/^#\//, '')
      .split('/')
      .reduce<unknown>(
        (current, key) => (current as Record<string, unknown> | undefined)?.[key],
        spec,
      ) as Record<string, unknown>;
  }
  return node as Record<string, unknown>;
}

/** Every (code, message) pair the document says can reach the user. */
function documentedErrors(): Array<{ where: string; code: string; message: string }> {
  const found: Array<{ where: string; code: string; message: string }> = [];
  for (const [name, response] of Object.entries(spec.components.responses)) {
    const envelope = response as {
      content?: {
        'application/json'?: {
          schema?: { $ref?: string };
          example?: unknown;
          examples?: Record<string, { value: unknown }>;
        };
      };
    };
    const media = envelope.content?.['application/json'];
    if (!media) continue;
    // Not every JSON response is an error envelope - `/pdf/form-fields` and
    // `/pdf/compare` answer with their own JSON shape on success, and their
    // examples have no `error` object to check at all. Only a response whose
    // schema actually IS `ErrorEnvelope` is a claim about `error.code`/
    // `error.message` this test can hold the service to.
    if (media.schema?.$ref !== '#/components/schemas/ErrorEnvelope') continue;

    const candidates: unknown[] = [];
    if (media.example) candidates.push(media.example);
    for (const entry of Object.values(media.examples ?? {})) candidates.push(entry.value);

    for (const candidate of candidates) {
      const value = candidate as { error?: { code?: string; message?: string } };
      assert.ok(value.error?.code, `${name} example has no error.code`);
      assert.ok(value.error?.message, `${name} example has no error.message`);
      found.push({ where: name, code: value.error.code, message: value.error.message });
    }
  }
  return found;
}

/**
 * Every (code, message) pair the service can actually produce.
 *
 * Built from an explicit table rather than by calling every factory with the
 * same argument: several of them take different inputs, and passing a string to
 * one that expects a list of targets would throw here rather than test
 * anything. The arguments are the real ones a request would supply, so the
 * rendered sentence is the sentence a user would see.
 */
function actualErrors(): Array<{ code: string; message: string }> {
  const produced = [
    Errors.convertFailed(),
    Errors.timeout(),
    Errors.encrypted(),
    Errors.unsupported(),
    Errors.unsupportedTarget('.docx', targetsFor('.docx')),
    Errors.unknownTarget(TARGET_IDS),
    Errors.tooLarge(),
    Errors.noTables(),
    Errors.noLayers(),
    Errors.badPageRange('Page 9 does not exist in this 5-page document.'),
    Errors.badPageRange(
      'The order must name every page exactly once (1-5), with no repeats and none missing.',
    ),
    Errors.tooFewFiles('Merging needs at least two PDF files.'),
    Errors.tooFewFiles('Comparing needs exactly two PDF files.'),
    Errors.wrongPassword(),
    Errors.invalidField('The "degrees" field must be a multiple of 90.'),
    Errors.invalidField('The "text" field is required.'),
    Errors.invalidField('The "password" field is required.'),
    Errors.invalidField('The "left" field must be a non-negative number.'),
    Errors.invalidField('Cropping page 1 by these margins would leave nothing: it is 300x150pt.'),
    Errors.invalidField('The "position" field must be one of: bottom-center, bottom-left, bottom-right.'),
    Errors.invalidField('The "startAt" field must be a positive whole number.'),
    Errors.invalidField('The "ocr" field must be "true" or "false".'),
    Errors.invalidField('The "force" field must be "true" or "false".'),
    Errors.invalidField('There is no form field named "nope" in this PDF.'),
    Errors.busy(),
    Errors.badRequest('test detail'),
    Errors.rateLimited(),
    Errors.internal(),
  ].map((error: AppError) => error.toEnvelope().error);

  // The 404 uses the same code as E_BAD_REQUEST with a different sentence, so
  // it is not reachable from the Errors factory table.
  produced.push({
    code: 'E_BAD_REQUEST',
    message: 'The converter is not available at this address. Please update the app and try again.',
  });

  return produced;
}

describe('openapi document', () => {
  it('is a valid-looking OpenAPI 3.1 document', () => {
    assert.match(spec.openapi, /^3\.1\./);
    assert.ok(spec.info.title);
    assert.ok(spec.info.version);
    for (const path of ['/convert/{target}', '/formats', '/health']) {
      assert.ok(spec.paths[path], `does not document ${path}`);
    }
    assert.ok(spec.paths['/convert/{target}']!.post, 'does not document POST /convert/{target}');
    assert.ok(spec.paths['/formats']!.get, 'does not document GET /formats');
    assert.ok(spec.paths['/health']!.get, 'does not document GET /health');

    // The bare path is gone for good, and the document must not resurrect it:
    // a documented alias that the router does not serve would send every client
    // generated from this spec to a 404.
    assert.equal(spec.paths['/convert'], undefined, 'documents a bare /convert that is not served');
  });

  it('agrees with the configured upload limit', () => {
    const operation = spec.paths['/convert/{target}']!.post as { 'x-max-upload-bytes': number };
    assert.equal(
      operation['x-max-upload-bytes'],
      MAX_UPLOAD_BYTES,
      'the documented limit and MAX_UPLOAD_BYTES have diverged',
    );
    assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
  });

  it('documents exactly the target ids the matrix implements', () => {
    // A target the document lists but the router does not know is a 404 on a
    // format the docs promise, and one the router knows but the docs omit is
    // invisible to every client.
    assert.deepEqual([...spec.components.schemas.TargetId.enum].sort(), [...TARGET_IDS].sort());
  });

  it('documents every error code the service can produce', () => {
    const documented = new Set(spec.components.schemas.ErrorCode.enum);
    for (const { code } of actualErrors()) {
      assert.ok(
        documented.has(code),
        `${code} is produced by src/errors.ts but is missing from the ErrorCode enum in openapi.yaml`,
      );
    }
  });

  it('does not document error codes the service cannot produce', () => {
    const produced = new Set(actualErrors().map((e) => e.code));
    for (const code of spec.components.schemas.ErrorCode.enum) {
      assert.ok(
        produced.has(code),
        `${code} is documented in openapi.yaml but no code path produces it`,
      );
    }
  });

  it('quotes the user-facing messages exactly', () => {
    // This is the assertion that matters most: `error.message` is shown
    // verbatim in a dialog, so a spec that paraphrases it is lying about what
    // the user will see. It also pins the long ones - the lists of supported
    // types and of a document's possible targets - to the matrix itself.
    const actual = actualErrors();
    for (const documented of documentedErrors()) {
      const match = actual.find(
        (a) => a.code === documented.code && a.message === documented.message,
      );
      assert.ok(
        match,
        `openapi.yaml documents ${documented.where} as ${documented.code} ` +
          `"${documented.message}", which the service never produces`,
      );
    }
  });

  it('documents every error response it can return', () => {
    const targeted = spec.paths['/convert/{target}']!.post as {
      responses: Record<string, unknown>;
    };
    for (const status of ['200', '400', '404', '413', '415', '422', '429', '500', '503', '504']) {
      assert.ok(targeted.responses[status], `POST /convert/{target} does not document ${status}`);
    }
  });

  it('documented image targets as archives, matching what the service sends', () => {
    const response = (spec.components.responses as Record<string, unknown>)
      .ConvertedToTarget as { content: Record<string, unknown> };
    assert.ok(response.content['application/zip'], 'the ZIP response is not documented');
  });
});

describe('openapi endpoints', () => {
  it('serves the document as JSON', async () => {
    const response = await fetch(`${server.baseUrl}/openapi.json`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);

    const body = (await response.json()) as SpecDocument;
    assert.equal(body.openapi, spec.openapi);
    assert.ok(body.paths['/convert/{target}']);
  });

  it('serves the document as YAML', async () => {
    const response = await fetch(`${server.baseUrl}/openapi.yaml`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/yaml/);
    // The raw file, so the comments explaining the contract survive.
    assert.match(await response.text(), /^openapi: 3\.1\./);
  });

  it('serves a Swagger UI page that points at the JSON document', async () => {
    const response = await fetch(`${server.baseUrl}/docs`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/);
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/);

    const html = await response.text();
    assert.match(html, /SwaggerUIBundle/);
    assert.match(html, /url: '\/openapi\.json'/);
  });
});

describe('documented responses match reality', () => {
  /**
   * Exercise the endpoints and check each real response is one the document
   * says is possible. This is the half that catches a spec which is internally
   * consistent but describes a service that does not exist.
   */
  const cases: Array<{
    label: string;
    status: number;
    code?: string;
    run: () => Promise<unknown>;
  }> = [
    {
      label: 'success',
      status: 200,
      run: () => upload(server.baseUrl, 'ok.docx', SAMPLE_DOCX),
    },
    {
      label: 'unsupported extension',
      status: 415,
      code: 'E_UNSUPPORTED',
      run: () => upload(server.baseUrl, 'animation.gif', SAMPLE_DOCX),
    },
    {
      label: 'oversized',
      status: 413,
      code: 'E_TOO_LARGE',
      run: () => upload(server.baseUrl, 'big.docx', Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 0x41)),
    },
    {
      label: 'malformed',
      status: 500,
      code: 'E_CONVERT_FAILED',
      run: () => upload(server.baseUrl, 'broken.docx', buildMalformedDocx()),
    },
    {
      label: 'encrypted',
      status: 422,
      code: 'E_ENCRYPTED',
      run: () => upload(server.baseUrl, 'secret.docx', buildEncryptedDocxContainer()),
    },
    {
      label: 'no file part',
      status: 400,
      code: 'E_BAD_REQUEST',
      run: () => upload(server.baseUrl, 'ok.docx', SAMPLE_DOCX, { fieldName: 'document' }),
    },
    {
      label: 'unknown target',
      status: 404,
      code: 'E_UNKNOWN_TARGET',
      run: () => upload(server.baseUrl, 'ok.docx', SAMPLE_DOCX, { target: 'banana' }),
    },
    {
      label: 'target the source cannot become',
      status: 415,
      code: 'E_UNSUPPORTED_TARGET',
      run: () => upload(server.baseUrl, 'ok.docx', SAMPLE_DOCX, { target: 'png' }),
    },
    {
      // SAMPLE_DOCX is a paragraph and nothing else, so the extractor opens it
      // successfully and finds no tables - which is the whole point of the
      // case: it is a 422 rather than a 500 because nothing failed.
      label: 'a document with no tables',
      status: 422,
      code: 'E_NO_TABLES',
      run: () => upload(server.baseUrl, 'ok.docx', SAMPLE_DOCX, { target: 'tables' }),
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.label} returns a documented response`, async () => {
      const response = (await testCase.run()) as {
        status: number;
        contentType: string | null;
        body: Buffer;
      };

      assert.equal(response.status, testCase.status);

      if (testCase.status === 200) {
        // A `pdf` target promises application/pdf and nothing else.
        const operation = resolve(spec.paths['/convert/{target}']!.post);
        const responses = operation.responses as Record<string, unknown>;
        const ok = resolve(responses['200']) as { content?: Record<string, unknown> };
        assert.ok(ok.content?.['application/pdf'], 'the 200 does not document application/pdf');
        assert.equal(response.contentType, 'application/pdf');
        return;
      }

      // Every documented failure is application/json carrying a code the
      // document lists.
      assert.match(response.contentType ?? '', /application\/json/);
      const envelope = JSON.parse(response.body.toString('utf8')) as {
        error: { code: string; message: string };
      };
      assert.ok(
        spec.components.schemas.ErrorCode.enum.includes(envelope.error.code),
        `${envelope.error.code} is not in the documented ErrorCode enum`,
      );
      assert.equal(envelope.error.code, testCase.code);

      // And the sentence is one the document quotes.
      const quoted = documentedErrors().some(
        (d) => d.code === envelope.error.code && d.message === envelope.error.message,
      );
      assert.ok(quoted, `"${envelope.error.message}" is not quoted in openapi.yaml`);
    });
  }
});
