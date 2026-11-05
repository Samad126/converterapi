---
paths:
  - "src/formats*.ts"
  - "src/engines/**"
  - "src/pipelines/**"
---
- A target/filter name must be verified by actually converting a real file; a wrong LibreOffice filter silently falls back to a default export.
- A source never lists itself as a target (`validateMatrix` backstop); keep explicit `.filter(id => id !== ...)` for same-format cases.
- Alternate spellings of a format (`.jpeg`, `.tif`) may list the canonical target, since that is a real normalisation.
- Update `test/unit/formats.test.ts` (extension count), `openapi.yaml` supported types, README table.
