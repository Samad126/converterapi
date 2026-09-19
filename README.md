# Word → PDF converter

A minimal Node.js service that converts Word documents to PDF using LibreOffice
headless. It is the backend for an Android app that uploads a document and
receives a PDF.

Two endpoints, no database, no state. The interesting parts are the things that
are easy to get subtly wrong: **font metrics** (which decide pagination),
**per-process LibreOffice profiles** (which decide whether concurrent
conversions work at all), and the **error contract** with a client that is
already shipped and cannot be changed.

---

## Contents

- [Quick start](#quick-start)
- [API](#api)
  - [POST /convert](#post-convert)
  - [GET /health](#get-health)
  - [Error reference](#error-reference)
  - [Wire-compatibility constraints](#wire-compatibility-constraints)
- [API documentation (OpenAPI)](#api-documentation-openapi)
- [Fonts, and why they are not optional](#fonts-and-why-they-are-not-optional)
- [How conversion works](#how-conversion-works)
- [Concurrency model](#concurrency-model)
- [Cleanup and temp files](#cleanup-and-temp-files)
- [Operational limits](#operational-limits)
- [Configuration](#configuration)
- [Security posture](#security-posture)
- [Deployment](#deployment)
- [Development](#development)
- [Notes from building this](#notes-from-building-this)

---

## Quick start

```bash
npm install
npm run build
npm start          # http://localhost:3001
```

The service **refuses to boot** if LibreOffice is missing or the
metric-compatible fonts are not installed — see [Fonts](#fonts-and-why-they-are-not-optional).
On a bare Debian/Ubuntu box:

```bash
sudo apt-get install -y libreoffice-writer \
  fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation fontconfig
sudo fc-cache -f
```

Or just use Docker, which installs all of it:

```bash
docker compose up -d --build
curl -sS http://localhost:3010/health      # {"status":"ok"}
```

`-d` matters: `docker compose up` in the foreground stops both the container and
the service when you press Ctrl+C, and `restart: unless-stopped` deliberately
will not bring back a container you stopped yourself. If a URL that worked
suddenly stops answering, `docker compose ps` distinguishes "broken" from "not
running" in one line.

---

## API

### POST /convert

`multipart/form-data` with exactly one file part named `file`.

```bash
curl -F "file=@report.docx;type=application/octet-stream" \
     https://converter.example.com/convert \
     -o report.pdf
```

The import filter is chosen from the **filename extension**, not the declared
MIME type — the client deliberately sends `application/octet-stream`, and a
hostile client could declare anything at all. Accepted: `.docx`, `.docm`, `.doc`
(case-insensitive).

**Success** — `200`, `Content-Type: application/pdf`, body is the PDF bytes.

**Failure** — `4xx`/`5xx`, `Content-Type: application/json`:

```json
{"error": {"code": "E_CONVERT_FAILED", "message": "This document could not be converted. It may be damaged or in a format the converter does not support."}}
```

`message` is shown **verbatim** in a dialog on the phone, so it is written for a
person: a complete sentence, no stack traces, no paths, no codes. `code` is for
logs and metrics only — the client never shows it.

### GET /health

Returns `200 {"status":"ok"}`. The service only starts listening after
LibreOffice has been confirmed on `PATH`, so reaching this endpoint at all is
the confirmation.

### Error reference

| Status | Code | Message (shown verbatim to the user) |
|---|---|---|
| `200` | — | *(the PDF)* |
| `500` | `E_CONVERT_FAILED` | This document could not be converted. It may be damaged or in a format the converter does not support. |
| `504` | `E_TIMEOUT` | This document took too long to convert. |
| `422` | `E_ENCRYPTED` | This document is password protected. |
| `415` | `E_UNSUPPORTED` | Only Word documents (.docx, .docm, .doc) can be converted. |
| `413` | `E_TOO_LARGE` | This document is too large to convert. |
| `503` | `E_BUSY` | The converter is busy. Try again in a moment. |
| `400` | `E_BAD_REQUEST` | The document could not be received. Please try again. |
| `429` | `E_RATE_LIMITED` | Too many requests. Try again in a moment. |
| `500` | `E_INTERNAL` | Something went wrong on the server. |
| `404` | `E_BAD_REQUEST` | The converter is not available at this address. Please update the app and try again. |

The last three are additions, not part of the original contract: a request with
no file part, a per-IP rate limit, and an unrecognised path. They are additive
and cannot break a shipped client, which falls back to `HTTP <status>` for
anything it does not recognise.

### Wire-compatibility constraints

A shipped Android client depends on each of these. They are not style choices.

1. **Success is `Content-Type: application/pdf`.** The client checks it and
   refuses anything else, so a stray `text/html` on a `200` is a client-visible
   failure.
2. **A non-2xx carries the JSON envelope.** The client reads `error.message` for
   its dialog and falls back to `"HTTP <status>"` when it is absent or not JSON.
   Express's and multer's default HTML error pages violate this, so every error
   path is funnelled through one handler.
3. **A failure is never a `200` with an error body.** The client checks the
   status *before* it reads anything, so a `200` is treated as a PDF and fails
   much further downstream.
4. **The server's deadline (90s) is shorter than the client's abort (120s)**, so
   the server can still answer with a proper error instead of being killed
   mid-conversion.
5. **The 25 MB body limit agrees with the client's `MAX_UPLOAD_BYTES`.** It is a
   named constant in [`src/config.ts`](src/config.ts), not a literal, and it is
   mirrored by the reverse proxy so an oversized upload is refused before it
   reaches Node. Express's default overflow response is an HTML page; that is
   overridden to return the envelope too.

---

## API documentation (OpenAPI)

The contract is described in [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1) and
served by the running service:

| Path | Returns |
|---|---|
| `GET /openapi.json` | The document as JSON |
| `GET /openapi.yaml` | The raw file, comments and all |
| `GET /docs` | Swagger UI, reading `/openapi.json` |

```bash
curl -sS localhost:3001/openapi.json | jq '.paths | keys'
open http://localhost:3001/docs
```

The document covers every status the service can return, each with the **exact
sentence the user will see** — so it doubles as the source for the client's
dialog copy. It describes only the endpoints the Android client uses; the docs
routes above are infrastructure and are deliberately not self-described.

Set `ENABLE_DOCS=0` to turn all three off.

Swagger UI is loaded from jsdelivr **by the browser**, not by the container, so
this works despite the service having no network egress. `/docs` is served with
a restrictive `Content-Security-Policy` (`default-src 'none'`), relaxed only
enough for Swagger UI's own bootstrap to run.

### Keeping it honest

The obvious failure mode of a hand-written spec is drift — it describes a
service that no longer exists, and a client generated from it fails in ways the
document said were impossible. [`test/openapi.test.ts`](test/openapi.test.ts)
exists to prevent that, and it is not a formality. It checks:

- every error code the service can produce appears in the document's
  `ErrorCode` enum, **and** that every documented code is one some code path
  actually produces (both directions, so neither an added error nor a deleted
  one slips through);
- every example message in the document is byte-for-byte a message
  `src/errors.ts` produces — this is the assertion that protects the user-facing
  copy;
- `x-max-upload-bytes` equals `MAX_UPLOAD_BYTES`;
- every response the endpoints *actually return* is one the document says is
  possible, checked by exercising them against real conversions.

So: **change a message in `src/errors.ts` and `openapi.yaml` in the same
commit.** If you do not, the build fails and tells you which one is wrong.

---

## Fonts, and why they are not optional

**This is the requirement most likely to be skipped, because skipping it
produces no error at all.**

Calibri and Cambria are Microsoft fonts. They do not exist on Linux. When
LibreOffice is asked to lay out a document that uses them, it substitutes
whatever fontconfig offers — and the substitute has **different glyph widths**.

The document still converts. The PDF still opens. It looks correct. But every
line breaks in a slightly different place, so the page breaks land differently
than they do in Word. A three-page letter becomes four pages. A table spills
onto a second page. Nobody notices until a customer does.

The fix is metric-compatible substitutes — fonts that are *not* the Microsoft
originals but have been built to the same metrics, so text occupies the same
space and the layout is identical:

| Word asks for | Resolved to | Package |
|---|---|---|
| Calibri | **Carlito** | `fonts-crosextra-carlito` |
| Cambria | **Caladea** | `fonts-crosextra-caladea` |
| Arial | **Liberation Sans** | `fonts-liberation` |
| Times New Roman | **Liberation Serif** | `fonts-liberation` |
| Courier New | **Liberation Mono** | `fonts-liberation` |

### Why not `ttf-mscorefonts-installer`?

It ships the genuine Microsoft fonts, but it requires **interactive EULA
acceptance** during install, which breaks unattended image builds — exactly the
kind of thing that works on your machine and hangs in CI. It is also a
redistribution of fonts whose licensing is not designed for container images.
The metric-compatible set above is a drop-in replacement for the property that
actually matters here, which is *the metrics*, not the letterforms.

### The startup check

Because both failure modes are silent, the service checks for them at boot and
**refuses to start** if they are not satisfied:

```
Refusing to start: the metric-compatible font set is not installed.

  Calibri          resolved to "Noto Sans", expected Carlito  (fonts-crosextra-carlito)
  Cambria          resolved to "Noto Serif", expected Caladea  (fonts-crosextra-caladea)
...
```

It uses `fc-match`, which resolves the fontconfig alias chain — so a correct
answer proves **both** that the font is installed **and** that the alias exists,
which are the two conditions that have to hold together. A missing `soffice`
binary is refused the same way.

After preflight, the service performs one **warm-up conversion** of a small
built-in document. Preflight proves LibreOffice runs and the fonts resolve; it
does not prove the two work together to produce a PDF. The warm-up does, and it
also pays the one-off cost of first-run profile creation at boot rather than
inside some unlucky user's first request.

To verify by hand:

```bash
fc-match Calibri     # want: Carlito
fc-match Cambria     # want: Caladea
```

---

## How conversion works

LibreOffice is invoked as a subprocess:

```
soffice --headless --norestore --invisible --nolockcheck --nodefault --nofirststartwizard \
  -env:UserInstallation=file:///<tmpdir>/lo-profile \
  --convert-to pdf:writer_pdf_Export --outdir <tmpdir> <input>
```

No npm library is involved. No library paginates `.docx` correctly — that is a
layout engine, not a file-format problem — and routing through HTML (Puppeteer
or similar) moves the fidelity problem to the server instead of solving it.

### The two things that are easy to get wrong

**1. A per-request LibreOffice profile.** Every invocation needs its own
`-env:UserInstallation`. Without it, concurrent `soffice` processes collide over
the shared profile directory and conversions fail or hang *intermittently* —
which is the single most common cause of "works on my machine" in a service
like this. Each request gets its own profile directory inside its own temp dir.

**2. The metric-compatible fonts.** Covered [above](#fonts-and-why-they-are-not-optional).

### Details that matter

- **The client's filename never touches the filesystem.** The upload is written
  to a server-generated `input.<validated extension>` inside a per-request temp
  dir. The original name is read only to derive the extension. A filename like
  `../../etc/cron.d/x.docx` is a path traversal waiting to happen and there is
  no reason to take the risk.
- **`HOME` and `TMPDIR` are pointed at the request's temp dir**, so nothing
  writes into a real home directory.
- **Never runs as root.** The service refuses to boot as `uid 0`, since the
  document parser is the entire attack surface and running it as root turns any
  bug in it into a total compromise.
- **On timeout: SIGTERM, then SIGKILL** after a 5s grace period. Both target the
  whole *process group*, so helpers LibreOffice forked are not left holding the
  CPU.
- **The exit code is not trusted.** `--convert-to` **exits 0 even when it
  fails** — a corrupt document prints `Error: source file could not be loaded`
  and still returns status 0. The only trustworthy signal is whether a non-empty
  file that actually starts with `%PDF-` appeared in the output directory.

### Password-protected documents

Encrypted documents are detected *before* LibreOffice runs, because LibreOffice
reports an encrypted document exactly the way it reports a corrupt one — and
telling a user their file is damaged when it merely needs a password is both
wrong and unhelpful.

ECMA-376 encryption wraps the package in an OLE/CFB container holding an
`EncryptedPackage` stream, so an encrypted `.docx` stops being a ZIP. Legacy
`.doc` files are CFB either way and set `fEncrypted` (or `fObfuscated`) in the
FIB. Both are checked by a small CFB reader in
[`src/convert.ts`](src/convert.ts). It is best-effort by design: anything it
cannot parse confidently falls through to LibreOffice, because a false negative
costs a less specific error message while a false positive would reject a
document that could have been converted.

---

## Concurrency model

`soffice` converts one document per process and is CPU- and memory-heavy, so the
useful thing to bound is not "how many requests arrive" but "how many
conversions run at once". Past that bound, extra work does not go faster — it
makes every request slower and eventually pushes all of them past the client's
120s abort, which turns a busy server into a server that looks broken.

So [`src/queue.ts`](src/queue.ts) implements a bounded queue:

- **2 conversions run concurrently by default** (`MAX_CONCURRENT_CONVERSIONS`).
- **8 may wait** (`MAX_QUEUED_CONVERSIONS`).
- **Beyond that: `503 E_BUSY`, immediately.** A prompt "try again in a moment" is
  a far better answer than a request that hangs for two minutes and then dies.

The queue is checked *before* the body is read, so a client is told the
converter is busy rather than spending a minute uploading 25 MB to find out. A
request whose client disconnects while it is still queued is removed from the
queue rather than being handed a slot nobody wants.

Resource limits belong on the container, not in Node: see
[Operational limits](#operational-limits).

---

## Cleanup and temp files

Each request gets its own temp directory holding the input, that request's
LibreOffice profile, and the output. It is deleted on **every** path:

- **success** — before the response is written, so the space is reclaimed the
  moment the client has its file;
- **conversion failure, timeout, bad request** — in the error handler, also
  before the response;
- **client disconnect** — the running `soffice` is killed and the workspace
  removed;
- **paths that never reach the handler** (multer rejecting an oversized or
  wrong-extension upload) — via a `res.on('close')` net, which runs on every
  request without exception.

Three layers, because the failure mode they prevent — a disk that slowly fills
until the service dies — is invisible until it is fatal.

> **A note on `req.on('close')`.** Listening for that event alone is a common
> and wrong way to detect a client disconnect: it also fires the moment the
> request body has been *fully read*, which for a small upload is before the
> conversion has even started. Used naively it aborts every successful request.
> This service guards it with `req.complete` (the body was still arriving when
> the socket died) and pairs it with `res.on('close')` +
> `!res.writableFinished`, which is the general case.

**Stale workspaces** left by a crash are swept on startup and every 5 minutes.
Only directories older than 15 minutes are touched, which is comfortably longer
than the 90s conversion deadline, so a slow-but-alive conversion is never swept
out from under itself. The age is re-checked immediately before each delete, so
a workspace touched between the check and the delete is left alone.

---

## Operational limits

| Limit | Value | Where |
|---|---|---|
| Max upload | 25 MB | `MAX_UPLOAD_BYTES` (must equal the client's) + proxy `request_body max_size` |
| Conversion deadline | 90s | `CONVERT_TIMEOUT_MS` (client aborts at 120s) |
| SIGKILL grace | 5s | `SIGKILL_GRACE_MS` |
| Concurrent conversions | 2 | `MAX_CONCURRENT_CONVERSIONS` |
| Queued conversions | 8 | `MAX_QUEUED_CONVERSIONS` |
| Requests per IP | 30 / min | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |
| Stale sweep | every 5 min | `SWEEP_INTERVAL_MS` |
| Stale age | 15 min | `STALE_WORKSPACE_MS` |
| Container memory | 1 GB | `docker-compose.yml` |
| Container CPUs | 2 | `docker-compose.yml` |
| Container PIDs | 256 | `docker-compose.yml` |
| tmpfs for workspaces | 1 GB | `docker-compose.yml` |

**Sizing note.** `MAX_CONCURRENT_CONVERSIONS × typical soffice memory` must stay
under the container's `mem_limit`, or the kernel OOM-kills `soffice` mid-run and
every request becomes a `500`. LibreOffice peaks in the low hundreds of MB for
ordinary documents and considerably more for image-heavy ones; 2 concurrent
under a 1 GB cap is a deliberately conservative starting point. Raise both
together, not one.

**Logging.** One JSON line per request: request id, outcome, status, code, byte
size and duration. **Document contents and filenames are never logged.** The
`X-Request-Id` response header ties a client report to a server log line.

---

## Configuration

All configuration is environment variables read in
[`src/config.ts`](src/config.ts).

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3001` | |
| `HOST` | `0.0.0.0` | |
| `TEMP_ROOT` | `$TMPDIR/file-converter` | Must be writable; should be a tmpfs |
| `SOFFICE_BIN` | `soffice` | If not on `PATH` |
| `MAX_CONCURRENT_CONVERSIONS` | `2` | |
| `MAX_QUEUED_CONVERSIONS` | `8` | `0` disables queueing entirely |
| `CONVERT_TIMEOUT_MS` | `90000` | Must stay below the client's 120s |
| `SIGKILL_GRACE_MS` | `5000` | |
| `STALE_WORKSPACE_MS` | `900000` | Must stay above `CONVERT_TIMEOUT_MS` |
| `SWEEP_INTERVAL_MS` | `300000` | |
| `RATE_LIMIT_MAX` | `30` | Per IP, per window |
| `RATE_LIMIT_WINDOW_MS` | `60000` | |
| `TRUST_PROXY` | `loopback` | `1` = one proxy hop; see below |
| `SKIP_WARMUP` | unset | `1` skips the boot-time warm-up conversion |
| `ENABLE_DOCS` | on | `0` disables `/docs`, `/openapi.json`, `/openapi.yaml` |

`TRUST_PROXY` deserves care. `req.ip` is only the client's address if the
service believes the proxy's forwarding header. Behind a single reverse proxy
set it to `1` (one hop). Numeric values are passed to Express as numbers —
the string `"1"` would otherwise be read as the IP address `1`.

---

## Security posture

Stated plainly, because the honest description is more useful than a reassuring
one.

**The attack surface is document parsing, and it is fully exposed.** This
endpoint parses untrusted documents from the public internet. LibreOffice is a
large C++ codebase with a long history of memory-safety bugs in exactly the
import filters this service exercises. **Treat a conversion failure as an
expected, normal event, not an incident** — and assume that a sufficiently
determined attacker can eventually find a way to run code inside the container.

The design assumption is therefore *not* "the parser is safe" but "the parser
will be compromised, and it should be worth very little":

- **Unprivileged.** Runs as uid 1000; refuses to boot as root.
- **No capabilities.** `cap_drop: ALL`, `no-new-privileges`.
- **Read-only root filesystem.** `/tmp` is the only writable path, and it is a
  size-capped tmpfs.
- **Seccomp.** Docker's default profile, tightened with additional denials for
  `ptrace`, `process_vm_readv/writev`, `userfaultfd`, `io_uring_*`, `bpf`,
  `perf_event_open`, kernel module and mount syscalls, and the kernel keyring —
  none of which a headless document converter needs. Generated reproducibly by
  [`deploy/make-seccomp.mjs`](deploy/make-seccomp.mjs) from the upstream default.
- **Loopback-only binding.** Published on `127.0.0.1` only, so the container is
  reachable by a proxy on this host and by nothing else — not the LAN, not the
  internet.
- **Memory and PID caps**, so a pathological document degrades one container
  rather than the host.
- **No network egress** — *given up by the default compose file, deliberately.*
  Publishing a port and an `internal: true` network are mutually exclusive, and
  a host-side proxy needs the port. See [Network
  egress](#network-egress) for the two ways to get the property back. The
  service itself is unchanged either way; this is a deployment choice.

**The endpoint is unauthenticated, and it cannot be otherwise.** The client is
an APK; any secret shipped inside it is public. There is no credential that
would not also be available to anyone who downloads the app. So instead of
pretending otherwise:

- **Rate-limit by IP** (30 requests/minute by default).
- **Cap concurrent jobs**, and shed load with `503` rather than queueing
  without bound.
- **Assume abuse.** The limits above are sized for that assumption.

**TLS terminates at a reverse proxy** in front of the service — the client uses
`https://` and the app speaks plain HTTP, bound to loopback. The proxy's body
limit is set to match the application's 25 MB so a large upload is rejected
before it reaches Node at all. Note that the proxy is also where you would add
anything stronger than per-IP limiting (a WAF, a proof-of-work challenge, an
allowlist) if this ever attracts real attention.

A word on `TRUST_PROXY`. The app believes `X-Forwarded-For` because your proxy
sets it, which is what makes per-IP rate limiting work at all. That trust is
only safe while the app is bound to loopback: if it were ever published on
`0.0.0.0`, a direct client could forge the header and give itself a fresh rate
limit bucket per request. The loopback binding and `TRUST_PROXY` are one
decision, not two.

**What is deliberately not logged:** document contents and filenames. Request
id, byte size, duration and outcome only. Documents uploaded here are the user's
private files and there is no operational reason to retain them.

**Known limitations, stated rather than glossed over:**

- Rate limiting is in-memory and per-process. Behind more than one replica it
  becomes per-replica, and it resets on restart. Move it to the proxy or a
  shared store if you scale out.
- The rate limiter is a fixed window, which allows a burst at a window boundary.
  Adequate for load shedding; not a defence against a determined attacker.
- A hostile document can still consume a full conversion slot for up to 90s.
  The concurrency cap bounds the damage but does not prevent it.

---

## Deployment

`docker-compose.yml` runs the **converter only**. It expects a reverse proxy in
front of it — nginx on the host, in the common case — which terminates TLS and
applies the matching request body limit.

```bash
docker compose up -d --build
curl -sS http://localhost:3010/health      # {"status":"ok"}
```

### Continuous deployment

Pushing to `master` deploys. [`github/workflows/deploy.yml`](.github/workflows/deploy.yml)
SSHes into the server, pulls, rebuilds the `converter` service, and then polls
`/health` until it answers — because `docker compose up -d` reports success for
a container that is about to crashloop, and the health check is what tells the
two apart.

Setting the server up the first time is manual and is covered step by step in
[`deploy/SERVER-SETUP.md`](deploy/SERVER-SETUP.md): DNS, the one-time clone, the
first build watched by hand, and the nginx site — which reuses the existing
`*.alakbaroff.com` wildcard certificate rather than issuing a new one.

Both need three repo secrets: `SSH_HOST`, `SSH_USER`, `SSH_PASSWORD`.

The converter publishes on **loopback only** (`127.0.0.1:3010`), so it is
reachable by a proxy running on this host and by nothing else — not the LAN,
not the internet. Keep that prefix: dropping it would expose an unauthenticated
endpoint that parses untrusted documents to your whole network. Keep the port
too: 3000 and 3001 are what the other services on this host use.

### With nginx (the common case)

[`deploy/nginx.conf.example`](deploy/nginx.conf.example) is a working server
block. The parts that matter:

- `client_max_body_size 25m` — **must match `MAX_UPLOAD_BYTES`**, so an
  oversized upload is refused before it reaches Node. Two halves of one number.
- `proxy_read_timeout 120s` — the app's deadline is 90s and the client gives up
  at 120s; neither helps if nginx cuts the connection first.
- `error_page 413` rewritten into the JSON envelope, because the client reads
  its dialog text from `error.message` and would otherwise show a bare
  `HTTP 413`.

Point `proxy_pass` at `http://127.0.0.1:3010`.

### With the bundled Caddy (if you have no proxy already)

Caddy is behind an opt-in profile, and is **off by default** — it binds host
ports 80 and 443, which on a server already running nginx means Caddy fails to
start and takes the deployment with it.

```bash
DOMAIN=converter.example.com docker compose --profile proxy up -d --build
```

Set `DOMAIN` to the hostname the APK uses and Caddy provisions Let's Encrypt
TLS automatically.

> **Migrating an existing stack:** switching the proxy into a profile leaves any
> already-created proxy container as an *orphan*, which `docker compose down`
> will no longer remove — and which keeps holding the network. Use
> `docker compose down --remove-orphans`.

### Network egress

**This is a deliberate trade-off, and it is worth understanding.**

The converter parses untrusted documents, so the design assumption is that the
parser can eventually be compromised — and the question is what that is worth to
an attacker. One of the properties that keeps the answer "very little" is that
the container cannot reach the internet, so code that manages to execute has
nowhere to send anything.

Publishing a port gives that up, because **the two are mutually exclusive on a
single Docker network.** An `internal: true` network has no route in or out, so
`ports:` silently stops working: the container starts, looks correct in
`docker ps`, and the host gets connection refused. There is no error anywhere to
tell you. Since a host-side proxy has to reach the container, the published port
wins and the network stays a plain bridge.

If you want the property back, you have two options.

**1. Keep the network internal and let nginx reach the container by IP.** The
host *can* route to a container on an internal network even though port
publishing does not work, so this keeps both properties:

```yaml
services:
  converter:
    # no `ports:` at all
    networks:
      backend:
        ipv4_address: 172.31.240.10

networks:
  backend:
    internal: true
    ipam:
      config:
        - subnet: 172.31.240.0/24
```

then `proxy_pass http://172.31.240.10:3001;` in nginx. Pick a subnet that does
not collide with anything on your host, and note that the address is now fixed.

**2. Block egress with a `DOCKER-USER` rule**, leaving the published port alone:

```bash
# Substitute the bridge subnet of the compose network.
iptables -I DOCKER-USER -s 172.18.0.0/16 -m conntrack \
  --ctstate NEW -j DROP
```

Docker evaluates `DOCKER-USER` before its own forwarding rules, so this survives
container restarts. It is host-specific, which is why it is not baked into the
compose file.

Doing neither is a reasonable choice too — plenty of deployments accept it — but
make it a choice.

### Verifying a deployment

```bash
curl -sS https://converter.example.com/health
curl -sS -F "file=@report.docx" https://converter.example.com/convert -o out.pdf
head -c 5 out.pdf        # %PDF-
```

And confirm the fonts actually resolved on the running host — this is the check
that silently passes while producing wrong pagination:

```bash
docker compose exec converter sh -c '
  for f in Calibri Cambria Arial "Times New Roman"; do
    printf "%s -> %s\n" "$f" "$(fc-match -f "%{family}" "$f")"
  done'
# Calibri -> Carlito
# Cambria -> Caladea
# Arial -> Liberation Sans
# Times New Roman -> Liberation Serif
```

---

## Development

```bash
npm install
npm run typecheck
npm test
```

The test suite is `node:test` — no test framework dependency.

| File | Covers |
|---|---|
| [`test/integration.test.ts`](test/integration.test.ts) | The real HTTP contract against real conversions: a valid `.docx` returning `%PDF-`, oversized input, wrong extension, malformed file, encrypted file, empty file, cleanup, and cancellation. |
| [`test/unit.test.ts`](test/unit.test.ts) | Queue bounds and `E_BUSY`, the rate limiter, encryption detection, workspace sweeping, and the exact user-facing strings. |
| [`test/timeout.test.ts`](test/timeout.test.ts) | The 90s deadline, in a child process so `CONVERT_TIMEOUT_MS` can be overridden. |
| [`test/preflight.test.ts`](test/preflight.test.ts) | The boot refusal, by starting the real entry point with a broken environment — a missing `soffice`, and an unresolvable `fc-match`. |
| [`test/openapi.test.ts`](test/openapi.test.ts) | That [`openapi.yaml`](openapi.yaml) still describes this service: codes, exact messages, upload limit, and the responses the endpoints really return. |
| [`test/fixtures.ts`](test/fixtures.ts) | Binary fixtures built in code — including hand-built OLE/CFB containers, since there is no way to produce a password-protected document without a copy of Word or a checked-in blob. |

The suite needs a working `soffice` but **not** the fonts: the tests exercise
the HTTP contract, which holds either way, so they run through `createApp()`
rather than `startServer()` and skip preflight.

---

## Notes from building this

Four things that were true and surprising, recorded because they are the kind of
detail that is expensive to rediscover.

**`--convert-to` exits 0 when it fails.** A corrupt document prints
`Error: source file could not be loaded` and returns status **0**. Checking the
exit code alone gives you a service that reports success while producing
nothing. The only trustworthy signal is a non-empty file that starts with
`%PDF-`.

**LibreOffice sniffs content, so the extension is a filter *hint*, not a
guarantee.** A plain text file renamed to `.docx` converts perfectly happily —
it is imported as Writer text and exported as a PDF. Two consequences: a
"malformed document" test has to use bytes that actually fail the import filter
(this suite uses a ZIP header followed by garbage), and the extension check is
about *routing*, not about validating that the content matches.

**A zero-byte upload produces a valid blank PDF.** LibreOffice opens an empty
file as an empty document and exports one page. Without an explicit check this
is a `200` carrying a document the user never had, so empty uploads are rejected
before conversion.

**Type stripping rejects constructor parameter properties.** Running `.ts`
directly through Node's `--experimental-strip-types` is dependency-free and
fast, but it is strip-only: `constructor(private readonly x: number)` is a syntax
error. It also does not rewrite import specifiers, so imports use `.ts`
extensions and `tsc` rewrites them to `.js` for the build
(`rewriteRelativeImportExtensions`).
