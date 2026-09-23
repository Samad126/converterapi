"""
The three standalone page operations: `/pdf/ocr`, `/pdf/compare` and
`/pdf/redact` - a genuinely different shape from the `docx`/`pptx`/`xlsx`/
`markdown` targets, since each takes its own distinct argument set rather
than "one PDF in, one file out".
"""
import difflib
import json
import os
import shutil
import tempfile

from .ocr import _force_ocr_pdf, _ocr_pdf, _pdf_has_no_extractable_text


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
