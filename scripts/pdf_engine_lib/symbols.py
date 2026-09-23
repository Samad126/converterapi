"""
Post-processing fixes applied to every `pdf2docx` output regardless of which
`convert_to_docx` branch produced it - symbol-font glyph substitution and
loosening pinned row heights. See `_try_postprocess_docx`, the shared call
site `docx.py` uses.
"""
import sys

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
        '': '✓',  # check mark
        '': '☒',  # ballot box with X
        '': '☐',  # ballot box (empty)
        '': '✗',  # ballot X
        '': '↑',  # arrow up
        '': '↓',  # arrow down
        '': '→',  # arrow right
        '': '←',  # arrow left
        '': '⇒',  # double arrow right
        '': '⇐',  # double arrow left
        '': '▪',  # small black square bullet
        '': '•',  # round bullet
        '': '♦',  # black diamond
        '': '⬛',  # black square
        '': '□',  # white square
        '': '★',  # black star
        '': '☎',  # telephone
        '': '✉',  # envelope
        '': '⌚',  # clock/watch
        '': '☺',  # smiling face
    },
    'opensymbol': {
        '': '•',  # round bullet
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
