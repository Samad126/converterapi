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

    pdf_engine.py <docx|pptx|xlsx> <input.pdf> <output-path>

Exit codes:
    0  wrote the output
    1  failed - stderr has a human-unreadable but log-worthy reason
    2  xlsx only: the PDF has no detectable tables (E_NO_TABLES, not a failure)

Each operation is independent and imports its own dependency, so a missing
package fails with a clear ModuleNotFoundError naming exactly what is missing,
rather than every operation going down if one dependency is absent.
"""
import sys

NO_TABLES_EXIT_CODE = 2


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


def convert_to_docx(input_path: str, output_path: str) -> None:
    """
    Reconstruct the PDF as an editable, reflowable Word document.

    pdf2docx (built on PyMuPDF) rebuilds each page's text runs, tables and
    images into real OOXML rather than dropping a picture of the page into a
    document - this is a genuine layout reconstruction, not a raster fallback,
    which is why it earns its own target (`word`) instead of piggybacking on
    the `docx` id that direct LibreOffice conversions use.

    Falls back to `_convert_to_docx_as_pages` for a PDF with Type3 fonts -
    see `_pdf_uses_type3_fonts` for why that specific trigger is checked
    rather than attempting the reconstruction and hoping.
    """
    if _pdf_uses_type3_fonts(input_path):
        _convert_to_docx_as_pages(input_path, output_path)
        return

    from pdf2docx import Converter

    converter = Converter(input_path)
    try:
        converter.convert(output_path)
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


OPERATIONS = {
    'docx': convert_to_docx,
    'pptx': convert_to_pptx,
    'xlsx': convert_to_xlsx,
}


def main() -> int:
    if len(sys.argv) != 4:
        print(f'usage: {sys.argv[0]} <docx|pptx|xlsx> <input.pdf> <output-path>', file=sys.stderr)
        return 1

    operation, input_path, output_path = sys.argv[1], sys.argv[2], sys.argv[3]
    handler = OPERATIONS.get(operation)
    if handler is None:
        print(f'unknown operation "{operation}", expected one of {sorted(OPERATIONS)}', file=sys.stderr)
        return 1

    try:
        handler(input_path, output_path)
    except SystemExit:
        raise
    except Exception as error:  # noqa: BLE001 - reported to stderr, not swallowed
        print(f'{operation} failed: {error}', file=sys.stderr)
        return 1

    return 0


if __name__ == '__main__':
    sys.exit(main())
