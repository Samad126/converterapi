# Universal file converter

[![npm](https://img.shields.io/npm/v/any-file-converter)](https://www.npmjs.com/package/any-file-converter)
[![license](https://img.shields.io/npm/l/any-file-converter)](LICENSE)

Convert documents, spreadsheets, presentations, images, audio, video, ebooks,
archives, data files and PDFs from Node.js, the command line, or over HTTP.
Published on npm as [`any-file-converter`](https://www.npmjs.com/package/any-file-converter).

```bash
npx any-file-converter convert pdf report.docx    # CLI, no install
npm install any-file-converter                    # library
```

```js
import { convertFile } from 'any-file-converter';
const { files } = await convertFile('report.docx', { to: 'pdf' });
```

Conversions run on system tools (LibreOffice, pandoc, ffmpeg, qpdf, ...) that
npm cannot install. `npx any-file-converter doctor` shows what is missing, or
use the Docker image, which bundles everything.

## Run the HTTP API

```bash
docker compose up --build        # http://127.0.0.1:3010 (behind your reverse proxy)
# or from source
npm install && npm run build && npm start    # http://localhost:3001
```

```bash
curl -F "files=@report.docx" http://localhost:3001/convert/pdf -o report.pdf
```

Interactive API docs are served at `/docs`; the spec is [openapi.yaml](openapi.yaml).
`GET /formats` lists every accepted source and what it can become.

## Architecture

```
HTTP (Express 5) -> routes -> controllers -> pipelines -> engines -> subprocess
                      |            |
                 rate limit    bounded queue (N running, M waiting, then 503)
```

- `src/formats.ts` is the single source of truth for what converts to what; the
  router, upload filter, OpenAPI spec and `/formats` all derive from it.
- `src/engines/*` wraps one tool each (soffice, ffmpeg, pandoc, qpdf, ...);
  `src/pipelines/` orchestrates them; `src/routes/` stays thin.
- No database, no state. Each request gets a private workspace that is deleted
  afterwards, and a private LibreOffice profile so conversions can run
  concurrently.

## Design decisions worth knowing

- **Admission control instead of unbounded queuing.** Fixed concurrency, a short
  waiting room, then an immediate `503 E_BUSY`; per-IP rate limiting on top.
- **Metric-compatible fonts** (Carlito, Caladea, Liberation) are required, because
  font metrics decide pagination. The service refuses to boot without them.
- **The file extension is the only trusted input**; the declared MIME type is ignored.
- **LibreOffice exits 0 on failure**, so success means "a non-empty file with the
  right magic bytes", never the exit code.
- **Hardened container:** read-only root, non-root user, all capabilities dropped,
  custom seccomp profile, memory/CPU/PID caps, port published on loopback only.

## Capacity

Measured on the production image with its compose limits (2 CPUs, 3 GB,
2 concurrent conversions): about **2 Office conversions/s** (~120/min) and
about **0.35 PDF to Word conversions/s** (~21/min). CPU is the bottleneck; peak
memory was ~440 MB. Beyond the queue, requests get a fast `503`.

## Documentation

Everything else lives in [docs/REFERENCE.md](docs/REFERENCE.md): the full
conversion matrix, API reference, configuration and env vars, fonts, how each
pipeline works, security posture, deployment, and development notes. Also see
[deploy/SERVER-SETUP.md](deploy/SERVER-SETUP.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

```bash
npm run typecheck && npm test
```

Many integration tests need the external binaries; missing ones fail for
environmental reasons, not code reasons.

## License

MIT, see [LICENSE](LICENSE).
