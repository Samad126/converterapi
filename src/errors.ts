/**
 * The error contract shared with the Android client.
 *
 * Every non-2xx response carries:
 *
 *     {"error": {"code": "E_...", "message": "<sentence shown to the user>"}}
 *
 * `message` is rendered VERBATIM in a dialog on the phone, so it is written for
 * a person: a complete sentence, no stack traces, no file paths, no codes, and
 * no advice that only makes sense to a developer. `code` is for logs, support
 * and metrics only - the client never shows it.
 *
 * The one thing that must never happen is a failure delivered as 200 with this
 * envelope in the body: the client checks the status code first and treats any
 * 200 as a file, so a 200-with-error-body fails much further downstream where
 * it is far harder to diagnose.
 */
import { describeSources, describeTargets, type TargetId } from './formats.ts';

export type ErrorCode =
  | 'E_CONVERT_FAILED'
  | 'E_TIMEOUT'
  | 'E_ENCRYPTED'
  | 'E_UNSUPPORTED'
  | 'E_UNSUPPORTED_TARGET'
  | 'E_UNKNOWN_TARGET'
  | 'E_TOO_LARGE'
  | 'E_NO_TABLES'
  | 'E_NO_LAYERS'
  | 'E_NOT_TABULAR'
  | 'E_BAD_PAGE_RANGE'
  | 'E_TOO_FEW_FILES'
  | 'E_WRONG_PASSWORD'
  | 'E_INVALID_FIELD'
  | 'E_BUSY'
  | 'E_BAD_REQUEST'
  | 'E_RATE_LIMITED'
  | 'E_INTERNAL'
  | 'E_JOB_NOT_FOUND'
  | 'E_JOB_NOT_READY';

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** The sentence the phone will show. */
  readonly userMessage: string;

  constructor(code: ErrorCode, status: number, userMessage: string, options?: { cause?: unknown }) {
    super(`${code}: ${userMessage}`, options);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
  }

  toEnvelope(): ErrorEnvelope {
    return { error: { code: this.code, message: this.userMessage } };
  }
}

/**
 * The client went away mid-conversion.
 *
 * Not an AppError: there is nobody left to send a response to. It exists so the
 * request handler can tell "the user cancelled" apart from a real fault and skip
 * the pointless write to a dead socket.
 */
export class ClientGoneError extends Error {
  constructor() {
    super('client disconnected');
    this.name = 'ClientGoneError';
  }
}

/**
 * A boot-time problem: the service cannot do its job, so it must not start.
 *
 * Distinct from AppError because it is never sent to a client - it is printed
 * and the process exits non-zero.
 */
export class PreflightError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PreflightError';
  }
}

export const Errors = {
  /** soffice exited non-zero, or produced no file, or produced an empty one. */
  convertFailed: (cause?: unknown) =>
    new AppError(
      'E_CONVERT_FAILED',
      500,
      'This document could not be converted. It may be damaged or in a format the converter does not support.',
      { cause },
    ),

  /** Exceeded CONVERT_TIMEOUT_MS. */
  timeout: (cause?: unknown) =>
    new AppError('E_TIMEOUT', 504, 'This document took too long to convert.', { cause }),

  /** Password protected / encrypted. */
  encrypted: () =>
    new AppError('E_ENCRYPTED', 422, 'This document is password protected.'),

  /**
   * The upload's extension is not one we accept.
   *
   * Names the accepted set: the person holding the phone has a file they think
   * is a document, and "unsupported" alone tells them nothing about what would
   * work.
   */
  unsupported: (message?: string) =>
    new AppError(
      'E_UNSUPPORTED',
      415,
      // The page endpoints (`/pdf/merge` and friends) pass their own message:
      // "Supported types: <the whole matrix>" would be actively misleading on
      // an endpoint that only ever accepts PDFs, or only ever accepts images.
      message ?? `This file type cannot be converted. Supported types: ${describeSources()}.`,
    ),

  /**
   * A real target, but not one this source can become - asking for PNG from a
   * .docx, say.
   *
   * The message lists what the document CAN become instead, because the useful
   * answer to "can I have this as X" is "no, but here is what you can have".
   */
  unsupportedTarget: (sourceExtension: string, available: readonly TargetId[]) =>
    new AppError(
      'E_UNSUPPORTED_TARGET',
      415,
      `A ${sourceExtension} file can be converted to: ${describeTargets(available)}.`,
    ),

  /** A target id that does not exist at all: /convert/banana. */
  unknownTarget: (available: readonly TargetId[]) =>
    new AppError(
      'E_UNKNOWN_TARGET',
      404,
      `That is not a format this converter can produce. Available: ${describeTargets(available)}.`,
    ),

  /** Over MAX_UPLOAD_BYTES, or more pages than we will rasterise at once. */
  tooLarge: (cause?: unknown) =>
    new AppError('E_TOO_LARGE', 413, 'This document is too large to convert.', { cause }),

  /**
   * The document opened fine and simply has no tables in it.
   *
   * Its own code rather than E_CONVERT_FAILED, which is what it would be if
   * left alone: nothing failed here - the document is exactly what it claims
   * to be. Telling someone their letter "may be damaged" because it happens to
   * contain no tables is the same wrong explanation E_ENCRYPTED exists to
   * avoid, and this is the table-shaped version of it.
   */
  noTables: () =>
    new AppError('E_NO_TABLES', 422, 'This document does not contain any tables.'),

  /**
   * The PSD opened fine and holds nothing we can draw.
   *
   * The same distinction as E_NO_TABLES, for the same reason: a document of
   * nothing but adjustment and text layers is a perfectly ordinary document,
   * and telling its owner it "may be damaged" because none of its layers
   * rasterise would be the wrong explanation of something that did not go
   * wrong. The message names both ways a layer can be unusable, because the
   * person reading it can act on either.
   */
  noLayers: () =>
    new AppError(
      'E_NO_LAYERS',
      422,
      'This PSD file does not contain any layers with images that can be extracted.',
    ),

  /**
   * The source parsed fine - it is a real, valid JSON/YAML/JSONL document -
   * and simply is not shaped the way `targetLabel` needs: CSV/TSV can only
   * represent a top-level array of flat objects, and JSONL needs at least a
   * top-level array (see `data.service.ts`'s own header comment for why).
   * This document is a single object, a bare scalar, or - for CSV/TSV - an
   * array with nesting inside it. The same distinction as
   * E_NO_TABLES/E_NO_LAYERS, for the same reason: nothing here is damaged,
   * so the generic "could not be converted" would be the wrong explanation.
   * `shapeRequirement` names the specific rule that was not met, since the
   * two targets this covers do not share exactly one.
   */
  notTabular: (targetLabel: string, shapeRequirement: string) =>
    new AppError(
      'E_NOT_TABULAR',
      422,
      `This document is not ${shapeRequirement}, so it cannot become ${targetLabel}.`,
    ),

  /**
   * A page-selection field (`pages`/`order`) named something that is not a
   * coherent instruction against the document it came with: a page outside
   * the document, malformed syntax, or (for `organize`) a selection that is
   * not a true permutation of every page.
   *
   * The message is the specific problem rather than a fixed sentence, unlike
   * `badRequest` - the person holding the phone typed a page number, and
   * "page 9 does not exist in this 5-page document" is something they can
   * fix, where a generic "bad request" is not.
   */
  badPageRange: (message: string) => new AppError('E_BAD_PAGE_RANGE', 400, message),

  /**
   * Merge needs at least two files, and scan-to-PDF needs at least one - both
   * genuine "there is nothing to do" states rather than a malformed request,
   * so each gets its own sentence rather than sharing `badRequest`'s.
   */
  tooFewFiles: (message: string) => new AppError('E_TOO_FEW_FILES', 400, message),

  /**
   * `/pdf/unlock` was given a password that does not open the file.
   *
   * Distinct from `E_ENCRYPTED`: that code means "we refused to touch this
   * file because it is locked and you did not ask us to unlock it";
   * this one means "you asked, and the password you gave is not the one
   * that opens it" - a different fact the person holding the phone can act
   * on differently (try again versus this just is not the right endpoint).
   */
  wrongPassword: () =>
    new AppError('E_WRONG_PASSWORD', 422, 'That password does not unlock this PDF.'),

  /**
   * A form field for `/pdf/rotate`, `/pdf/watermark`, `/pdf/protect` or
   * `/pdf/unlock` (`degrees`, `text`, `password`) is missing or malformed.
   *
   * Its own code rather than `badRequest`'s fixed sentence, and for the same
   * reason `badPageRange` has its own: the message names the specific field
   * and what is wrong with it, which is something a person can fix, where a
   * generic "the document could not be received" is not.
   */
  invalidField: (message: string) => new AppError('E_INVALID_FIELD', 400, message),

  /** No free conversion slot. */
  busy: () =>
    new AppError('E_BUSY', 503, 'The converter is busy. Try again in a moment.'),

  /** Malformed request: no file part, the wrong field name, several files. */
  badRequest: (detail: string) =>
    new AppError('E_BAD_REQUEST', 400, 'The document could not be received. Please try again.', {
      cause: detail,
    }),

  /** Per-IP request budget exhausted. */
  rateLimited: () =>
    new AppError('E_RATE_LIMITED', 429, 'Too many requests. Try again in a moment.'),

  /** Anything we did not anticipate. */
  internal: (cause?: unknown) =>
    new AppError('E_INTERNAL', 500, 'Something went wrong on the server.', { cause }),

  /** `GET /media/jobs/{id}` (or its `/download`) named a job that does not exist - never did, or was swept after MEDIA_JOB_TTL_MS. */
  jobNotFound: () => new AppError('E_JOB_NOT_FOUND', 404, 'That conversion job does not exist.'),

  /** `GET /media/jobs/{id}/download` was called before the job finished. */
  jobNotReady: (status: 'queued' | 'running') =>
    new AppError(
      'E_JOB_NOT_READY',
      409,
      `This conversion is still ${status === 'queued' ? 'queued' : 'in progress'}. Check back in a moment.`,
    ),
};
