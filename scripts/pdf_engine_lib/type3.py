"""
Detecting and working around Type3-font PDFs, which corrupt pdf2docx's
layout reconstruction - see `convert_to_docx` in `docx.py` for how the
functions here fit into the overall fallback chain.
"""
import os

from .lines import _is_ruling_line


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
