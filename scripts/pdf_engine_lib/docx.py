"""
The `docx` operation: reconstruct a PDF as an editable, reflowable Word
document, with the Type3/OCR/dense-line fallback chain `convert_to_docx`
documents below.
"""
import os
import sys
import tempfile

from .lines import _add_line_overlay_backgrounds, _pdf_has_dense_vector_lines
from .ocr import _force_ocr_pdf, _ocr_pdf, _pdf_has_no_extractable_text
from .symbols import _try_postprocess_docx
from .type3 import _pdf_uses_type3_fonts, _rebuild_pdf_without_type3_fonts


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
