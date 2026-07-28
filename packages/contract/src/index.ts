/**
 * The API contract between the frontend and the backend.
 *
 * This package is types only. It has no dependencies and emits no runtime code,
 * so importing it can never drag storage, validation, or provider detail across
 * the boundary (`requirements.md` §7.1). Import everything from here with
 * `import type`.
 *
 * These shapes are what a replacement frontend would be written against, and
 * what a hosted backend would have to keep serving. Treat them as a published
 * interface rather than an internal convenience.
 */

/**
 * WGS 84 decimal degrees, at whatever precision the device reported.
 *
 * Never rounded — the point is to keep exactly what was captured, however
 * irrelevant the trailing digits turn out to be (`format.md` §3).
 */
export interface Coordinates {
  lat: number;
  lon: number;
}

/**
 * Everything an entry records about itself.
 *
 * Three fields, and no others. There is no title, no tag, no word count, no
 * modification time (`requirements.md` §4.3). `location` is *absent* when
 * unavailable rather than null or empty, which is why it is optional here and
 * why `exactOptionalPropertyTypes` is on.
 */
export interface EntryMetadata {
  /** A ULID. Assigned once at creation, never changes, never reused. */
  id: string;

  /**
   * RFC 3339, always carrying a UTC offset — `2026-07-26T22:55:13+01:00`.
   *
   * A local time without an offset is permanently ambiguous, which matters
   * given an expectation of travel (`requirements.md` §4.3). Kept as a string
   * rather than a `Date` precisely because `Date` cannot hold the offset.
   */
  created: string;

  location?: Coordinates;
}

/**
 * An entry as it appears in a list: metadata plus enough prose to recognise it.
 *
 * The excerpt is cut by the backend. The frontend renders the string it is
 * given and does not know how it was produced (`requirements.md` §7.1).
 */
export interface EntrySummary extends EntryMetadata {
  excerpt: string;
}

/** An entry in full. The body is exactly the bytes on disk, minus frontmatter. */
export interface Entry extends EntryMetadata {
  body: string;

  /**
   * An opaque fingerprint of exactly what is on disk right now.
   *
   * Not a hash of anything the caller should interpret — just a value that
   * changes if and only if the file's bytes change. Pass it back on
   * `PUT /entries/:id` as a precondition: if it no longer matches what is on
   * disk, the write is rejected with `edit_conflict` rather than silently
   * overwriting someone else's change.
   *
   * This matters specifically because these files are meant to be opened in an
   * ordinary text editor — that is a stated benefit of plain files, not an edge
   * case (`plan.md` M2) — so the backend can never assume it is the only writer.
   */
  contentHash: string;
}

/**
 * One page of entries, newest first.
 *
 * Ordered by `created` descending, with `id` descending as the tiebreak. The
 * cursor is opaque: it encodes a position in that ordering and nothing the
 * caller should parse. Pagination is cursor-based from the first commit so that
 * swapping a directory scan for an index (M5) does not change this shape.
 */
export interface EntryPage {
  entries: EntrySummary[];
  /** Pass back as `cursor` for the next page. `null` means this was the last. */
  nextCursor: string | null;
}

/**
 * Creating an entry.
 *
 * `created` and `location` come from the client because only the client knows
 * the user's UTC offset and position. That is device state, not business logic,
 * so it does not breach "no logic in the frontend" — and the backend must not
 * assume it shares a clock or a timezone with the user, because one day it
 * will not (`requirements.md` §7.2).
 *
 * Both are optional. Omitting `created` falls back to the server's own local
 * time, which keeps `curl` usable; omitting `location` means no location, and
 * nothing is recorded.
 */
export interface CreateEntryRequest {
  body: string;
  created?: string;
  location?: Coordinates;
}

/**
 * The result of creating an entry.
 *
 * `path` is where the file landed, relative to the journal root, with POSIX
 * separators — `journal/2026/07/2026-07-26-2255-abcde8.md`.
 *
 * It is **informational only**: something to `cat` while developing, and a
 * reassurance that a real file exists. It is never a key. Nothing may resolve
 * an entry by it, store it, or reconstruct it, because identity lives in the
 * `id` and a file that is renamed by hand must not break anything
 * (`requirements.md` §4.2). A hosted backend is free to make it meaningless.
 */
export interface CreateEntryResponse {
  id: string;
  created: string;
  path: string;
  /** See `Entry.contentHash`. Needed immediately: the draft lifecycle autosaves
   * the same entry right after creating it, and that first save needs a
   * precondition to check against. */
  contentHash: string;
}

/**
 * Editing an entry — body only.
 *
 * `id`, `created` and `location` describe the act of writing and never change
 * after creation, edit or not (`requirements.md` §4.3). An edit changes what
 * was written, not when or where it was written, so this is the entire
 * request: the new text, and proof the caller has seen the current version.
 */
export interface UpdateEntryRequest {
  body: string;
  /** Must match the current `Entry.contentHash`, or the write is rejected. */
  contentHash: string;
}

/** The entry as it stands after the edit, including its new `contentHash`. */
export type UpdateEntryResponse = Entry;

/**
 * Stable, machine-readable failure codes.
 *
 * Codes rather than bare HTTP statuses, because a future remote frontend will
 * need to distinguish these without parsing prose. Add to this union; do not
 * repurpose an existing member.
 */
export type ApiErrorCode =
  /** The request body or query string did not validate. */
  | 'invalid_request'
  /** No entry with that id. */
  | 'entry_not_found'
  /** The cursor was not one we issued. */
  | 'invalid_cursor'
  /**
   * The request came from, or was addressed to, a host this server does not
   * serve. The allowlist is explicit and there is no wildcard.
   */
  | 'forbidden_origin'
  /** A file exists but could not be read as an entry. See `format.md` §3. */
  | 'malformed_entry'
  /**
   * `contentHash` on a `PUT` no longer matches what is on disk — the entry
   * changed since the caller last read it, most likely by hand in a text
   * editor. The write did not happen (`plan.md` M2).
   */
  | 'edit_conflict'
  /** The journal directory could not be read or written. */
  | 'journal_unavailable'
  /** Anything unanticipated. */
  | 'internal';

export interface ApiError {
  error: {
    code: ApiErrorCode;
    message: string;
  };
}

/** Liveness, and enough detail to tell which journal is being served. */
export interface HealthResponse {
  status: 'ok';
  journalDir: string;
  entryCount: number;

  /**
   * Files under the journal directory that look like entries but could not be
   * read as one — missing `id`, unparseable `created`, broken frontmatter.
   *
   * Such a file is skipped rather than allowed to fail the whole listing: one
   * damaged file must never make the rest of the journal unreachable. Skipping
   * silently would hide real damage, so the count is surfaced here.
   *
   * This is a count of *unreadable files*, not of writing. It says nothing
   * about how much or how often the user writes and is not an engagement
   * metric (`design.md` §4).
   */
  unreadableCount: number;
}
