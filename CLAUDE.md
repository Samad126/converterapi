# Converter API (backend)

Express 5 + TypeScript (run with `node --experimental-strip-types`), a file-conversion service that shells out to LibreOffice, ffmpeg, pandoc, 7z, heif-convert, yt-dlp, assimp, qpdf and Python engines. See README.md for the full matrix and env vars.

## Commands
- `./run.sh` / `./run.sh --watch` run from source; `npm run dev` also works
- `npm run typecheck`, `npm run build` (tsc -> dist/), `npm test`
- Many integration tests need the external binaries (ffmpeg, soffice, pandoc...). Missing binaries make those fail; that is environmental, so say so rather than "fixing" them.

## Architecture
- `src/formats.ts` is the single source of truth for what is accepted and what it can become. Router, upload filter, OpenAPI and `GET /formats` derive from it. Add formats there only.
- `src/engines/*` one subprocess wrapper per tool; `src/pipelines/` orchestration; `src/routes/` thin HTTP; `src/services/` business logic.
- The upload's file extension is the only trusted input; MIME is ignored.

## Rules
- No conversion filter/target is trusted until run against a real file (see `.claude/rules/formats.md`).
- Never log file contents or filenames.
- `dist/` and `.env` are not edited by hand (a hook blocks it).
- Frontend consumes this matrix: after changing `formats.ts`, rebuild and run `node scripts/gen-file-matrix.mjs` in `../frontend`.
- Commit only files you changed; the working tree has unrelated mode-only diffs, so use `git -c core.fileMode=false`.
