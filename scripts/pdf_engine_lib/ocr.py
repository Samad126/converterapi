"""
OCR detection and the two OCRmyPDF call shapes `docx.py` and `ops.py` use.
"""
import os

from .constants import OCR_LANGUAGES


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
