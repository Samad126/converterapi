/**
 * The entrypoint: boot, then hand over to the app.
 *
 * The boot sequence is ordered so that failure is obvious and early. Preflight
 * and warm-up both run BEFORE the listener opens, so a machine that cannot
 * produce correct output never accepts a request at all - it exits non-zero
 * with an explanation instead. Both of those failures are invisible at runtime:
 * they show up as 500s or, much worse, as files that look fine and are subtly
 * wrong.
 */
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';

import { createApp } from './app.ts';
import { HOST, PORT, SKIP_WARMUP, SWEEP_INTERVAL_MS } from './config.ts';
import { PreflightError } from './errors.ts';
import { preflight, warmUp } from './services/preflight.service.ts';
import { sweepStaleWorkspaces } from './services/workspace.service.ts';

export interface StartedServer {
  server: Server;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(port = PORT): Promise<StartedServer> {
  const report = await preflight();
  console.log(
    JSON.stringify({
      outcome: 'preflight_ok',
      soffice: report.sofficeVersion,
      rasterizer: report.rasterizerVersion,
      pandoc: report.pandocVersion,
      sevenZip: report.sevenZipVersion,
      fonts: report.fonts.length,
      ocrAvailable: report.ocrAvailable,
    }),
  );

  if (!SKIP_WARMUP) {
    const warmed = await warmUp();
    console.log(JSON.stringify({ outcome: 'warmup_ok', conversions: warmed.cases }));
  }

  // Sweep what a previous crash left behind, then keep sweeping.
  const swept = await sweepStaleWorkspaces();
  if (swept > 0) console.log(JSON.stringify({ outcome: 'swept_stale_workspaces', count: swept }));
  const sweepTimer = setInterval(() => {
    void sweepStaleWorkspaces().then((count) => {
      if (count > 0) console.log(JSON.stringify({ outcome: 'swept_stale_workspaces', count }));
    });
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  const app = createApp();
  const server = createServer(app);

  // The client aborts at 120s. Anything still trickling in after that is
  // already a lost cause, so let the socket go rather than hold it forever.
  server.requestTimeout = 120_000;
  server.headersTimeout = 60_000;

  await new Promise<void>((resolve) => server.listen(port, HOST, resolve));
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  console.log(JSON.stringify({ outcome: 'listening', host: HOST, port: boundPort }));

  const close = async () => {
    clearInterval(sweepTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, port: boundPort, close };
}

// pathToFileURL rather than string concatenation: a checkout under a path with
// a space or a non-ASCII character would otherwise never match, and the service
// would start and then silently do nothing.
const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  startServer()
    .then(({ close }) => {
      const shutdown = (signal: string) => {
        console.log(JSON.stringify({ outcome: 'shutdown', signal }));
        void close().then(() => process.exit(0));
        // Do not let a stuck connection hold the process open forever.
        setTimeout(() => process.exit(0), 10_000).unref();
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((error: unknown) => {
      if (error instanceof PreflightError) {
        console.error(`\n${error.message}\n`);
      } else {
        console.error(error);
      }
      process.exit(1);
    });
}
