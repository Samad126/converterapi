# Contributing to the converter API

Thanks for helping out. This is the backend of the converter; the web client lives in a separate repo (`converterweb`).

## Setup

You need Node 22 or newer. Many conversions also need external tools (LibreOffice, ffmpeg, pandoc, 7z, qpdf, and others). The server checks every tool at boot and tells you which one is missing and how to install it. The easiest way to get all of them is the Docker image.

```bash
npm ci
./run.sh            # start from source
./run.sh --watch    # restart on changes
```

Settings come from the environment or a `.env` file. See "Environment variables" in the README.

## Before you open a pull request

```bash
npm run typecheck
npm test
```

Integration tests run real conversions, so they fail if a tool is not installed. That is a problem with your machine, not with your change. Say which tests you could not run in your pull request.

## Ground rules

- **Formats live in one place.** `src/formats.ts` decides what is accepted and what it can become. The router, upload filter, OpenAPI document and `GET /formats` all derive from it. Add or change formats there only.
- **Test a conversion against a real file** before adding it. A filter or target is not trusted until it has produced real output.
- **Do not change `POST /convert/{target}`** in a way that breaks existing clients. The shipped Android app depends on its exact behaviour (success is `200` with the target's media type, failure is a non-2xx with the JSON error envelope).
- **Never log file contents or filenames.** The uploaded filename is untrusted. The only thing trusted from an upload is its extension.
- **Keep deadlines in order.** The server's conversion deadline must stay shorter than the client's and the proxy's timeouts, or users see an unhelpful error instead of the server's message.
- Do not edit `dist/` or `.env` by hand.

## After changing `src/formats.ts`

The web client's format list is generated from this repo. Build, then regenerate it in the frontend repo:

```bash
npm run build
cd ../frontend && node scripts/gen-file-matrix.mjs
```

Commit that generated file in the frontend repo with your change.

## Commits

- Keep commits focused, and commit only files you changed.
- Use a short summary line, and explain why in the body when it is not obvious.
- Pushing to `master` deploys. There is no separate CI test run first, so run the checks above before you push.

## Reporting a security problem

Please do not open a public issue for a vulnerability. Contact the maintainer privately instead.

## License

By contributing, you agree that your contribution is licensed under the project's MIT license.
