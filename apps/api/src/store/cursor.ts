import { invalidCursor } from '../errors.js';

/**
 * Opaque list cursors.
 *
 * Entries are ordered by **instant descending, id descending**. The instant,
 * not the `created` text: two timestamps in different offsets do not compare
 * lexically, and `requirements.md` §4.2 is explicit that ordering follows the
 * recorded time and never the filename.
 *
 * Keyset rather than offset, so a page cannot skip or repeat an entry when
 * something is written between requests. The encoding is base64url of a tagged
 * tuple — enough to reject a cursor this server did not issue, and no more.
 * Callers must treat it as opaque; nothing outside this file may read into it.
 *
 * The version tag defaults to `'e1'` (entries, the first and only caller
 * until documents) but is a parameter, not a constant, so a second cursor
 * space — `'d1'` for documents — can never be confused with the first: a
 * cursor from one list endpoint pasted into the other's query param is
 * rejected rather than silently misread.
 */

const DEFAULT_VERSION = 'e1';

export interface Cursor {
  /** The instant of the last entry on the previous page. */
  readonly epochMs: number;
  /** Its id, breaking ties between entries written in the same millisecond. */
  readonly id: string;
}

export function encodeCursor(cursor: Cursor, version: string = DEFAULT_VERSION): string {
  return Buffer.from(JSON.stringify([version, cursor.epochMs, cursor.id]), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(value: string, version: string = DEFAULT_VERSION): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalidCursor();
  const [taggedVersion, epochMs, id] = parsed as unknown[];
  if (taggedVersion !== version) throw invalidCursor();
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) throw invalidCursor();
  if (typeof id !== 'string' || id.length === 0) throw invalidCursor();
  return { epochMs, id };
}

/**
 * The list ordering, in one place: newest first, id descending as the tiebreak.
 *
 * Used both to sort the corpus and to decide what falls after a cursor, so the
 * two can never disagree.
 */
export function compareDescending(
  a: { epochMs: number; id: string },
  b: { epochMs: number; id: string },
): number {
  if (a.epochMs !== b.epochMs) return b.epochMs - a.epochMs;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Whether `candidate` sorts strictly after `cursor` — i.e. belongs on the next page. */
export function isAfterCursor(candidate: { epochMs: number; id: string }, cursor: Cursor): boolean {
  return compareDescending(candidate, cursor) > 0;
}
