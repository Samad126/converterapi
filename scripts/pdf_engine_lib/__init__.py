"""
The non-LibreOffice half of the PDF pipeline, split by responsibility.

See `../pdf_engine.py` for the CLI entrypoint and invocation contract this
package implements; that file is kept as a thin shim so
`pdf-engine.engine.ts`'s `spawnSync(PYTHON_BIN, [PDF_ENGINE_SCRIPT, ...])`
call needs no change.
"""
