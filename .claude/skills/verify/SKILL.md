---
name: verify
description: Run the backend's typecheck, build and tests and report which failures are environmental (missing binaries) versus real.
---
Run `npm run typecheck`, `npm run build`, `npm test`. Check which external tools exist (`which ffmpeg soffice pandoc 7z heif-convert`). Group failures: missing-binary vs assertion. Only the latter are code bugs. Report counts.
