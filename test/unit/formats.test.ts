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

const { BoundedQueue, RateLimiter } = await import('../../src/lib/queue.ts');
const { Errors, AppError, ClientGoneError } = await import('../../src/errors.ts');
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
} = await import('../../src/formats.ts');
const { isPasswordProtected } = await import('../../src/lib/encrypted.ts');
const {
  createWorkspace,
  removeWorkspace,
  sweepStaleWorkspaces,
  inputFileNameFor,
} = await import('../../src/services/workspace.service.ts');
const { zipStored, safeEntryName } = await import('../../src/lib/zip.ts');
const { EXTRACT_TARGET_IDS } = await import('../../src/pipelines/conversion.pipeline.ts');
const { decodeUploadName, downloadNameFor, contentDispositionFor } = await import(
  '../../src/lib/download-name.ts'
);
const { buildMinimalDocx, buildMinimalOdp, buildSolidPng, pdfProbe } = await import(
  '../../src/lib/probe-documents.ts'
);
const { MAX_UPLOAD_BYTES, MAX_DOWNLOAD_NAME_LENGTH, TEMP_ROOT } = await import(
  '../../src/config.ts'
);
const {
  buildEncryptedDocxContainer,
  buildEncryptedLegacyDoc,
  buildEncryptedPdfContainer,
  buildFormerlyEncryptedPdf,
  buildPlainLegacyDoc,
} = await import('../support/fixtures.ts');

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
    assert.equal(ALLOWED_EXTENSIONS.length, 101);
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

        const isDataEngineFromRoute = resolved.engine === 'data' && TARGETS[target].mode !== 'data';
        const isEbookEngineFromRoute = resolved.engine === 'ebook' && TARGETS[target].mode !== 'ebook';
        const isEmailEngineFromRoute = resolved.engine === 'email';
        if (
          resolved.engine === 'pdf-engine' ||
          resolved.engine === 'pandoc' ||
          isDataEngineFromRoute ||
          isEbookEngineFromRoute ||
          isEmailEngineFromRoute
        ) {
          // A second, non-LibreOffice route to this target id - see
          // `engineFrom`'s doc comment. Checked before `mode`, because `mode`
          // describes how every OTHER source reaches this same id. The
          // `data`/`ebook` engines are only ever this kind of route for
          // `csv`/`epub` (whose own `mode` stays `'direct'`) - see
          // `DATA_TARGETS`'s/`EBOOK_TARGETS`'s own comments; every OTHER
          // data/ebook target is `mode: 'data'`/`'ebook'` itself and is
          // checked further down instead. `email` has no `mode` of its own
          // at all - `.eml` only ever reaches `txt`/`html`, both EXISTING
          // `direct` targets, so this route is unconditional for it.
          assert.equal(resolved.convertTo, '', `${extension} -> ${target} invented a filter`);
          const key =
            resolved.engine === 'pdf-engine'
              ? 'pdf'
              : resolved.engine === 'pandoc'
                ? 'pandoc'
                : resolved.engine === 'ebook'
                  ? 'ebook'
                  : resolved.engine === 'email'
                    ? 'email'
                    : 'data';
          assert.ok(
            TARGETS[target].engineFrom?.[key]?.includes(extension),
            `${extension} -> ${target}, but the target does not list it under "${key}" as an engine source`,
          );
          continue;
        }

        if (TARGETS[target].mode === 'heif' || extension === '.heic' || extension === '.heif') {
          // `libheif`'s own tools, not LibreOffice, read/write every
          // `.heic`/`.heif` pair - no filter, no family - see
          // `heif.engine.ts`. Checked before `mode === 'transcode'` below:
          // a `.heic`/`.heif` SOURCE reaching an ordinary transcode target
          // (`bmp`/`gif`/etc) still needs this engine, not bare `ffmpeg`,
          // which cannot read it at all - see `resolveConversion`'s own
          // `heif`-before-`transcode` branch.
          assert.equal(resolved.engine, 'heif', `${extension} -> ${target} used the wrong engine`);
          assert.equal(resolved.convertTo, '', `${extension} -> ${target} invented a filter`);
          continue;
        }

        if (TARGETS[target].mode === '3d') {
          // `assimp`, family-less like `heif` above - see `assimp.engine.ts`.
          assert.equal(resolved.engine, 'assimp', `${extension} -> ${target} used the wrong engine`);
          assert.equal(resolved.convertTo, '', `${extension} -> ${target} invented a filter`);
          continue;
        }

        if (TARGETS[target].mode === 'ebook') {
          // `ebook-convert`, family-less like `heif` above - see
          // `ebook.engine.ts`.
          assert.equal(resolved.engine, 'ebook', `${extension} -> ${target} used the wrong engine`);
          assert.equal(resolved.convertTo, '', `${extension} -> ${target} invented a filter`);
          continue;
        }

        if (TARGETS[target].mode === 'font') {
          // `font_engine.py`, family-less like `heif` above - see
          // `font.engine.ts`.
          assert.equal(resolved.engine, 'font', `${extension} -> ${target} used the wrong engine`);
          assert.equal(resolved.convertTo, '', `${extension} -> ${target} invented a filter`);
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

        if (TARGETS[target].mode === 'archive') {
          // `7z`, not LibreOffice, reads and writes every archive pair - no
          // filter, no family, same as `extract` above but its own engine.
          assert.equal(resolved.engine, 'archive', `${extension} -> ${target} used the wrong engine`);
          assert.equal(resolved.convertTo, '', `${extension} -> ${target} invented a filter`);
          continue;
        }

        if (TARGETS[target].mode === 'transcode') {
          // `ffmpeg`, not LibreOffice, reads and writes every transcode
          // pair - no filter, and a family (`.png`/`.jpg`/`.jpeg` also have
          // one, for their `pdf` target) is irrelevant to this route.
          assert.equal(resolved.engine, 'ffmpeg', `${extension} -> ${target} used the wrong engine`);
          assert.equal(resolved.convertTo, '', `${extension} -> ${target} invented a filter`);
          continue;
        }

        if (TARGETS[target].mode === 'data') {
          // Pure JS, no subprocess, no filter, no family - see
          // `data.service.ts`.
          assert.equal(resolved.engine, 'data', `${extension} -> ${target} used the wrong engine`);
          assert.equal(resolved.convertTo, '', `${extension} -> ${target} invented a filter`);
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
        `"${id}" is an extract target with no engine in conversion.pipeline.ts`,
      );
    }
  });

  it('routes only presentations and PDFs to the raster pipeline', () => {
    // A raster target is split into one image per page, which only means
    // anything for a document with pages to show - a presentation, or a PDF,
    // which is pages already and skips the render-to-PDF half of the
    // pipeline entirely (see conversion.pipeline.ts's `sourceIsPdf`).
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
