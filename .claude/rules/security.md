---
paths:
  - "src/middleware/**"
  - "src/routes/**"
  - "src/engines/**"
---
- Write uploads as `<server-chosen-name>.<validated extension>`; never use client filenames or MIME for paths or decisions.
- Subprocesses run through `runProcess` (deadline, abort, process-group kill); do not spawn directly.
- Never log document contents or filenames; only request id, size, duration, outcome.
