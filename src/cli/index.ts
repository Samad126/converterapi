#!/usr/bin/env node
/**
 * `converter` - the local CLI twin of this service's HTTP API.
 *
 * Same conversion engines (LibreOffice, pandoc, ffmpeg, qpdf, Calibre,
 * assimp, etc), driven directly against files on disk instead of over HTTP.
 * No rate limiting, no upload ceiling, no request queue and no
 * CONVERT_TIMEOUT_MS deadline worth enforcing: those exist in `config.ts` to
 * protect a shared host from the public internet, and neither concern
 * applies to a person running this against their own files on their own
 * machine - see each command module's own header comment.
 *
 * Deliberately raises CONVERT_TIMEOUT_MS before anything else in this
 * process imports `config.ts` (module-level `intFromEnv` calls read it once,
 * at import time), so a long document or a slow machine doesn't hit the
 * server's own 90s default.
 */
if (!process.env.CONVERT_TIMEOUT_MS) {
  process.env.CONVERT_TIMEOUT_MS = String(1000 * 60 * 60 * 6); // 6 hours
}

// `converter formats | head` (or `| less`, piping into anything that closes
// its input early) makes stdout emit EPIPE the moment the reader hangs up.
// Node treats an unhandled 'error' on process.stdout as fatal by default -
// which would print a raw stack trace for the most ordinary thing a person
// does with a long listing. Nothing to do about it but stop writing.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

const [, , command, ...rest] = process.argv;

async function main(): Promise<void> {
  switch (command) {
    case 'convert': {
      const { runConvert } = await import('./convert.ts');
      await runConvert(rest);
      return;
    }
    case 'pdf': {
      const { runPdf } = await import('./pdf.ts');
      await runPdf(rest);
      return;
    }
    case 'media': {
      const { runMedia } = await import('./media.ts');
      await runMedia(rest);
      return;
    }
    case 'formats': {
      const { printFormats } = await import('./formats.ts');
      printFormats();
      return;
    }
    case 'doctor': {
      const { runDoctor } = await import('./doctor.ts');
      await runDoctor();
      return;
    }
    case '--help':
    case '-h':
    case 'help':
    case undefined:
      printHelp();
      return;
    default:
      process.stderr.write(`converter: unknown command "${command}"\n\n`);
      printHelp();
      process.exitCode = 1;
  }
}

function printHelp(): void {
  process.stdout.write(
    `converter - local file conversion, no upload limits, nothing leaves this machine

Usage:
  converter convert <target> <file> [file2 ...] [--out <dir>] [--ocr=false]
  converter media <target> <file> [file2 ...] [--out <dir>]
  converter pdf <operation> <file> [flags]
  converter formats
  converter doctor

converter pdf operations, each on its own PDF file(s):
  merge <file1.pdf> <file2.pdf> [...]        combine into one PDF, in order given
  split <file.pdf> [--every <n>]             cut into N-page chunks (default 1)
  remove <file.pdf> --pages <selection>      drop the named pages
  extract <file.pdf> --pages <selection>     keep only the named pages
  organize <file.pdf> --order <selection>    reorder every page
  scan <image1> [image2 ...]                 turn images into a scanned PDF
  rotate <file.pdf> --degrees <n> [--pages]  rotate 90/180/270/-90/-180/-270
  watermark <file.pdf> --text <text> [--pages]
  crop <file.pdf> [--left/--right/--top/--bottom <pt>] [--pages]
  page-numbers <file.pdf> [--position bottom-center|left|right] [--start-at <n>]
  protect <file.pdf> --password <password>   add a password
  unlock <file.pdf> --password <password>    remove a password
  repair <file.pdf>                          fix a damaged PDF
  compress <file.pdf> [--level low|medium|high]

  A --pages/--order selection looks like "1,3,5-7". All operations take
  [--out <dir>].

Examples:
  converter convert pdf report.docx
  converter convert png slides.pptx --out ./images
  converter pdf merge a.pdf b.pdf c.pdf
  converter pdf split report.pdf --every 5
  converter pdf rotate scan.pdf --degrees 90
  converter pdf protect secret.pdf --password hunter2
  converter media mp3 podcast.wav
  converter media mp4 clip.mov --out ./out

Run "converter formats" to list every conversion target, and "converter doctor"
to check that the system tools this relies on (LibreOffice, ffmpeg, pandoc,
qpdf, Calibre, ...) are installed.
`,
  );
}

main().catch((error) => {
  process.stderr.write(`converter: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
