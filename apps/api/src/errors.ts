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
