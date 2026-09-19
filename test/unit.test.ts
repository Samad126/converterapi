/**
 * Unit tests for the parts that are worth pinning down without a subprocess:
 * the conversion matrix, the concurrency bound, the rate limiter, password
 * detection, the ZIP writer, and the exact user-facing strings.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Must be set before config.ts is imported - see the note in helpers.ts.
process.env.TEMP_ROOT = await fsp.mkdtemp(join(tmpdir(), 'converter-unit-'));

const { BoundedQueue, RateLimiter } = await import('../src/lib/queue.ts');
const { Errors, AppError, ClientGoneError } = await import('../src/errors.ts');
const {
  ALLOWED_EXTENSIONS,
  SOURCES,
  TARGETS,
  TARGET_IDS,
  isAllowedExtension,
  isTargetId,
  pdfFilterFor,
  resolveConversion,
  targetsFor,
  validateMatrix,
} = await import('../src/formats.ts');
const { isPasswordProtected } = await import('../src/lib/encrypted.ts');
const {
  createWorkspace,
  removeWorkspace,
  sweepStaleWorkspaces,
  inputFileNameFor,
} = await import('../src/services/workspace.service.ts');
const { zipStored, safeEntryName } = await import('../src/lib/zip.ts');
const { EXTRACT_TARGET_IDS } = await import('../src/services/conversion.service.ts');
const { decodeUploadName, downloadNameFor, contentDispositionFor } = await import(
  '../src/lib/download-name.ts'
);
const { buildMinimalDocx, buildMinimalOdp, buildSolidPng, pdfProbe } = await import(
  '../src/lib/probe-documents.ts'
);
const { MAX_UPLOAD_BYTES, MAX_DOWNLOAD_NAME_LENGTH, TEMP_ROOT } = await import(
  '../src/config.ts'
);
const {
  buildEncryptedDocxContainer,
  buildEncryptedLegacyDoc,
  buildEncryptedPdfContainer,
  buildFormerlyEncryptedPdf,
  buildPlainLegacyDoc,
} = await import('./fixtures.ts');

after(async () => {
  await fsp.rm(TEMP_ROOT, { recursive: true, force: true });
});

describe('conversion matrix', () => {
  it('is internally consistent', () => {
    // Throws if a source advertises a target it has no filter for, if a target
    // id is misspelled, or if a source lists its own format. Called explicitly
    // so a regression names itself here rather than at the import.
    assert.doesNotThrow(() => validateMatrix());
  });

  it('accepts every extension the documentation lists', () => {
    assert.equal(ALLOWED_EXTENSIONS.length, 18);
    for (const extension of ALLOWED_EXTENSIONS) {
      assert.equal(isAllowedExtension(extension), true, extension);
    }
    // Prototype keys must not fool the allowlist check.
    assert.equal(isAllowedExtension('constructor'), false);
    assert.equal(isAllowedExtension('.DOCX'), false, 'callers must lower-case first');
    // PDF is both a source (pdfa/png/jpg/docx/pptx/xlsx) and a target
    // (everything else that can become one) - the one extension in the matrix
    // that is genuinely both.
    assert.equal(isAllowedExtension('.pdf'), true, 'PDF is now also a source');
    assert.equal(isAllowedExtension(''), false);
  });

  it('resolves every advertised source/target pair to a real filter', () => {
    for (const extension of ALLOWED_EXTENSIONS) {
      const targets = targetsFor(extension);
      assert.ok(targets.length > 0, `${extension} can become nothing`);
      for (const target of targets) {
        const resolved = resolveConversion(extension, target);
        assert.ok(resolved, `${extension} -> ${target} does not resolve`);

        if (resolved.viaEngine) {
          // A second, non-LibreOffice route to this target id - see
          // `engineFrom`'s doc comment. Checked before `mode`, because `mode`
          // describes how every OTHER source reaches this same id.
          assert.equal(resolved.convertTo, '', `${extension} -> ${target} invented a filter`);
          assert.ok(
            TARGETS[target].engineFrom?.includes(extension),
            `${extension} -> ${target}, but the target does not list it as an engine source`,
          );
          continue;
        }

        if (TARGETS[target].mode === 'raster') {
          // A raster target has no filter of its own: it is rendered to PDF
          // first and the pages are split afterwards, so the only filter it
          // depends on is the family's PDF export.
          assert.equal(resolved.convertTo, '', `${extension} -> ${target} invented a filter`);
          assert.ok(pdfFilterFor(SOURCES[extension].family), `${extension} has no PDF export`);
          continue;
        }

        if (TARGETS[target].mode === 'extract') {
          // An extract target reaches no filter either, and for a stronger
          // reason: LibreOffice is not involved at all. Our own code reads the
          // document, so there is nothing for `convertTo` to carry - and the
          // pair is legal only because the target named this source as one it
          // can read.
          assert.equal(resolved.convertTo, '', `${extension} -> ${target} invented a filter`);
          assert.ok(
            TARGETS[target].extractFrom?.includes(extension),
            `${extension} -> ${target}, but the target does not list it as a source`,
          );
          continue;
        }

        assert.notEqual(resolved.convertTo, '', `${extension} -> ${target} has no filter`);
        // The filter argument always starts with the output extension, which is
        // how soffice knows what to write.
        assert.ok(
          resolved.convertTo.startsWith(`${TARGETS[target].extension.slice(1)}:`),
          `${extension} -> ${target}: unexpected filter "${resolved.convertTo}"`,
        );
      }
    }
  });

  it('refuses pairs the matrix does not list', () => {
    // Real targets, wrong family.
    assert.equal(resolveConversion('.docx', 'png'), null, 'docx is not a slide deck');
    assert.equal(resolveConversion('.docx', 'xlsx'), null, 'docx is not a spreadsheet');
    assert.equal(resolveConversion('.png', 'docx'), null, 'an image is not a document');
    // A source is never its own target.
    assert.equal(resolveConversion('.docx', 'docx'), null);
    assert.equal(resolveConversion('.csv', 'csv'), null);
  });

  it('keeps the Word-to-PDF promises the shipped client depends on', () => {
    // The Android client posts a .docx and expects a PDF back, so these three
    // and their target are a contract, not a feature.
    for (const extension of ['.docx', '.docm', '.doc'] as const) {
      assert.ok(targetsFor(extension).includes('pdf'), `${extension} lost its PDF target`);
      const resolved = resolveConversion(extension, 'pdf');
      assert.equal(resolved?.convertTo, 'pdf:writer_pdf_Export');
      assert.equal(resolved?.target.mediaType, 'application/pdf');
    }
  });

  it('exposes every target under a distinct id and extension', () => {
    const extensions = new Map<string, (typeof TARGET_IDS)[number]>();
    for (const id of TARGET_IDS) {
      assert.equal(isTargetId(id), true);
      const target = TARGETS[id];
      assert.equal(target.id, id);
      assert.ok(target.extension.startsWith('.'), `${id} has a bare extension`);
      assert.ok(target.mediaType.length > 0, `${id} has no media type`);

      const existing = extensions.get(target.extension);
      if (existing !== undefined) {
        // Two targets may share an extension when one of them is an extract,
        // because then they produce the SAME FORMAT by different means -
        // `tables` writes a workbook exactly as `xlsx` does, and only the
        // contents differ, so the download is honest either way.
        const extraction = TARGETS[existing]?.mode === 'extract' || target.mode === 'extract';
        // Or when no single source ever offers both: `pdf` and `pdfa` are
        // both `direct` .pdf exports, but no source's `targets` list contains
        // both of them - `.pdf` reaches `pdfa`, everything else reaches
        // `pdf`, and a source can never target its own extension - so a
        // client asking for one can never have meant the other. What the
        // test actually guards against is the SAME FORMAT being reachable
        // two ways from one upload, and that is what "no source lists both"
        // rules out directly, more precisely than "one of them is an
        // extract" does.
        const neverAmbiguous = !Object.values(SOURCES).some(
          (source) => source.targets.includes(existing) && source.targets.includes(id),
        );
        assert.ok(
          extraction || neverAmbiguous,
          `${target.extension} is produced by two targets: ${existing}, ${id}`,
        );
      }
      extensions.set(target.extension, id);
    }
    assert.equal(isTargetId('banana'), false);
    assert.equal(isTargetId('constructor'), false);
  });

  it('has an extractor wired up for every extract target', () => {
    // `EXTRACTORS` in the service is a Partial record, so the compiler cannot
    // see that it covers the matrix - and it deliberately cannot, because the
    // runtime guard that turns a missing entry into an internal error is the
    // thing that makes an unknown target safe. This is what stops that guard
    // from ever being the thing a user meets: a new extract target with no
    // engine fails here instead, at build time.
    for (const id of TARGET_IDS) {
      if (TARGETS[id].mode !== 'extract') continue;
      assert.ok(
        EXTRACT_TARGET_IDS.includes(id),
        `"${id}" is an extract target with no engine in conversion.service.ts`,
      );
    }
  });

  it('routes only presentations and PDFs to the raster pipeline', () => {
    // A raster target is split into one image per page, which only means
    // anything for a document with pages to show - a presentation, or a PDF,
    // which is pages already and skips the render-to-PDF half of the
    // pipeline entirely (see conversion.service.ts's `sourceIsPdf`).
    for (const id of TARGET_IDS) {
      if (TARGETS[id].mode !== 'raster') continue;
      for (const extension of ALLOWED_EXTENSIONS) {
        if (!targetsFor(extension).includes(id)) continue;
        const family = SOURCES[extension].family;
        assert.ok(
          family === 'impress' || extension === '.pdf',
          `${extension} -> ${id} is not a presentation or a PDF`,
        );
      }
    }
  });
});

describe('zip writer', () => {
  it('round-trips entry names through the central directory', () => {
    const archive = zipStored([
      { name: 'slide-1.png', data: Buffer.from('one') },
      { name: 'slide-2.png', data: Buffer.from('two') },
    ]);
    // Signature of the first local file header, and the end-of-central-directory
    // magic somewhere at the end.
    assert.equal(archive.readUInt32LE(0), 0x04034b50);
    assert.ok(archive.subarray(-22).readUInt32LE(0) === 0x06054b50);
    assert.ok(archive.includes(Buffer.from('slide-1.png')));
    assert.ok(archive.includes(Buffer.from('slide-2.png')));
  });

  it('refuses to write a name that could escape on unpack', () => {
    // Zip-slip defence: the archive is ours, but a name is a name.
    assert.equal(safeEntryName('../../etc/passwd'), 'etc/passwd');
    assert.equal(safeEntryName('/absolute/path.txt'), 'absolute/path.txt');
    assert.equal(safeEntryName('..'), 'file');
    assert.equal(safeEntryName(''), 'file');
    assert.equal(safeEntryName('a/./b.txt'), 'a/b.txt');
  });
});

describe('probe documents', () => {
  it('builds a docx that is a real OOXML package', () => {
    const docx = buildMinimalDocx(['hello']);
    assert.equal(docx.readUInt32LE(0), 0x04034b50, 'not a zip');
    assert.ok(docx.includes(Buffer.from('[Content_Types].xml')));
    assert.ok(docx.includes(Buffer.from('word/document.xml')));
  });

  it('builds an ODP whose mimetype entry comes first and is stored', () => {
    const odp = buildMinimalOdp(['one', 'two']);
    assert.equal(odp.readUInt32LE(0), 0x04034b50, 'not a zip');
    // ODF requires the mimetype entry first, and stored rather than deflated -
    // it is how a consumer recognises the format from the first bytes.
    const nameLength = odp.readUInt16LE(26);
    const name = odp.subarray(30, 30 + nameLength).toString('utf8');
    assert.equal(name, 'mimetype');
    assert.equal(odp.readUInt16LE(8), 0, 'mimetype entry must not be compressed');
    assert.ok(odp.includes(Buffer.from('application/vnd.oasis.opendocument.presentation')));
  });

  it('builds a PNG with a valid signature and IHDR', () => {
    const png = buildSolidPng(4, 3, [10, 20, 30]);
    assert.deepEqual(
      [...png.subarray(0, 8)],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    );
    assert.equal(png.readUInt32BE(16), 4, 'width');
    assert.equal(png.readUInt32BE(20), 3, 'height');
  });
});

describe('download names', () => {
  it('keeps the upload name and takes the target extension', () => {
    assert.equal(downloadNameFor('Quarterly report.docx', '.pdf'), 'Quarterly report.pdf');
    assert.equal(downloadNameFor('sheet.csv', '.xlsx'), 'sheet.xlsx');
    // Only the LAST extension is replaced, so the parts that distinguish the
    // file survive.
    assert.equal(downloadNameFor('archive.tar.gz', '.pdf'), 'archive.tar.pdf');
    assert.equal(downloadNameFor('no-extension', '.pdf'), 'no-extension.pdf');
  });

  it('strips anything that could escape or break a header', () => {
    // Path traversal: the directory part must never survive.
    assert.equal(downloadNameFor('../../etc/passwd.docx', '.pdf'), 'passwd.pdf');
    assert.equal(downloadNameFor('/absolute/path/report.docx', '.pdf'), 'report.pdf');
    assert.equal(downloadNameFor('C:\\Users\\me\\report.docx', '.pdf'), 'report.pdf');

    // Header injection: a CRLF in the name would otherwise let a hostile client
    // write headers of its own choosing.
    assert.equal(downloadNameFor('evil\r\nX-Injected: yes.docx', '.pdf'), 'evilX-Injected: yes.pdf');
    assert.equal(downloadNameFor('quote".docx', '.pdf'), 'quote.pdf');
    // A backslash is a Windows path separator, so it is handled as a directory
    // boundary rather than as a character to keep.
    assert.equal(downloadNameFor('back\\slash.docx', '.pdf'), 'slash.pdf');

    // A leading dot would make the result a hidden file.
    assert.equal(downloadNameFor('.hidden.docx', '.pdf'), 'hidden.pdf');
  });

  it('falls back to a generic name when nothing usable survives', () => {
    assert.equal(downloadNameFor('.docx', '.pdf'), 'converted.pdf');
    assert.equal(downloadNameFor('', '.pdf'), 'converted.pdf');
    assert.equal(downloadNameFor('../', '.xlsx'), 'converted.xlsx');
    assert.equal(downloadNameFor('...', '.pdf'), 'converted.pdf');
  });

  it('bounds a name that is absurdly long', () => {
    const long = `${'a'.repeat(5000)}.docx`;
    const name = downloadNameFor(long, '.pdf');
    assert.ok(name.length <= MAX_DOWNLOAD_NAME_LENGTH + '.pdf'.length, `too long: ${name.length}`);
    assert.ok(name.endsWith('.pdf'));
  });

  it('carries a non-ASCII name in both RFC 6266 forms', () => {
    const header = contentDispositionFor(downloadNameFor('Résumé — final.docx', '.pdf'));
    // The quoted form is what older clients read and must be plain ASCII.
    const quoted = /filename="([^"]*)"/.exec(header)?.[1] ?? '';
    assert.match(quoted, /^[\u0020-\u007e]*$/, `not ASCII: ${quoted}`);
    // The starred form carries the real name, percent-encoded as UTF-8, so the
    // recipient gets `Résumé — final.pdf` rather than mojibake.
    assert.match(header, /filename\*=UTF-8''R%C3%A9sum%C3%A9%20%E2%80%94%20final\.pdf/);
  });

  it('recovers a UTF-8 filename that multer read as Latin-1', () => {
    // multer hands over every BYTE of the client's UTF-8 as its own latin1
    // character, so `Ö` (`C3 96`) arrives as `Ã` plus an invisible C1 control.
    // Left alone, a perfectly ordinary name downloads as line noise.
    const real = 'KVADRAT KÖKLƏR 8-Cİ SİNİF (ARZU ƏLƏDDİN QIZI 051-641-88-34)';
    const asMulterGivesIt = Buffer.from(real, 'utf8').toString('latin1');

    assert.notEqual(asMulterGivesIt, real, 'the fixture does not reproduce the bug');
    assert.equal(decodeUploadName(asMulterGivesIt), real);
    assert.equal(downloadNameFor(`${asMulterGivesIt}.docx`, '.pdf'), `${real}.pdf`);
  });

  it('leaves names that were never broken exactly as they are', () => {
    // Each of these has been decoded correctly already, and re-reading it as
    // UTF-8 would destroy it. The Japanese name and the em dash prove the
    // check for characters Latin-1 cannot represent; `café` proves the case
    // where the bytes are genuinely latin1 and simply are not valid UTF-8.
    for (const name of [
      'plain.docx',
      'café.docx',
      'Résumé — final.docx',
      '日本語.docx',
      'Ελληνικά.docx',
    ]) {
      assert.equal(decodeUploadName(name), name, name);
    }
  });

  it('strips C1 control characters as well as C0', () => {
    // C1 is the half that matters here: it is exactly what a mangled
    // multi-byte character leaves behind, so it reaches this code in practice
    // rather than only in theory.
    const name = downloadNameFor('a\u0096b\u0085c.docx', '.pdf');
    assert.equal(name, 'abc.pdf');
    assert.doesNotMatch(name, /[\u0000-\u001f\u007f-\u009f]/);
  });

  it('renders an ASCII fallback that is still readable', () => {
    // The quoted `filename` has to be ASCII, but replacing every accented
    // letter with an underscore would leave `R_sum_`. Decomposing first keeps
    // the base character.
    const header = contentDispositionFor('Résumé — final.pdf');
    assert.match(header, /filename="Resume _ final\.pdf"/);
  });

  it('never emits a header value containing a newline', () => {
    // Whatever the client sends, the header has to be a single line - Node
    // throws on an invalid header character, which would be a 500 rather than a
    // conversion failure.
    const header = contentDispositionFor(downloadNameFor('a\r\nb\rc\nd.docx', '.pdf'));
    assert.doesNotMatch(header, /[\r\n]/);
  });
});

describe('BoundedQueue', () => {
  it('never runs more than maxConcurrent jobs at once', async () => {
    const queue = new BoundedQueue(2, 10);
    let running = 0;
    let peak = 0;

    const job = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
    };

    await Promise.all(Array.from({ length: 12 }, () => queue.run(undefined, job)));
    assert.equal(peak, 2);
    assert.equal(queue.stats().running, 0);
    assert.equal(queue.stats().queued, 0);
  });

  it('rejects with E_BUSY once the waiting room is full', async () => {
    const queue = new BoundedQueue(1, 1);
    const release = { resolve: () => {} } as { resolve: () => void };
    const blocker = new Promise<void>((resolve) => {
      release.resolve = resolve;
    });

    const first = queue.run(undefined, () => blocker); // takes the only slot
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = queue.run(undefined, () => blocker); // takes the only queue seat
    await new Promise((resolve) => setTimeout(resolve, 10));

    await assert.rejects(
      () => queue.run(undefined, async () => undefined),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'E_BUSY');
        assert.equal(error.status, 503);
        return true;
      },
    );

    release.resolve();
    await Promise.all([first, second]);
  });

  it('hasCapacity reports whether another request would be admitted', async () => {
    const queue = new BoundedQueue(1, 0);
    assert.equal(queue.hasCapacity(), true);
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = queue.run(undefined, () => blocker);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // One slot busy, no waiting room: the next request must be shed.
    assert.equal(queue.hasCapacity(), false);
    release();
    await running;
    assert.equal(queue.hasCapacity(), true);
  });

  it('releases the slot when the job throws', async () => {
    const queue = new BoundedQueue(1, 0);
    await assert.rejects(() => queue.run(undefined, async () => Promise.reject(new Error('boom'))));
    assert.equal(queue.stats().running, 0);
    // If the slot had leaked, this would hang.
    await queue.run(undefined, async () => undefined);
  });

  it('drops a queued request whose client went away', async () => {
    const queue = new BoundedQueue(1, 5);
    let release!: () => void;
    const running = queue.run(
      undefined,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    const controller = new AbortController();
    const queued = queue.run(controller.signal, async () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(queue.stats().queued, 1);

    const gone = new ClientGoneError();
    controller.abort(gone);
    await assert.rejects(() => queued, (error: unknown) => error === gone);
    // The abandoned seat must not be handed a slot later.
    assert.equal(queue.stats().queued, 0);

    release();
    await running;
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit inside the window, then refuses', () => {
    const limiter = new RateLimiter(2, 1000);
    assert.equal(limiter.check('1.2.3.4', 0), true);
    assert.equal(limiter.check('1.2.3.4', 10), true);
    assert.equal(limiter.check('1.2.3.4', 20), false);
    // A different source has its own budget.
    assert.equal(limiter.check('5.6.7.8', 20), true);
  });

  it('starts a fresh window once the old one expires', () => {
    const limiter = new RateLimiter(1, 1000);
    assert.equal(limiter.check('1.2.3.4', 0), true);
    assert.equal(limiter.check('1.2.3.4', 500), false);
    assert.equal(limiter.check('1.2.3.4', 1000), true);
  });
});

describe('error envelope', () => {
  it('carries the exact code, status and verbatim message for every case', () => {
    const cases: Array<[AppError, number, string, string]> = [
      [
        Errors.convertFailed(),
        500,
        'E_CONVERT_FAILED',
        'This document could not be converted. It may be damaged or in a format the converter does not support.',
      ],
      [Errors.timeout(), 504, 'E_TIMEOUT', 'This document took too long to convert.'],
      [Errors.encrypted(), 422, 'E_ENCRYPTED', 'This document is password protected.'],
      [
        Errors.unsupportedTarget('.docx', ['pdf', 'odt']),
        415,
        'E_UNSUPPORTED_TARGET',
        'A .docx file can be converted to: PDF, ODT.',
      ],
      [
        Errors.unknownTarget(['pdf', 'csv']),
        404,
        'E_UNKNOWN_TARGET',
        'That is not a format this converter can produce. Available: PDF, CSV.',
      ],
      [Errors.tooLarge(), 413, 'E_TOO_LARGE', 'This document is too large to convert.'],
      [Errors.busy(), 503, 'E_BUSY', 'The converter is busy. Try again in a moment.'],
    ];

    for (const [error, status, code, message] of cases) {
      assert.equal(error.status, status);
      assert.deepEqual(error.toEnvelope(), { error: { code, message } });
    }
  });

  it('writes messages for people, not for logs', () => {
    // Every error, with the arguments a real request would give it - the point
    // is the RENDERED sentence, so a factory that leaks a raw argument into the
    // text would be caught here.
    const samples: AppError[] = [
      Errors.convertFailed(),
      Errors.timeout(),
      Errors.encrypted(),
      Errors.unsupported(),
      Errors.unsupportedTarget('.docx', ['pdf', 'odt', 'txt']),
      Errors.unknownTarget(['pdf', 'odt']),
      Errors.tooLarge(),
      Errors.busy(),
      Errors.badRequest('no file part named "file"'),
      Errors.rateLimited(),
      Errors.internal(),
    ];

    for (const error of samples) {
      const produced = error.toEnvelope().error.message;
      assert.match(produced, /[.!?]$/, `not a sentence: ${produced}`);
      assert.doesNotMatch(produced, /\/|stack|Error:|undefined|null/i, `leaks internals: ${produced}`);
      // No codes in the text: the code is for logs only.
      assert.doesNotMatch(produced, /E_[A-Z_]+/, `mentions a code: ${produced}`);
    }
  });

  it('names what a document COULD become, not just that it failed', () => {
    // The useful answer to "can I have this as PNG" is what you can have instead.
    const message = Errors.unsupportedTarget('.docx', targetsFor('.docx')).toEnvelope()
      .error.message;
    assert.match(message, /PDF, ODT, TXT, HTML, RTF, EPUB/);
  });
});

describe('password-protected detection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await createWorkspace();
  });

  const write = async (name: string, bytes: Buffer): Promise<string> => {
    const path = join(dir, name);
    await fsp.writeFile(path, bytes);
    return path;
  };

  it('detects an encrypted OOXML package', async () => {
    const path = await write('a.docx', buildEncryptedDocxContainer());
    assert.equal(await isPasswordProtected(path), true);
  });

  it('detects the fEncrypted flag on a legacy .doc', async () => {
    const path = await write('a.doc', buildEncryptedLegacyDoc());
    assert.equal(await isPasswordProtected(path), true);
  });

  it('leaves an unencrypted legacy .doc alone', async () => {
    const path = await write('a.doc', buildPlainLegacyDoc());
    assert.equal(await isPasswordProtected(path), false);
  });

  it('leaves a normal .docx alone', async () => {
    const path = await write('a.docx', buildMinimalDocx(['hello']));
    assert.equal(await isPasswordProtected(path), false);
  });

  it('detects a PDF whose trailer names an /Encrypt dictionary', async () => {
    const path = await write('a.pdf', buildEncryptedPdfContainer());
    assert.equal(await isPasswordProtected(path), true);
  });

  it('leaves a normal PDF alone', async () => {
    const path = await write('a.pdf', pdfProbe());
    assert.equal(await isPasswordProtected(path), false);
  });

  it('does not mistake a stale /Encrypt from an earlier revision for a current one', async () => {
    // The bug this regression test pins: a whole-file search for "/Encrypt"
    // finds one in this fixture's FIRST revision, but the file's current
    // trailer (the one `startxref` actually points at) has no /Encrypt at
    // all - the password was removed by a later incremental save. Reporting
    // this as encrypted would reject a document soffice could convert fine.
    const path = await write('a.pdf', buildFormerlyEncryptedPdf());
    assert.equal(await isPasswordProtected(path), false);
  });

  it('leaves an ODP alone', async () => {
    // An ODF package is a zip, so it can never be a CFB container - the
    // detector must not misread the prefix of a zip as one.
    const path = await write('a.odp', buildMinimalOdp(['one']));
    assert.equal(await isPasswordProtected(path), false);
  });

  it('does not claim garbage is encrypted', async () => {
    const path = await write('a.docx', Buffer.alloc(256, 0x41));
    assert.equal(await isPasswordProtected(path), false);
  });

  it('does not claim an empty file is encrypted', async () => {
    const path = await write('a.docx', Buffer.alloc(0));
    assert.equal(await isPasswordProtected(path), false);
  });
});

describe('workspace lifecycle', () => {
  it('cleans up a workspace', async () => {
    const dir = await createWorkspace();
    assert.ok((await fsp.readdir(TEMP_ROOT)).includes(dir.slice(TEMP_ROOT.length + 1)));
    await removeWorkspace(dir);
    assert.equal(await fsp.stat(dir).then(() => true, () => false), false);
  });

  it('sweeps stale workspaces but keeps live ones', async () => {
    const stale = await createWorkspace();
    const fresh = await createWorkspace();
    // Backdate one directory so it looks like a crashed process left it behind.
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fsp.utimes(stale, old, old);

    await sweepStaleWorkspaces();

    assert.equal(await fsp.stat(stale).then(() => true, () => false), false, 'stale kept');
    assert.equal(await fsp.stat(fresh).then(() => true, () => false), true, 'fresh removed');
    await removeWorkspace(fresh);
  });
});

describe('config', () => {
  it('caps uploads at the 25MB the client also enforces', () => {
    assert.equal(MAX_UPLOAD_BYTES, 25 * 1024 * 1024);
  });

  it('names the on-disk upload from the validated extension only', () => {
    assert.equal(inputFileNameFor('.docx'), 'input.docx');
    assert.equal(inputFileNameFor('.odp'), 'input.odp');
    assert.equal(inputFileNameFor('.csv'), 'input.csv');
  });
});
