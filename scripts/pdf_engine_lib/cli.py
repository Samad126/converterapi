"""
Argument parsing and dispatch, matching what `pdf-engine.engine.ts` spawns:

    pdf_engine.py <docx|pptx|xlsx|markdown|ocr> <input.pdf> <output-path> [ocr|force]
    pdf_engine.py compare <inputA.pdf> <inputB.pdf> <output.json>
    pdf_engine.py redact <input.pdf> <areas.json> <output.pdf>

`ocr` (`true`/`false`, defaults to `true`) only affects the `docx` operation -
see `docx.convert_to_docx` and `ocr._pdf_has_no_extractable_text`. It is
accepted positionally for every operation regardless, so the caller does not
have to special-case which operation it is talking to. For the `ocr`
operation itself, the same positional slot instead means `force`
(`true`/`false`, defaults to `false`) - see `ops.run_ocr_operation`.

`compare` and `redact` are the two operations with a genuinely different
shape from "one PDF in, one PDF/OOXML file out": `compare` takes two PDFs in
and writes one JSON report; `redact` takes one PDF plus a path to a JSON file
describing the regions to strip, and writes one PDF. Both are special-cased
here before the generic argument parsing below, the same way NO_TABLES_EXIT_CODE
is a case the general flow does not cover. `redact` takes its `areas` as a
JSON FILE path rather than a raw JSON string on argv deliberately: an argv
string is subject to shell/exec argument length limits and escaping hazards a
long list of regions could realistically hit, where a file the caller already
wrote into the same per-request workspace has neither problem.

Exit codes:
    0  wrote the output
    1  failed - stderr has a human-unreadable but log-worthy reason
    2  xlsx only: the PDF has no detectable tables (E_NO_TABLES, not a failure)
"""
import sys

from .docx import convert_to_docx
from .markdown import convert_to_markdown
from .ops import run_compare_operation, run_ocr_operation, run_redact_operation
from .pptx import convert_to_pptx
from .xlsx import convert_to_xlsx

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
