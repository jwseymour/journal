import type { ApiErrorCode } from '@journal/contract';

/**
 * Every failure that crosses the API boundary carries a stable machine-readable
 * code, not merely an HTTP status (`plan.md` M1). A remote frontend has to be
 * able to tell these apart without reading prose.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export const invalidRequest = (message: string): AppError =>
  new AppError('invalid_request', message, 400);

export const entryNotFound = (id: string): AppError =>
  new AppError('entry_not_found', `No entry with id ${id}.`, 404);

export const invalidCursor = (): AppError =>
  new AppError('invalid_cursor', 'The cursor was not one this server issued.', 400);

export const malformedEntry = (message: string, cause?: unknown): AppError =>
  new AppError('malformed_entry', message, 422, cause === undefined ? undefined : { cause });

export const journalUnavailable = (message: string, cause?: unknown): AppError =>
  new AppError('journal_unavailable', message, 503, cause === undefined ? undefined : { cause });

/** `kind` names the record type, e.g. `'entry'` (the default) or
 * `'document'` (`requirements.md` §9) — same parameterisation `recordNotFound`
 * already uses, so the message never claims the wrong thing changed. */
export const editConflict = (kind: string = 'entry'): AppError =>
  new AppError(
    'edit_conflict',
    `This ${kind} changed since it was last read — most likely edited outside the app. Nothing was overwritten.`,
    409,
  );

/** A `PUT` (an edit that actually carries content) naming an id that does
 * not exist — unlike `DELETE`/`reopen`'s tolerant no-op, silently dropping
 * an edit would be worse than telling the caller it landed nowhere
 * (`plan.md` M10). `kind` names the record type, e.g. `'metric'`. */
export const recordNotFound = (kind: string, id: string): AppError =>
  new AppError('record_not_found', `No ${kind} with id ${id}.`, 404);

export const attachmentConflict = (filename: string): AppError =>
  new AppError(
    'attachment_conflict',
    `An attachment named '${filename}' already exists on this entry. Attachments are written once and never overwritten (\`requirements.md\` §7.4).`,
    409,
  );

export const transcriptionFailed = (message: string, cause?: unknown): AppError =>
  new AppError('transcription_failed', message, 503, cause === undefined ? undefined : { cause });

export const searchUnavailable = (message: string, cause?: unknown): AppError =>
  new AppError('search_unavailable', message, 503, cause === undefined ? undefined : { cause });

export const extractionFailed = (message: string, cause?: unknown): AppError =>
  new AppError('extraction_failed', message, 503, cause === undefined ? undefined : { cause });

export const chatFailed = (message: string, cause?: unknown): AppError =>
  new AppError('chat_failed', message, 503, cause === undefined ? undefined : { cause });

/** No valid session cookie or bearer token, or a Google/password sign-in
 * attempt that did not check out (`plan.md` M11). Message is always
 * generic — never distinguishes "wrong password" from "unknown account"
 * from "expired session," so a caller learns nothing from the failure mode
 * beyond "not signed in." */
export const unauthorized = (message = 'Sign in required.'): AppError =>
  new AppError('unauthorized', message, 401);
