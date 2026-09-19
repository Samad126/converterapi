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
 * 200 as a PDF, so a 200-with-error-body fails much further downstream where it
 * is far harder to diagnose.
 */

export type ErrorCode =
  | 'E_CONVERT_FAILED'
  | 'E_TIMEOUT'
  | 'E_ENCRYPTED'
  | 'E_UNSUPPORTED'
  | 'E_TOO_LARGE'
  | 'E_BUSY'
  | 'E_BAD_REQUEST'
  | 'E_RATE_LIMITED'
  | 'E_INTERNAL';

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

  /** Extension is not .docx/.docm/.doc. */
  unsupported: () =>
    new AppError('E_UNSUPPORTED', 415, 'Only Word documents (.docx, .docm, .doc) can be converted.'),

  /** Over MAX_UPLOAD_BYTES. */
  tooLarge: () =>
    new AppError('E_TOO_LARGE', 413, 'This document is too large to convert.'),

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
};
