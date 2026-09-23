"""The `markdown` operation: the PDF's text and tables, as GFM Markdown."""
import re


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
