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

    pdf_engine.py <docx|pptx|xlsx|markdown|ocr> <input.pdf> <output-path> [ocr|force]
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
import re
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


# `fonts-dejavu-core` (a Dockerfile dependency - see its own comment there)
# for Unicode coverage, not metric-compatibility: this font is drawn INTO a
# PDF, not chosen for LibreOffice to pick a substitute at render time, so
# matching some other font's line-breaking is not the concern here. It IS
# the concern for `fonts-crosextra-caladea` (metric-compatible with Cambria,
# which is what the report this feature was built for turned out to be set
# in) - checked directly and found MISSING Azerbaijani's schwa (`ə`), which
# `insert_text` then silently drops rather than erroring on, corrupting
# every word containing one with no warning at all. DejaVu Serif has it.
_TYPE3_REPLACEMENT_FONTS = {
    (False, False): '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
    (True, False): '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
    (False, True): '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf',
    (True, True): '/usr/share/fonts/truetype/dejavu/DejaVuSerif-BoldItalic.ttf',
}


def _rebuild_pdf_without_type3_fonts(input_path: str, workspace: str) -> str:
    """
    Clone `input_path`, page by page, replacing every Type3 glyph with the
    same text set in a real font (`_TYPE3_REPLACEMENT_FONTS`) while keeping
    the page's genuine ruling lines - the twin fix to OCR, and the one this
    codebase settled on: PyMuPDF's own text extraction already reads Type3
    glyphs correctly (see `_pdf_uses_type3_fonts`), so re-drawing that exact
    text with a real font sidesteps pdf2docx's Type3 corruption AND every
    OCR misread (`_force_ocr_pdf` was the previous approach here - measured
    directly against a real Type3 report, OCR misread "1201A" as "İ201A"
    and "Arifli" as "Arıflı", and gave up on a dot-leader table of contents
    entirely). The caller reruns the ordinary `convert_to_docx` pipeline on
    the result, which now sees a perfectly normal, non-Type3 PDF.

    Rulings are filtered through `_is_ruling_line` for the exact reason
    `_render_lines_only_png` does: a Type3 glyph IS a vector drawing, so
    `page.get_drawings()` unfiltered would redraw every letter a second
    time as a "line", underneath the text this function is also about to
    insert - confirmed directly while building this function, before the
    filter was added here.

    Bold/italic are read from `span['flags']` and mapped to the matching
    Liberation Serif style file rather than faked with a transform, so the
    substitute glyphs are actually shaped like bold/italic text, not a
    skewed regular weight.
    """
    import fitz  # PyMuPDF

    source = fitz.open(input_path)
    try:
        rebuilt = fitz.open()
        try:
            for page in source:
                new_page = rebuilt.new_page(width=page.rect.width, height=page.rect.height)

                shape = new_page.new_shape()
                for path in page.get_drawings():
                    if not _is_ruling_line(path):
                        continue
                    for item in path['items']:
                        op = item[0]
                        if op == 'l':
                            shape.draw_line(item[1], item[2])
                        elif op == 're':
                            shape.draw_rect(item[1])
                        elif op == 'qu':
                            shape.draw_quad(item[1])
                        elif op == 'c':
                            shape.draw_bezier(item[1], item[2], item[3], item[4])
                    shape.finish(
                        color=path.get('color'),
                        fill=path.get('fill'),
                        width=path.get('width') or 1.0,
                        closePath=path.get('closePath', True),
                    )
                shape.commit()

                for block in page.get_text('dict')['blocks']:
                    if block.get('type') != 0:  # not a text block (e.g. an image)
                        continue
                    for line in block['lines']:
                        for span in line['spans']:
                            text = span['text']
                            if not text.strip():
                                continue
                            bold = bool(span['flags'] & 16)
                            italic = bool(span['flags'] & 2)
                            fontfile = _TYPE3_REPLACEMENT_FONTS[(bold, italic)]
                            new_page.insert_text(
                                span['origin'],
                                text,
                                fontsize=span['size'],
                                fontfile=fontfile,
                                fontname=f'type3-replacement-{int(bold)}{int(italic)}',
                            )

            output_path = os.path.join(workspace, 'de-type3.pdf')
            rebuilt.save(output_path)
            return output_path
        finally:
            rebuilt.close()
    finally:
        source.close()


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


def _is_ruling_line(path: dict) -> bool:
    """
    True if `path` (one entry from `page.get_drawings()`) is a genuine
    ruling - an underline, a signature line, a table rule - rather than a
    glyph's own outline.

    This distinction only matters at all because of Type3 fonts: a normal
    font's glyphs are drawn with text operators and never show up in
    `get_drawings()` in the first place, but a Type3 glyph IS a tiny vector
    drawing (that is what "Type3" means - each glyph is its own draw
    program) - so on a Type3-font page, "every vector drawing" includes
    every letter of every word. Confirmed directly on this exact class of
    PDF: naively rendering all drawings duplicated the entire page's body
    text, in the original font, floating behind the real reconstructed
    text.

    Two checks tell a ruling apart from a glyph, together, because neither
    alone works: a ruling is THIN in one dimension (a hairline stroke or a
    thin filled bar) which a page number's digit is not (it's small in
    both), and a ruling is also LONG in the other dimension, which a small
    dot-leader period is not (it's small in both dimensions too, just like
    a digit) - so a bare "is thin" check alone would keep leader dots, and
    a bare "is long" check alone would keep multi-character text runs.
    `item_count` is a belt-and-suspenders cap: every ruling observed here
    is drawn with a handful of path segments, where a Type3 glyph cluster -
    especially pdf2docx/PyMuPDF's own merged runs of several adjacent
    glyphs - routinely reaches into the hundreds.
    """
    rect = path['rect']
    width, height = rect.width, rect.height
    return len(path['items']) <= 30 and min(width, height) <= 3.0 and max(width, height) >= 12.0


def _pdf_has_dense_vector_lines(input_path: str) -> bool:
    """
    True if some page draws a lot of ruling lines that are overwhelmingly
    ONE orientation - the specific shape of a form's underline rules
    (`Tələbə: _______`, one per field, all horizontal, nothing dividing
    them into columns), and the case pdf2docx's own table-detection
    heuristic (grouping intersecting borders into cells) gets wrong: it
    picks up those rules as table borders anyway, misgroups them with
    unrelated text runs, and recolours/duplicates spans in the process
    (observed directly on an Azerbaijani internship-report template - text
    that also has no underline in the source coming out red and
    underlined).

    A real table - checked directly against a PDF built entirely out of
    them - draws vertical rulings at several DISTINCT x-positions (one per
    column boundary; every real table sampled had at least 6), and
    pdf2docx's table detection handles that shape correctly; disabling it
    there would trade a working table for the same plain-paragraphs-plus-
    line-image fallback this function exists to avoid needing in the first
    place. Distinct positions rather than a raw vertical count: a resume
    with one single vertical divider line (separating a date column from
    the rest, say) running down the whole page draws that ONE line as
    several separate drawing objects, one per row it passes - plenty of
    "vertical rulings" by count, but still only one real column boundary,
    and pdf2docx's table detection turns that into a bordered two-column
    table that does not exist in the source at all (confirmed directly:
    a resume whose PDF has no table borders anywhere came out with visible
    cell borders and text spilling outside them in Word). So this checks
    for the LOPSIDED case specifically - plenty of rulings, but either
    essentially all one orientation, or with fewer than 2 distinct column
    boundaries - rather than just "plenty of rulings": a raw count alone
    flagged a real, working table too, and disabled it for no reason.

    Filtered through `_is_ruling_line` rather than counting every
    `get_drawings()` entry: on a Type3-font page (see `_is_ruling_line`),
    the raw count is dominated by glyph paths and would trigger this on
    every Type3 PDF regardless of whether it draws any real ruling at all.

    Checked as the BUSIEST single page, not a document-wide average: a
    real-world report is exactly the shape "one line-heavy cover/signature
    page plus several pages of plain prose with zero rulings" - averaging
    over every page (tried first, against a real 10-page report whose
    cover page alone draws 10 rulings) dilutes that one page below any
    sane threshold and never triggers at all. The overlay this gates is
    applied per page regardless, so nothing but the trigger itself needed
    to change.
    """
    import fitz  # PyMuPDF

    document = fitz.open(input_path)
    try:
        if document.page_count == 0:
            return False
        for page in document:
            lines = [path for path in page.get_drawings() if _is_ruling_line(path)]
            if len(lines) < 6:
                continue
            vertical_x_positions = {
                round(path['rect'].x0) for path in lines if path['rect'].height > path['rect'].width
            }
            if len(vertical_x_positions) < 2:
                return True
        return False
    finally:
        document.close()


def _render_lines_only_png(page, matrix) -> bytes:
    """
    Rasterise only `page`'s vector graphics (the ruled lines/boxes a form
    draws for its own "table") onto a transparent background, with no text -
    the twin image `_add_line_overlay_backgrounds` drops behind pdf2docx's
    reconstructed text so a line-heavy PDF keeps its exact ruling without
    pdf2docx ever having to (mis)interpret those lines as table borders.

    Redrawn onto a fresh, contentless page rather than clipping the
    original: a page with nothing painted on it renders as fully
    transparent (`alpha=True`), which a clipped screenshot of the real page
    is not - that would carry the white page background and the text along
    with it.
    """
    import fitz  # PyMuPDF

    overlay_doc = fitz.open()
    try:
        overlay_page = overlay_doc.new_page(width=page.rect.width, height=page.rect.height)
        shape = overlay_page.new_shape()
        for path in page.get_drawings():
            if not _is_ruling_line(path):
                continue
            for item in path['items']:
                op = item[0]
                if op == 'l':
                    shape.draw_line(item[1], item[2])
                elif op == 're':
                    shape.draw_rect(item[1])
                elif op == 'qu':
                    shape.draw_quad(item[1])
                elif op == 'c':
                    shape.draw_bezier(item[1], item[2], item[3], item[4])
            shape.finish(
                color=path.get('color'),
                fill=path.get('fill'),
                width=path.get('width') or 1.0,
                closePath=path.get('closePath', True),
            )
        shape.commit()
        pixmap = overlay_page.get_pixmap(matrix=matrix, alpha=True)
        return pixmap.tobytes('png')
    finally:
        overlay_doc.close()


def _float_picture_behind_text(run, width_emu: int, height_emu: int) -> None:
    """
    Rewrite the inline picture `run.add_picture` just created (its usual,
    only mode) into a floating one anchored to the page at (0, 0) and sent
    behind the text - turning it from "an image inline in the paragraph
    text" into "a page background" without leaving flow at all, so it never
    pushes the real, editable text pdf2docx produced out of place.

    Doing this by mutating the `wp:inline` element `add_picture` already
    built - reusing its `a:graphic`/`pic:pic`/relationship rather than
    constructing a picture from scratch - is deliberate: that element is
    already a complete, valid picture; only the wrapper that positions it
    within the run needs to change from `wp:inline` (flows with text) to
    `wp:anchor` (positioned independently, `behindDoc="1"`).
    """
    from docx.oxml.ns import qn

    drawing = run._r.find(qn('w:drawing'))
    inline = drawing.find(qn('wp:inline'))
    graphic = inline.find(qn('a:graphic'))
    doc_pr = inline.find(qn('wp:docPr'))
    inline.remove(graphic)
    inline.remove(doc_pr)
    drawing.remove(inline)

    from docx.oxml import OxmlElement

    anchor = OxmlElement('wp:anchor')
    anchor.set('behindDoc', '1')
    anchor.set('locked', '0')
    anchor.set('layoutInCell', '0')
    anchor.set('allowOverlap', '1')
    anchor.set('relativeHeight', '0')
    anchor.set('simplePos', '0')

    simple_pos = OxmlElement('wp:simplePos')
    simple_pos.set('x', '0')
    simple_pos.set('y', '0')
    anchor.append(simple_pos)

    position_h = OxmlElement('wp:positionH')
    position_h.set('relativeFrom', 'page')
    offset_h = OxmlElement('wp:posOffset')
    offset_h.text = '0'
    position_h.append(offset_h)
    anchor.append(position_h)

    position_v = OxmlElement('wp:positionV')
    position_v.set('relativeFrom', 'page')
    offset_v = OxmlElement('wp:posOffset')
    offset_v.text = '0'
    position_v.append(offset_v)
    anchor.append(position_v)

    extent = OxmlElement('wp:extent')
    extent.set('cx', str(width_emu))
    extent.set('cy', str(height_emu))
    anchor.append(extent)

    effect_extent = OxmlElement('wp:effectExtent')
    for side in ('l', 't', 'r', 'b'):
        effect_extent.set(side, '0')
    anchor.append(effect_extent)

    anchor.append(OxmlElement('wp:wrapNone'))
    anchor.append(doc_pr)
    anchor.append(graphic)

    drawing.append(anchor)


def _add_line_overlay_backgrounds(docx_path: str, input_path: str) -> None:
    """
    Drop each page's `_render_lines_only_png` behind the text pdf2docx
    already reconstructed - see `convert_to_docx`'s dense-vector-lines
    branch for why the text was reconstructed with table detection off in
    the first place, and this module's docstring-level notes above for the
    corruption that combination avoids.

    Assumes pdf2docx keeps its usual one-section-per-source-page pagination
    (true for the single-column reports this branch targets) and maps
    overlay images to sections by that order; a source with multi-column
    sections that split unevenly would misalign past the first mismatch,
    which is why this is gated behind `_pdf_has_dense_vector_lines` rather
    than applied unconditionally.
    """
    import fitz  # PyMuPDF
    from docx import Document
    from docx.shared import Emu

    dpi = 150
    zoom = dpi / 72.0
    matrix = fitz.Matrix(zoom, zoom)
    emu_per_point = 914400 / 72.0

    document = fitz.open(input_path)
    try:
        overlays = [_render_lines_only_png(page, matrix) for page in document]
        page_sizes = [(page.rect.width, page.rect.height) for page in document]
    finally:
        document.close()

    output = Document(docx_path)
    paragraphs = output.paragraphs

    section_starts = [0]
    for index, paragraph in enumerate(paragraphs):
        if _paragraph_ends_section(paragraph._p) and index + 1 < len(paragraphs):
            section_starts.append(index + 1)

    for page_index, start in enumerate(section_starts):
        if page_index >= len(overlays) or start >= len(paragraphs):
            break
        width_pt, height_pt = page_sizes[page_index]
        width_emu = Emu(int(round(width_pt * emu_per_point)))
        height_emu = Emu(int(round(height_pt * emu_per_point)))

        run = paragraphs[start].add_run()
        run.add_picture(io_bytes(overlays[page_index]), width=width_emu, height=height_emu)
        _float_picture_behind_text(run, int(width_emu), int(height_emu))

    output.save(docx_path)


def _paragraph_ends_section(paragraph_element) -> bool:
    """
    True if this `w:p` carries a section break - Word nests `w:sectPr`
    inside a paragraph's `w:pPr` to mark it as the LAST paragraph of a
    section, everywhere except the document's final section, whose
    `sectPr` sits on the body itself rather than on any paragraph.
    """
    from docx.oxml.ns import qn

    p_pr = paragraph_element.find(qn('w:pPr'))
    return p_pr is not None and p_pr.find(qn('w:sectPr')) is not None


# Wingdings (and the handful of other dingbat fonts below) doesn't map
# character codes to glyphs the normal way - it repurposes the Private Use
# Area, so "checkmark" is whatever glyph its own font happens to have
# sitting at U+F0FC. Word only renders that correctly because Windows ships
# actual Wingdings; without it (any Linux/Mac viewer, or a phone), whatever
# font a viewer substitutes shows THAT font's own unrelated glyph at the
# same PUA codepoint instead - confirmed directly on a real accessibility
# report where its checkmark/✗ table came out as "H" and an unrelated
# dingbat. The fix is to stop depending on Wingdings being present at all:
# translate its PUA codepoints to the real Unicode symbols they represent,
# in a font that actually has them everywhere (`_TYPE3_REPLACEMENT_FONTS`'s
# DejaVu Serif has all of these - checked directly).
#
# Not the full ~220-glyph Wingdings set, deliberately: this covers the
# checkmarks/crosses/boxes/bullets/arrows that actually show up in real
# business and accessibility documents. A codepoint this table doesn't
# recognise is left exactly as pdf2docx wrote it - still wrong on a machine
# without Wingdings, but no worse than before this function existed.
#
# One table PER FONT NAME, not one shared table: the same PUA codepoint
# means a different glyph in each symbol font (there is no shared
# standard - each font's author just picked their own private layout), so
# a mapping tuned against Wingdings is not just incomplete but WRONG for
# another font's own use of the same codepoint. Confirmed directly: 0xF06C
# is a black diamond in Wingdings, but the exact same codepoint is a plain
# round bullet in LibreOffice's OpenSymbol (found on a real CV's bullet
# list, which this was extended for after the Wingdings-only version
# missed it entirely).
_SYMBOL_FONT_MAPS = {
    'wingdings': {
        '': '✓',  # check mark
        '': '☒',  # ballot box with X
        '': '☐',  # ballot box (empty)
        '': '✗',  # ballot X
        '': '↑',  # arrow up
        '': '↓',  # arrow down
        '': '→',  # arrow right
        '': '←',  # arrow left
        '': '⇒',  # double arrow right
        '': '⇐',  # double arrow left
        '': '▪',  # small black square bullet
        '': '•',  # round bullet
        '': '♦',  # black diamond
        '': '⬛',  # black square
        '': '□',  # white square
        '': '★',  # black star
        '': '☎',  # telephone
        '': '✉',  # envelope
        '': '⌚',  # clock/watch
        '': '☺',  # smiling face
    },
    'opensymbol': {
        '': '•',  # round bullet
    },
}


def _try_postprocess_docx(docx_path: str) -> None:
    """
    Best-effort call site wrapper around every fix-up `convert_to_docx`
    applies to a `pdf2docx` output regardless of which branch produced it -
    a Wingdings table or a clipped table row has nothing to do with ruling
    lines, and both were found on PDFs that triggered neither the Type3 nor
    the dense-line path, only the ordinary one. One open/save rather than
    one per fix, since both work on the same already-open `Document`.
    """
    try:
        from docx import Document

        document = Document(docx_path)
        changed = _fix_symbol_fonts(document)
        changed = _fix_exact_row_heights(document) or changed
        if changed:
            document.save(docx_path)
    except Exception as error:  # noqa: BLE001 - cosmetic fixes; never fail the request over them
        print(f'docx post-processing failed, leaving pdf2docx output as-is: {error}', file=sys.stderr)


def _fix_exact_row_heights(document) -> bool:
    """
    Loosen every table row pdf2docx pinned to `EXACTLY` its source PDF
    row's height into `AT_LEAST` that height instead.

    `EXACTLY` is a hard clip, not a suggestion: if the text inside ends up
    taller than that (because a substitute font wraps a line the source
    PDF's own font fit on one line - confirmed directly on a real CV, one
    bullet whose row was pinned to a single line's height wrapped to two
    in DejaVu/Noto's own metrics), Word and LibreOffice both render the
    overflow past the row boundary rather than growing it, indistinguishable
    from the text having been silently dropped. `AT_LEAST` keeps pdf2docx's
    original height as a floor - so a row that never wraps looks identical
    to before - while letting a row that DOES wrap grow to fit, which is
    what every hand-built Word table already does by default.
    """
    from docx.enum.table import WD_ROW_HEIGHT_RULE

    changed = False
    for table in document.tables:
        for row in table.rows:
            if row.height_rule == WD_ROW_HEIGHT_RULE.EXACTLY:
                row.height_rule = WD_ROW_HEIGHT_RULE.AT_LEAST
                changed = True
    return changed


def _fix_symbol_fonts(document) -> bool:
    """
    Replace every character `_SYMBOL_FONT_MAPS` recognises for a run's own
    font, in every run whose font is one of `_SYMBOL_FONT_MAPS`'s keys,
    with its real Unicode symbol - and repoint that run at DejaVu Serif,
    which actually has these glyphs (checked directly) rather than
    Wingdings/OpenSymbol, which a reader without Windows/LibreOffice
    installed does not have at all. A run mixing recognised and
    unrecognised characters keeps its font either way: switching only the
    matched characters away from the symbol font and leaving the rest on
    it would be worse than doing nothing, not better.
    """
    changed = False

    for paragraph in document.paragraphs:
        changed = _fix_symbol_runs_in(paragraph) or changed
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                for paragraph in cell.paragraphs:
                    changed = _fix_symbol_runs_in(paragraph) or changed

    return changed


def _fix_symbol_runs_in(paragraph) -> bool:
    from docx.oxml.ns import qn

    changed = False
    for run in paragraph.runs:
        font_name = (run.font.name or '').strip().lower()
        symbol_map = _SYMBOL_FONT_MAPS.get(font_name)
        if symbol_map is None:
            continue
        if not any(ch in symbol_map for ch in run.text):
            continue
        run.text = ''.join(symbol_map.get(ch, ch) for ch in run.text)
        run.font.name = 'DejaVu Serif'
        r_pr = run._r.find(qn('w:rPr'))
        if r_pr is not None:
            r_fonts_el = r_pr.find(qn('w:rFonts'))
            if r_fonts_el is not None:
                for attr in ('w:ascii', 'w:hAnsi', 'w:eastAsia', 'w:cs'):
                    if r_fonts_el.get(qn(attr)) is not None:
                        r_fonts_el.set(qn(attr), 'DejaVu Serif')
        changed = True
    return changed


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
    reconstruction and hoping. The fallback rebuilds the PDF with real
    fonts in place of the Type3 glyphs (`_rebuild_pdf_without_type3_fonts`)
    and reruns this same function on THAT - a genuine fix, not a
    lesser-evil substitute: it keeps the page's actual text (no OCR
    misreads) and its ruling lines both, and lands back in the exact same
    dense-line-overlay path below that a normal, non-Type3 PDF gets. If
    that rebuild itself fails, this degrades to forcing OCR
    (`_force_ocr_pdf`) and reading the result back through pdf2docx's own
    `ocr=2` path - real recognised text, no embedded images, but no
    ruling lines either (that OCR pass flattens the whole page to one
    image first) and occasional misreads, which is why the rebuild above
    is tried first rather than this. If OCR also fails or is turned off,
    the last resort is `_convert_to_docx_as_pages`: a faithful picture of
    each page with no text at all, the same result this pipeline gave
    every Type3 PDF before either of the above existed.

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
        try:
            workspace = os.path.dirname(os.path.abspath(output_path)) or tempfile.gettempdir()
            rebuilt = _rebuild_pdf_without_type3_fonts(input_path, workspace)
            convert_to_docx(rebuilt, output_path, ocr)
            return
        except Exception as error:  # noqa: BLE001 - degrade, don't fail the request over this
            print(f'Type3 rebuild failed, falling back to OCR: {error}', file=sys.stderr)

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

    if _pdf_has_dense_vector_lines(working_input):
        # Table detection off: pdf2docx places text as plain paragraphs
        # instead of (mis)reading these same lines as table borders - see
        # `_pdf_has_dense_vector_lines`. The lines themselves aren't lost,
        # just handled separately: `_add_line_overlay_backgrounds` renders
        # them straight from the page's drawing ops and drops them in as a
        # per-page background image behind the reconstructed text.
        converter = Converter(working_input)
        try:
            converter.convert(
                output_path, parse_lattice_table=False, parse_stream_table=False, **ocr_settings
            )
        finally:
            converter.close()
        try:
            _add_line_overlay_backgrounds(output_path, working_input)
        except Exception as error:  # noqa: BLE001 - degrade to the plain reconstruction already saved above
            print(f'Line overlay failed, keeping plain text reconstruction: {error}', file=sys.stderr)
        _try_postprocess_docx(output_path)
        return

    converter = Converter(working_input)
    try:
        converter.convert(output_path, **ocr_settings)
    finally:
        converter.close()
    _try_postprocess_docx(output_path)


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


def _line_markdown(line: dict, body_size: float) -> str:
    """
    One fitz text line -> one line of Markdown, judged against `body_size`
    (this document's own median span size, computed once in
    `convert_to_markdown` - see its docstring for why a per-document baseline
    rather than an absolute point size).

    Bold, a bullet and a heading size are mutually exclusive in what they
    produce (a bold line under body size becomes `**text**`; a line at or
    above 1.1x body size becomes a heading instead, uninterested in whether
    it was also bold - most headings already are, so re-asserting it with
    `**` inside a `#` line would be redundant); a bullet/numbered-list match
    is checked only once nothing above claimed the line as a heading.
    """
    spans = [span for span in line['spans'] if span['text'].strip()]
    if not spans:
        return ''
    text = ''.join(span['text'] for span in spans).strip()
    if not text:
        return ''
    max_size = max(span['size'] for span in spans)
    # PyMuPDF span flags, bit 4 (value 16): bold. Documented at
    # https://pymupdf.readthedocs.io/en/latest/textpage.html#span-flags.
    is_bold = all(span['flags'] & 16 for span in spans)

    if max_size >= body_size * 1.5:
        return f'# {text}'
    if max_size >= body_size * 1.25:
        return f'## {text}'
    if max_size >= body_size * 1.1:
        return f'### {text}'

    bullet = re.match(r'^[••\-*]\s+(.*)', text)
    if bullet:
        return f'- {bullet.group(1)}'
    numbered = re.match(r'^(\d+)[.)]\s+(.*)', text)
    if numbered:
        return f'{numbered.group(1)}. {numbered.group(2)}'

    return f'**{text}**' if is_bold else text


def _block_markdown(block: dict, body_size: float) -> str:
    """One fitz text block (a paragraph, roughly) -> Markdown, line by line."""
    lines = [_line_markdown(line, body_size) for line in block['lines']]
    return '\n'.join(line for line in lines if line)


def _table_markdown(rows: list) -> str:
    """`pdfplumber` table rows -> a GFM table. The PDF-source twin of what
    `convert_to_xlsx` does with the same rows, rendered as text instead of a
    worksheet."""
    cleaned = [
        ['' if cell is None else str(cell).replace('\n', ' ').strip() for cell in row]
        for row in rows
    ]
    header, *body = cleaned
    lines = [
        '| ' + ' | '.join(header) + ' |',
        '| ' + ' | '.join('---' for _ in header) + ' |',
    ]
    lines.extend('| ' + ' | '.join(row) + ' |' for row in body)
    return '\n'.join(lines)


def convert_to_markdown(input_path: str, output_path: str) -> None:
    """
    The PDF's text and tables, as Markdown - headings, bullet/numbered lists
    and bold text recovered by heuristic, tables rendered as GFM tables, in
    each page's own reading order (text blocks and tables sorted together by
    vertical position, so a table does not get pulled out of the paragraph
    flow it sits inside).

    Headings are judged by font size RELATIVE TO THE DOCUMENT'S OWN median
    span size, not an absolute point size - a deck built entirely in 20pt
    text and a memo built in 10pt text should each get their own headings
    detected as "larger than this document's own body text", not against a
    fixed number that assumes one or the other is "normal". This is a
    heuristic, not a structural read of the PDF (a PDF has no heading
    elements to read - unlike `.docx`, whose `tables` extractor reads real
    structure out of the OOXML package, this is reconstructing structure
    from formatting, the same lossy category `convert_to_docx`'s image
    fallback is in for a PDF pdf2docx cannot parse as real paragraphs) and
    it will occasionally misjudge a large pull-quote as a heading or miss a
    heading set in body-sized text with color alone - accepted the same way
    `extractFrom`'s lines-based table detection accepts missing borderless
    tables.

    No E_NO_TABLES-style refusal for an empty result: unlike the `xlsx`
    operation (which promises tables specifically, so having none is worth
    its own error), a Markdown export of a genuinely blank or image-only PDF
    producing an empty (or near-empty) file is simply an honest answer, the
    same way `.docx -> txt` accepts a blank result.
    """
    import statistics

    import fitz
    import pdfplumber

    document = fitz.open(input_path)
    try:
        sizes = [
            round(span['size'])
            for page in document
            for block in page.get_text('dict')['blocks']
            if block['type'] == 0
            for line in block['lines']
            for span in line['spans']
            if span['text'].strip()
        ]
        body_size = statistics.median(sizes) if sizes else 12.0

        with pdfplumber.open(input_path) as plumber_pdf:
            pages_markdown = []
            for page_index in range(document.page_count):
                page = document[page_index]
                # (top-of-item y position, its Markdown) pairs, sorted at the
                # end so a table interleaves with the paragraphs around it
                # instead of always trailing the page's text.
                items: list[tuple[float, str]] = []

                for block in page.get_text('dict')['blocks']:
                    if block['type'] != 0:
                        continue
                    text = _block_markdown(block, body_size)
                    if text:
                        items.append((block['bbox'][1], text))

                for table in plumber_pdf.pages[page_index].find_tables():
                    rows = table.extract()
                    if rows and any(any(cell for cell in row) for row in rows):
                        items.append((table.bbox[1], _table_markdown(rows)))

                items.sort(key=lambda item: item[0])
                if items:
                    pages_markdown.append('\n\n'.join(text for _, text in items))

        markdown = '\n\n'.join(pages_markdown).strip()
    finally:
        document.close()

    with open(output_path, 'w', encoding='utf-8') as handle:
        handle.write(markdown + ('\n' if markdown else ''))


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
    'markdown': convert_to_markdown,
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
        print(
            f'usage: {sys.argv[0]} <docx|pptx|xlsx|markdown|ocr> <input.pdf> <output-path> [ocr|force]',
            file=sys.stderr,
        )
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
