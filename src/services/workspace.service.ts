/**
 * Per-request scratch space on disk.
 *
 * Everything one request touches - the upload, the LibreOffice profile and the
 * converted output - lives under a single temp directory, so that cleanup is
 * one recursive delete and a crash can be swept up afterwards by looking at
 * mtimes. Nothing is written outside it except the process's own stdout.
 *
 * The upload is never named after anything the client sent. See
 * `inputFileNameFor`.
 */
import fsp from 'node:fs/promises';
import { join } from 'node:path';

import { STALE_WORKSPACE_MS, TEMP_ROOT } from '../config.ts';
import type { AllowedExtension } from '../formats.ts';

/** Name we give the upload on disk. Server-generated, never the client's. */
const INPUT_BASENAME = 'input';
export const OUTPUT_DIRNAME = 'out';
export const PROFILE_DIRNAME = 'lo-profile';

/**
 * The filename we write the upload to: `<basename>.<validated extension>`.
 *
 * The client's own filename is NEVER used on disk. It is only ever read to
 * derive the extension, because a filename like `../../etc/cron.d/x.docx` is a
 * path traversal waiting to happen and there is no reason to take the risk.
 *
 * The extension is preserved rather than normalised away because that is how
 * soffice chooses the import filter - it is the whole mechanism by which we
 * honour "pick the filter from the extension, not the MIME type".
 */
export function inputFileNameFor(extension: AllowedExtension): string {
  return `${INPUT_BASENAME}${extension}`;
}

/**
 * Create the isolated temp dir that holds one request's input, LibreOffice
 * profile and output.
 *
 * Mode 0700 on both the root and the request directory: this is a shared
 * /tmp on some hosts, and a document somebody uploaded is not for reading by
 * whatever else runs there. The directory *name* is random (mkdtemp), so a
 * second request cannot guess and enter the first one's workspace.
 */
export async function createWorkspace(): Promise<string> {
  await fsp.mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });
  return fsp.mkdtemp(join(TEMP_ROOT, 'req-'));
}

/** Idempotent: safe to call from a finally block and from a close handler. */
export async function removeWorkspace(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Delete workspaces left behind by a crashed or killed process.
 *
 * Only directories older than `staleMs` are touched, which is why the default
 * (`STALE_WORKSPACE_MS`) must stay comfortably above `CONVERT_TIMEOUT_MS`: a
 * live conversion's workspace is never old enough to be swept.
 *
 * `root`/`staleMs` are parameters rather than always `TEMP_ROOT`/
 * `STALE_WORKSPACE_MS` so `media-jobs.service.ts` can reuse this exact
 * function as the crash backstop for its own, much-longer-lived job
 * workspaces - see `sweepMediaJobs`'s own comment for why it needs one at
 * all in addition to its own job-aware sweep.
 */
export async function sweepStaleWorkspaces(
  now = Date.now(),
  root: string = TEMP_ROOT,
  staleMs: number = STALE_WORKSPACE_MS,
): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await fsp.readdir(root);
  } catch {
    return 0; // Root does not exist yet; nothing to sweep.
  }

  for (const entry of entries) {
    const full = join(root, entry);
    try {
      const stat = await fsp.stat(full);
      if (!stat.isDirectory()) continue;
      if (now - stat.mtimeMs < staleMs) continue;
      // Re-check mtime right before deleting: a workspace that was touched
      // between the stat and the delete belongs to something still alive.
      const fresh = await fsp.stat(full);
      if (now - fresh.mtimeMs < staleMs) continue;
      await removeWorkspace(full);
      removed += 1;
    } catch {
      // Racing another sweep, or already gone. Either way, nothing to do.
    }
  }
  return removed;
}
