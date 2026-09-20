#!/usr/bin/env python3
"""
The non-LibreOffice half of the PDF pipeline.

LibreOffice opens a PDF as a Draw document and Draw has no Writer/Calc/Impress
export filter - verified against the shipped LibreOffice 24.2 by running
`soffice --convert-to docx/pptx/xlsx` against a real PDF and watching it fail
with "no export filter found" every time. So the `word`, `slides` and `sheet`
targets in formats.ts do not go through soffice at all: they are run through
this script instead, one purpose-built engine per target.

Invocation, matching what pdf-engine.service.ts spawns:

    pdf_engine.py <docx|pptx|xlsx|ocr> <input.pdf> <output-path> [ocr|force]
    pdf_engine.py compare <inputA.pdf> <inputB.pdf> <output.json>
    pdf_engine.py redact <input.pdf> <areas.json> <output.pdf>

`ocr` (`true`/`false`, defaults to `true`) only affects the `docx` operation -
see `convert_to_docx` and `_pdf_has_no_extractable_text`. It is accepted
positionally for every operation regardless, so the caller does not have to
special-case which operation it is talking to. For the `ocr` operation itself,
the same positional slot instead means `force` (`true`/`false`, defaults to
`false`) - see `run_ocr_operation`.

`compare` and `redact` are the two operations with a genuinely different
shape from "one PDF in, one PDF/OOXML file out": `compare` takes two PDFs in
and writes one JSON report; `redact` takes one PDF plus a path to a JSON file
describing the regions to strip, and writes one PDF. Both are special-cased
in `main()` before the generic argument parsing below, the same way this file
already treats xlsx's NO_TABLES_EXIT_CODE as a case the general flow does not
cover. `redact` takes its `areas` as a JSON FILE path rather than a raw JSON
string on argv deliberately: an argv string is subject to shell/exec argument
length limits and escaping hazards a long list of regions could realistically
hit, where a file the caller already wrote into the same per-request
workspace has neither problem.

Exit codes:
    0  wrote the output
    1  failed - stderr has a human-unreadable but log-worthy reason
    2  xlsx only: the PDF has no detectable tables (E_NO_TABLES, not a failure)

Each operation is independent and imports its own dependency, so a missing
package fails with a clear ModuleNotFoundError naming exactly what is missing,
rather than every operation going down if one dependency is absent.
"""
import difflib
import json
import os
import shutil
import sys
import tempfile

NO_TABLES_EXIT_CODE = 2

# Tesseract language codes, joined with '+' the way tesseract/ocrmypdf expect.
# English plus the languages this service's own real-world documents use
# (Azerbaijani, Turkish - the same alphabet family and the same "print to
# PDF" driver behaviour - and Russian, common alongside them in the same
# region). Overridable so a deployment with a different document mix is not
# stuck paying for language data it never uses.
OCR_LANGUAGES = os.environ.get('OCR_LANGUAGES', 'eng+aze+tur+rus')


def _pdf_uses_type3_fonts(input_path: str) -> bool:
    """
    True if any page embeds a Type3 font.

    Type3 fonts define each glyph as its own tiny content-stream program
    rather than a standard outline - common in PDFs produced by "print to
    PDF" drivers and older exporters for scripts a base font does not cover
    (this codebase found it on an Azerbaijani-language report; the same
    class of PDF is produced for Cyrillic, Vietnamese and various math
    typesetting for the same underlying reason). PyMuPDF's own text
    extraction reports these glyphs correctly - one span, one bbox, checked
    directly against this exact file - but pdf2docx's higher-level layout
    reconstruction does not: it was observed here duplicating and
    overlapping every line of a Type3-font page while leaving every non-
    Type3 page in the same document untouched, and no `pdf2docx` setting
    (table detection on or off, stream or lattice) changed that. Detecting
    the trigger up front and routing around `convert_to_docx` entirely is
    far more honest than shipping a `docx` that silently doubles its own
    text, and matches the docx/pptx boundary already checked from
    conversion.service.ts.
    """
    import fitz  # PyMuPDF

    document = fitz.open(input_path)
    try:
        return any(font[2] == 'Type3' for page in document for font in page.get_fonts())
    finally:
        document.close()


def _pdf_has_no_extractable_text(input_path: str) -> bool:
    """
    True if every page's text layer is essentially empty - the "this PDF is a
    picture of a document, not a document" signal every OCR tool checks for,
    and the ONLY condition `convert_to_docx` ever runs OCR on.

    A PDF that already has real text on even one page is left alone even if
    `ocr=true`: pdf2docx's OCR mode (`ocr=2`, see `_ocr_pdf`) is a
    document-wide switch that discards every page's embedded IMAGES in
    favour of its hidden OCR text layer - exactly right for a page that is
    nothing but a scan, and actively wrong for a page that already has real
    text sitting next to a legitimate picture, which would otherwise lose
    that picture for no benefit (there is no OCR text to gain from a page
    that was never scanned in the first place).

    A 10-character threshold rather than a strict emptiness check absorbs a
    stray page number or watermark on an otherwise blank scanned page without
    treating the document as "has real text after all".
    """
    import fitz  # PyMuPDF

    document = fitz.open(input_path)
    try:
        return all(len(page.get_text().strip()) < 10 for page in document)
    finally:
        document.close()


def _ocr_pdf(input_path: str, workspace: str) -> str:
    """
    Run OCRmyPDF over `input_path`, writing a new PDF into `workspace` that
    looks identical but now carries an invisible, searchable text layer
    behind each scanned page.

    This is the two-stage pipeline every serious "PDF OCR" tool actually
    uses, not a shortcut: pdf2docx has no OCR engine of its own - its own
    `ocr=1` ("do OCR") setting is an unimplemented stub in the installed
    version (`RawPageFitz.py` raises `SystemExit` if it is ever reached,
    confirmed by reading the source directly) - so a real OCR pass has to
    happen first, and pdf2docx's job is only to read what it produced
    (`ocr=2`, "this PDF has already been OCR-ed").

    `skip_text=True` is what makes this safe to run unconditionally on
    whatever `_pdf_has_no_extractable_text` already approved: OCRmyPDF's
    default behaviour is to REFUSE a PDF that already has any text layer at
    all (`PriorOcrFoundError`), and that flag tells it to OCR whichever pages
    genuinely have none and leave the rest untouched instead of raising -
    the caller's own check already means every page qualifies here, but this
    is the belt to that check's suspenders, not a redundant one.

    `output_type='pdf'`, `optimize=0` and `jobs=1` are load-bearing, not
    tuning: measured directly, a real 6MB, 10-page PDF OOM-killed the whole
    container under this service's own `mem_limit: 1g` (docker-compose.yml)
    without them. OCRmyPDF's DEFAULTS are `output_type='pdfa'` (a second,
    full Ghostscript rendering pass on top of the OCR rasterisation
    Tesseract already did, purely for PDF/A conformance nobody here asked
    for - the result is read for its text and then discarded) and
    `optimize=1` (a further pikepdf-based recompression pass) - both pure
    memory and CPU cost for a PDF this pipeline never serves to anyone.
    `jobs=1` disables OCRmyPDF's own per-page multiprocessing, which
    otherwise holds several rasterised pages in memory at once, competing
    with this same container's soffice processes for the memory
    `MAX_CONCURRENT_CONVERSIONS` was sized against.
    """
    import ocrmypdf

    output_path = os.path.join(workspace, 'ocred.pdf')
    ocrmypdf.ocr(
        input_path,
        output_path,
        language=OCR_LANGUAGES,
        skip_text=True,
        output_type='pdf',
        optimize=0,
        jobs=1,
        progress_bar=False,
    )
    return output_path


def _force_ocr_pdf(input_path: str, workspace: str) -> str:
    """
    Re-OCR `input_path` from scratch via OCRmyPDF's `force_ocr`, for a PDF
    whose pages already have a text layer pdf2docx cannot safely read - a
    Type3-font PDF (see `_pdf_uses_type3_fonts`), where the existing text is
    exactly what corrupts a normal reconstruction, not a substitute for real
    OCR.

    `force_ocr` rather than the `skip_text` mode `_ocr_pdf` uses: OCRmyPDF's
    `skip_text` still REFUSES to touch a page it thinks already has usable
    text, and a Type3 page technically does (that is the whole problem) -
    `force_ocr` strips whatever text layer is there, re-rasters the page to
    a plain image, and OCRs that fresh image instead. The result is
    structurally identical to what `_ocr_pdf` produces for a genuine scan -
    a page image plus an invisible OCR text layer - which is what lets the
    caller read it back with pdf2docx's `ocr=2` the same way, text only, no
    Type3 glyphs and no duplicated lines.

    `output_type='pdf'`, `optimize=0` and `jobs=1` for the same measured
    reason `_ocr_pdf` documents on its own call: OCRmyPDF's defaults add a
    second full Ghostscript rendering pass (for PDF/A conformance nobody
    reads this intermediate file for) and per-page multiprocessing, and a
    real document OOM-killed this service's own 1GB container without
    disabling both.
    """
    import ocrmypdf

    output_path = os.path.join(workspace, 'forced-ocr.pdf')
    ocrmypdf.ocr(
        input_path,
        output_path,
        language=OCR_LANGUAGES,
        force_ocr=True,
        output_type='pdf',
        optimize=0,
        jobs=1,
        progress_bar=False,
    )
    return output_path


def convert_to_docx(input_path: str, output_path: str, ocr: bool = True) -> None:
    """
    Reconstruct the PDF as an editable, reflowable Word document.

    pdf2docx (built on PyMuPDF) rebuilds each page's text runs, tables and
    images into real OOXML rather than dropping a picture of the page into a
    document - this is a genuine layout reconstruction, not a raster fallback,
    which is why it earns its own target (`word`) instead of piggybacking on
    the `docx` id that direct LibreOffice conversions use.

    Falls back for a PDF with Type3 fonts - see `_pdf_uses_type3_fonts` for
    why that specific trigger is checked rather than attempting the
    reconstruction and hoping. With `ocr` true (the default), that fallback
    is real recognised text and nothing else: the page is force-OCR'd
    (`_force_ocr_pdf`) and read back through the exact same text-only
    `pdf2docx` `ocr=2` path a genuine scan uses below - no embedded images,
    raw text only, which is what OCR is FOR. If OCR is turned off or fails,
    the fallback is `_convert_to_docx_as_pages` instead: a faithful picture
    of each page with no text at all, the same result this pipeline gave a
    Type3 PDF before OCR existed.

    For a PDF with no extractable text at all - a scanned document - and
    `ocr` true (the default), runs OCRmyPDF first and hands pdf2docx the
    result instead of the original, so a scan becomes real, reflowable text
    rather than an uneditable picture of one. An OCR failure (a missing
    language pack, a pathological image) degrades to the same plain
    conversion `ocr=false` would have produced - a docx with the page's
    image but no selectable text, which is what this pipeline already gave
    every scanned PDF before this feature existed - rather than failing the
    whole request over what is, for this endpoint, a best-effort enhancement.
    """
    from pdf2docx import Converter

    if _pdf_uses_type3_fonts(input_path):
        if ocr:
            try:
                workspace = os.path.dirname(os.path.abspath(output_path)) or tempfile.gettempdir()
                forced = _force_ocr_pdf(input_path, workspace)
                converter = Converter(forced)
                try:
                    converter.convert(output_path, ocr=2)
                    return
                finally:
                    converter.close()
            except Exception as error:  # noqa: BLE001 - degrade, don't fail the request over this
                print(f'OCR failed for a Type3 PDF, falling back to a plain page image: {error}', file=sys.stderr)
        _convert_to_docx_as_pages(input_path, output_path)
        return

    working_input = input_path
    ocr_settings = {}
    if ocr and _pdf_has_no_extractable_text(input_path):
        try:
            workspace = os.path.dirname(os.path.abspath(output_path)) or tempfile.gettempdir()
            working_input = _ocr_pdf(input_path, workspace)
            ocr_settings = {'ocr': 2}
        except Exception as error:  # noqa: BLE001 - degrade, don't fail the request over this
            print(f'OCR failed, falling back to a non-OCR conversion: {error}', file=sys.stderr)

    converter = Converter(working_input)
    try:
        converter.convert(output_path, **ocr_settings)
    finally:
        converter.close()


def _convert_to_docx_as_pages(input_path: str, output_path: str) -> None:
    """
    One page per page, each rendered whole as a full-bleed image - the docx
    twin of `convert_to_pptx`'s fallback, and for the same reason: this trades
    editability for a guarantee the layout is EXACTLY the source PDF's,
    pixel for pixel, which is the only thing worth guaranteeing once real
    text reconstruction is known to corrupt itself on this input.

    Each page gets its own docx section sized to that page's own points, so a
    document mixing portrait and landscape pages (or differently sized pages)
    still gets a correctly-shaped page for each rather than being forced into
    one fixed size - the same reasoning `imagesToPdf` in pdf-pages.service.ts
    applies to a set of scanned images.

    No text, ever - this is the LAST resort, reached only when `ocr=false`
    or OCR itself failed. When OCR succeeds, `convert_to_docx` never calls
    this at all; it reads recognised text back through `pdf2docx`'s own
    `ocr=2` path instead, which is text only with no image, matching what
    OCR is actually for.
    """
    import io

    import fitz  # PyMuPDF
    from docx import Document
    from docx.enum.section import WD_SECTION
    from docx.shared import Emu

    # Matches RASTER_DPI in config.ts, so a PDF's pages and the fallback here
    # come out at the same fidelity as every other raster path in this service.
    dpi = 150
    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    # PDF points are 1/72"; EMUs are 914400 per inch - the ratio a page's own
    # point-based size converts by, independent of the raster DPI above.
    emu_per_point = 914400 / 72.0

    document = fitz.open(input_path)
    try:
        if document.page_count == 0:
            raise ValueError('PDF has no pages')

        output = Document()
        for index, page in enumerate(document):
            width_emu = Emu(int(round(page.rect.width * emu_per_point)))
            height_emu = Emu(int(round(page.rect.height * emu_per_point)))

            section = output.sections[0] if index == 0 else output.add_section(WD_SECTION.NEW_PAGE)
            section.page_width = width_emu
            section.page_height = height_emu
            section.left_margin = Emu(0)
            section.right_margin = Emu(0)
            section.top_margin = Emu(0)
            section.bottom_margin = Emu(0)
            section.header_distance = Emu(0)
            section.footer_distance = Emu(0)

            pixmap = page.get_pixmap(matrix=matrix)
            paragraph = output.add_paragraph()
            paragraph.paragraph_format.space_before = Emu(0)
            paragraph.paragraph_format.space_after = Emu(0)
            paragraph.add_run().add_picture(
                io.BytesIO(pixmap.tobytes('png')), width=width_emu, height=height_emu
            )

        output.save(output_path)
    finally:
        document.close()


def convert_to_pptx(input_path: str, output_path: str) -> None:
    """
    One slide per page, each page rendered whole as the slide's background image.

    There is no PDF-to-Impress import filter to reconstruct editable shapes
    from - Draw is as close as LibreOffice gets, and Draw does not write
    .pptx - so this is deliberately the same trick real "PDF to PowerPoint"
    tools fall back to for anything that is not already a native deck: a
    faithful image of the page on a slide sized to match it, which keeps the
    layout perfect and the deck genuinely a .pptx a person can open, present
    from and add slides to.
    """
    import fitz  # PyMuPDF
    from pptx import Presentation
    from pptx.util import Emu

    # 150 DPI matches RASTER_DPI in config.ts, so a PDF's slides and a
    # presentation's PNG/JPG pages come out at the same fidelity.
    dpi = 150
    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    # PDF points are 1/72", and EMUs are 914400 per inch - the ratio a page's
    # own point size converts by, independent of the raster DPI chosen above.
    emu_per_point = 914400 / 72.0

    document = fitz.open(input_path)
    try:
        if document.page_count == 0:
            raise ValueError('PDF has no pages')

        presentation = Presentation()
        for page in document:
            pixmap = page.get_pixmap(matrix=matrix)
            image_bytes = pixmap.tobytes('png')

            width_emu = Emu(int(round(page.rect.width * emu_per_point)))
            height_emu = Emu(int(round(page.rect.height * emu_per_point)))
            presentation.slide_width = width_emu
            presentation.slide_height = height_emu

            slide = presentation.slides.add_slide(presentation.slide_layouts[6])
            slide.shapes.add_picture(
                io_bytes(image_bytes), 0, 0, width=width_emu, height=height_emu
            )

        presentation.save(output_path)
    finally:
        document.close()


def io_bytes(data: bytes):
    import io

    return io.BytesIO(data)


def convert_to_xlsx(input_path: str, output_path: str) -> None:
    """
    Every ruled table in the PDF, as one worksheet each.

    The PDF-source twin of the `tables` extractor for Word documents: both are
    lossy on purpose (prose, images and everything that is not a table is
    dropped) and both answer E_NO_TABLES rather than a generic failure when
    the source genuinely has none. pdfplumber's default strategy looks for
    ruled lines, so a table drawn without visible borders will not be found -
    the same honest limitation as any lines-based table detector, and
    preferable to guessing column boundaries from whitespace, which silently
    merges columns that happen to sit close together.
    """
    import openpyxl
    import pdfplumber

    workbook = openpyxl.Workbook()
    workbook.remove(workbook.active)
    used_names = set()
    table_count = 0

    with pdfplumber.open(input_path) as pdf:
        for page_index, page in enumerate(pdf.pages, start=1):
            for table_index, rows in enumerate(page.extract_tables(), start=1):
                if not rows:
                    continue
                table_count += 1
                sheet = workbook.create_sheet(
                    title=sheet_name(page_index, table_index, used_names)
                )
                for row in rows:
                    sheet.append(['' if cell is None else cell for cell in row])

    if table_count == 0:
        sys.exit(NO_TABLES_EXIT_CODE)

    workbook.save(output_path)


def sheet_name(page_index: int, table_index: int, used_names: set) -> str:
    """Excel sheet names are capped at 31 characters and must be unique."""
    base = f'Page{page_index}_Table{table_index}'[:31]
    name = base
    suffix = 2
    while name in used_names:
        name = f'{base[: 31 - len(str(suffix)) - 1]}_{suffix}'
        suffix += 1
    used_names.add(name)
    return name


def run_ocr_operation(input_path: str, output_path: str, force: bool = False) -> None:
    """
    Make `input_path` searchable, standalone - the `/pdf/ocr` endpoint's
    engine call, as opposed to OCR as an internal step of `convert_to_docx`.

    Three cases, matched to the two existing OCR helpers rather than a third
    one, because the decision they embody ("does this page already have a
    text layer I can trust") is exactly the decision this endpoint needs too:

      - `force` true: always re-OCR via `_force_ocr_pdf`, discarding whatever
        text is already there. For a document whose existing text is wrong in
        some way (Type3 glyphs, a bad OCR pass from another tool) - the same
        justification `convert_to_docx` has for reaching for
        `_force_ocr_pdf` on a Type3 PDF, just user-triggered instead of
        content-triggered.
      - `force` false and the PDF already has real extractable text on every
        page: nothing to do. Copying the input to the output unchanged (not
        an error) is the same "opened fine, nothing to extract" philosophy
        E_NO_TABLES/E_NO_LAYERS document on the TypeScript side, applied
        here instead of raising a distinct exit code for it, since a no-op
        success is a perfectly good answer to "make this searchable" when it
        already is.
      - `force` false and the PDF has no extractable text (a scan): run
        `_ocr_pdf`, the normal OCRmyPDF `skip_text` pass.
    """
    if force:
        workspace = os.path.dirname(os.path.abspath(output_path)) or tempfile.gettempdir()
        produced = _force_ocr_pdf(input_path, workspace)
        shutil.copyfile(produced, output_path)
        return

    if not _pdf_has_no_extractable_text(input_path):
        shutil.copyfile(input_path, output_path)
        return

    workspace = os.path.dirname(os.path.abspath(output_path)) or tempfile.gettempdir()
    produced = _ocr_pdf(input_path, workspace)
    shutil.copyfile(produced, output_path)


def run_compare_operation(input_path_a: str, input_path_b: str, output_path: str) -> None:
    """
    Per-page text diff of two PDFs, written as JSON to `output_path`.

    Page numbers in the JSON are 1-based - this is API-facing output read by
    a phone, not an internal pdf-lib page index, and 1-based is what a person
    comparing "page 4 changed" actually means. The rest of this codebase's
    TypeScript layer uses 0-based indices for pdf-lib operations; that is a
    different layer with a different audience and staying consistent WITHIN
    this JSON matters more than matching a convention from a language this
    file is not written in.

    Pages are compared pairwise up to `min(pageCountA, pageCountB)`; anything
    beyond that is reported separately as `extraPagesInA`/`extraPagesInB`
    rather than diffed against nothing, since "page 5 doesn't exist in B" is a
    different fact from "page 5 changed".

    `SequenceMatcher` over each page's text split into lines (rather than a
    single whole-page string diff) is what lets the response say WHICH lines
    were inserted/deleted/replaced instead of only "this page differs" -
    `get_text()` already gives text broken at PDF's own line boundaries via
    embedded whitespace, so splitting on '\\n' recovers the layout PyMuPDF saw.
    """
    import fitz  # PyMuPDF

    document_a = fitz.open(input_path_a)
    document_b = fitz.open(input_path_b)
    try:
        page_count_a = document_a.page_count
        page_count_b = document_b.page_count
        shared = min(page_count_a, page_count_b)

        pages = []
        for index in range(shared):
            lines_a = document_a[index].get_text().splitlines()
            lines_b = document_b[index].get_text().splitlines()
            if lines_a == lines_b:
                pages.append({'page': index + 1, 'equal': True})
                continue

            diff = []
            matcher = difflib.SequenceMatcher(a=lines_a, b=lines_b, autojunk=False)
            for tag, a_start, a_end, b_start, b_end in matcher.get_opcodes():
                if tag == 'equal':
                    op = 'equal'
                elif tag == 'insert':
                    op = 'insert'
                elif tag == 'delete':
                    op = 'delete'
                else:
                    op = 'replace'
                diff.append({'op': op, 'a': lines_a[a_start:a_end], 'b': lines_b[b_start:b_end]})
            pages.append({'page': index + 1, 'equal': False, 'diff': diff})

        report = {
            'pageCountA': page_count_a,
            'pageCountB': page_count_b,
            'pages': pages,
            'extraPagesInA': list(range(shared + 1, page_count_a + 1)),
            'extraPagesInB': list(range(shared + 1, page_count_b + 1)),
        }
    finally:
        document_a.close()
        document_b.close()

    with open(output_path, 'w', encoding='utf-8') as handle:
        json.dump(report, handle)


def run_redact_operation(input_path: str, areas_path: str, output_path: str) -> None:
    """
    Genuinely strip the content under each requested rectangle - not draw a
    black box over it. This is the ONE reason this operation exists at all:
    `pdf-lib` (used for `/pdf/watermark`, `/pdf/sign` and every other page-
    marking endpoint in this service) can only ADD content, never remove
    what is already there, so "redact" via `pdf-lib` would mean drawing an
    opaque rectangle on top of text/images that are still fully present and
    extractable underneath it - a fake redaction that `pdftotext` or any
    viewer with a "show hidden layers" mode defeats instantly. PyMuPDF's own
    redaction annotations are a real second pass over the page's content
    stream: `apply_redactions()` deletes whatever text spans and vector
    graphics intersect each marked rectangle, not merely paints over them
    (verified directly against this exact call sequence: a page with two
    separated text lines, redacting a rectangle over only one of them,
    leaves `get_text()` reporting only the other line - the redacted line is
    not present in the extracted text at all, not merely hidden).

    `areas_path` is a JSON file (not a raw argv string - see this module's
    docstring for why) holding a JSON array of
    `{"page": <1-based int>, "x", "y", "width", "height"}` objects, all in
    points. Page numbers are 1-based because this is the same API-facing
    JSON shape `run_compare_operation` already establishes for this
    endpoint family; `x`/`y` are TOP-LEFT origin because that is the
    `/pdf/sign` convention this endpoint's HTTP contract deliberately
    reuses - and PyMuPDF's own coordinate system is ALSO top-left-origin
    natively (unlike pdf-lib elsewhere in this codebase, which is
    bottom-left and needs the `H - y - height` flip `/pdf/sign` documents),
    so no coordinate conversion happens here at all: an incoming `x`/`y`/
    `width`/`height` box becomes `fitz.Rect(x, y, x + width, y + height)`
    unchanged. This was verified directly, not assumed, before being relied
    on here.

    A `page` outside the document's range raises - the TypeScript side
    already validates every `page` against a `pdfPageCount` it read before
    ever invoking this script (the same defense-in-depth `pages.controller.ts`
    already applies before every other page-selecting engine call), so
    reaching this check at all here would mean that earlier validation was
    bypassed or disagrees with what PyMuPDF itself sees as the page count -
    worth failing loudly on rather than silently clamping or skipping.

    Redaction annotations for every area on a given page are added FIRST,
    and `apply_redactions()` is called exactly ONCE per page after all of
    that page's annotations exist - not once per area. Both orders were
    tested directly against this installed PyMuPDF version before choosing
    this one: calling `apply_redactions()` once per area (add one annotation,
    apply, add the next, apply again) also works correctly here, but doing
    it that way means re-scanning and rewriting the page's content stream
    once per area instead of once per page, for a page that may have many
    areas - pure wasted work with no benefit, since nothing about a
    redaction on one area of a page depends on whether an earlier area's
    redaction already landed. One call after every area for that page is
    added removes that waste and is the pattern PyMuPDF's own documentation
    recommends.
    """
    import fitz  # PyMuPDF

    with open(areas_path, 'r', encoding='utf-8') as handle:
        areas = json.load(handle)

    document = fitz.open(input_path)
    try:
        page_count = document.page_count
        areas_by_page: dict = {}
        for area in areas:
            page_number = area['page']
            if not isinstance(page_number, int) or page_number < 1 or page_number > page_count:
                raise ValueError(
                    f'redact area names page {page_number!r}, but this PDF has {page_count} page(s)'
                )
            areas_by_page.setdefault(page_number, []).append(area)

        for page_number, page_areas in areas_by_page.items():
            page = document[page_number - 1]
            for area in page_areas:
                x, y, width, height = area['x'], area['y'], area['width'], area['height']
                rect = fitz.Rect(x, y, x + width, y + height)
                page.add_redact_annot(rect, fill=(0, 0, 0))
            # Exactly once per page, after every area on it has an annotation -
            # see the docstring above for why this is not called per-area.
            page.apply_redactions()

        document.save(output_path)
    finally:
        document.close()


OPERATIONS = {
    'docx': convert_to_docx,
    'pptx': convert_to_pptx,
    'xlsx': convert_to_xlsx,
    'ocr': run_ocr_operation,
}


def main() -> int:
    # `compare` takes two input PDFs, not one, so its argument count and
    # shape are genuinely different from every other operation here - special
    # cased before the generic parsing below, the same way NO_TABLES_EXIT_CODE
    # is a special case rather than being squeezed into the general flow.
    if len(sys.argv) >= 2 and sys.argv[1] == 'compare':
        if len(sys.argv) != 5:
            print(f'usage: {sys.argv[0]} compare <inputA.pdf> <inputB.pdf> <output.json>', file=sys.stderr)
            return 1
        try:
            run_compare_operation(sys.argv[2], sys.argv[3], sys.argv[4])
        except Exception as error:  # noqa: BLE001 - reported to stderr, not swallowed
            print(f'compare failed: {error}', file=sys.stderr)
            return 1
        return 0

    # `redact` takes a PDF plus a path to a JSON side-input rather than a
    # second PDF, so - like `compare` above - its argument count and shape
    # are special-cased ahead of the generic parsing below.
    if len(sys.argv) >= 2 and sys.argv[1] == 'redact':
        if len(sys.argv) != 5:
            print(f'usage: {sys.argv[0]} redact <input.pdf> <areas.json> <output.pdf>', file=sys.stderr)
            return 1
        try:
            run_redact_operation(sys.argv[2], sys.argv[3], sys.argv[4])
        except Exception as error:  # noqa: BLE001 - reported to stderr, not swallowed
            print(f'redact failed: {error}', file=sys.stderr)
            return 1
        return 0

    if len(sys.argv) not in (4, 5):
        print(f'usage: {sys.argv[0]} <docx|pptx|xlsx|ocr> <input.pdf> <output-path> [ocr|force]', file=sys.stderr)
        return 1

    operation, input_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]
    handler = OPERATIONS.get(operation)
    if handler is None:
        print(f'unknown operation "{operation}", expected one of {sorted(OPERATIONS)}', file=sys.stderr)
        return 1

    try:
        if operation == 'docx':
            # Defaults true: anything other than the literal string "false"
            # is treated as "yes, OCR it" - matches this flag's original,
            # already-shipped behaviour for the docx operation exactly.
            ocr = sys.argv[4].lower() != 'false' if len(sys.argv) == 5 else True
            convert_to_docx(input_path, output_path, ocr=ocr)
        elif operation == 'ocr':
            # Defaults false: same positional slot, opposite polarity - see
            # run_ocr_operation for why "should I force re-OCR" defaults to
            # no rather than yes.
            force = sys.argv[4].lower() == 'true' if len(sys.argv) == 5 else False
            run_ocr_operation(input_path, output_path, force=force)
        else:
            handler(input_path, output_path)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - reported to stderr, not swallowed
        print(f'{operation} failed: {error}', file=sys.stderr)
        return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
