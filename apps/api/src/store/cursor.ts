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
 */

const VERSION = 'e1';

export interface Cursor {
  /** The instant of the last entry on the previous page. */
  readonly epochMs: number;
  /** Its id, breaking ties between entries written in the same millisecond. */
  readonly id: string;
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([VERSION, cursor.epochMs, cursor.id]), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(value: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalidCursor();
  const [version, epochMs, id] = parsed as unknown[];
  if (version !== VERSION) throw invalidCursor();
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
