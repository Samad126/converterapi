#!/usr/bin/env python3
"""
The non-LibreOffice half of the PDF pipeline.

LibreOffice opens a PDF as a Draw document and Draw has no Writer/Calc/Impress
export filter - verified against the shipped LibreOffice 24.2 by running
`soffice --convert-to docx/pptx/xlsx` against a real PDF and watching it fail
with "no export filter found" every time. So the `word`, `slides` and `sheet`
targets in formats.ts do not go through soffice at all: they are run through
this script instead, one purpose-built engine per target.

This file is a thin CLI shim, kept at this exact path and name because
`pdf-engine.engine.ts` spawns it directly
(`spawnSync(PYTHON_BIN, [PDF_ENGINE_SCRIPT, ...])`, with `PDF_ENGINE_SCRIPT`
pointing at this file in `config.ts`). The actual engines live in
`pdf_engine_lib/`, split by responsibility (`docx.py`, `pptx.py`, `xlsx.py`,
`markdown.py`, `ops.py` for the standalone ocr/compare/redact operations,
plus the shared `type3.py`/`ocr.py`/`lines.py`/`symbols.py` helpers
`docx.py` composes) - see `pdf_engine_lib/cli.py` for the full invocation
contract and exit codes.

Each operation is independent and imports its own dependency, so a missing
package fails with a clear ModuleNotFoundError naming exactly what is missing,
rather than every operation going down if one dependency is absent.
"""
import sys

from pdf_engine_lib.cli import main

if __name__ == '__main__':
    sys.exit(main())
