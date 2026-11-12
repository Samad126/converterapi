---
name: add-format
description: Add a new file format (source and/or target) to the converter backend end to end, including verification, docs and frontend matrix sync.
---
1. Edit `src/formats.ts`: `TargetId`/`AllowedExtension` unions, the target or source entry, and the shared target lists (`TRANSCODE_TARGETS` etc.).
2. Verify with a real file using the engine's binary (see `.claude/rules/formats.md`). If the binary is missing, say it is unverified.
3. Update `test/unit/formats.test.ts` count, `openapi.yaml` supported-types message, docs/REFERENCE.md matrix.
4. `npm run typecheck && npm run build && npm test` (report env-related failures honestly).
5. In `../frontend`: `node scripts/gen-file-matrix.mjs`, add the extension to a category in `lib/files/fileCatalog.ts`, run `npm test`.
