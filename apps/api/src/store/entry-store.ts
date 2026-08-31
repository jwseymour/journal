import type { Coordinates, Entry, EntrySummary } from '@journal/contract';

/**
 * The seam.
 *
 * Everything about paths, encodings, frontmatter and the filesystem lives
 * behind this interface. It has exactly one implementation today
 * (`FsEntryStore`) and it is worth getting right while it has one caller,
 * because **this is the join a hosted backend later slides into**
 * (`plan.md` M1, `requirements.md` §7.2).
 *
 * The rule that keeps it honest: nothing above this interface may know that
 * entries are files. No path, no directory, no extension appears in an argument
 * or a return type — with the single, explicitly informational exception of
 * `StoredEntry.path`, which nothing is permitted to resolve by.
 */

export interface CreateEntryInput {
  body: string;
  /**
   * RFC 3339 with a UTC offset. From the client, because only the client knows
   * where the writer is. Omitted only by `curl`, and then the server's own
   * local time stands in.
   */
  created?: string;
  location?: Coordinates;
}

/** `published` is deliberately excluded here: it is computed at the HTTP
 * layer from `Publisher.isPublished`, never stored — same exclusion
 * `StoredDocument` already makes, for the same reason (`document-store.ts`'s
 * own comment). */
export interface StoredEntry extends Omit<Entry, 'published'> {
  /** Journal-root-relative, POSIX separators. Informational only — never a key. */
  path: string;
}

export interface UpdateEntryInput {
  body: string;
  /** Must match the entry's current `contentHash`, or the write is refused. */
  contentHash: string;
}

export interface ListOptions {
  cursor?: string;
  limit: number;
  /** Restrict to one calendar month, local to each entry's own `created`. Both or neither. */
  year?: number;
  month?: number;
}

export interface ListResult {
  entries: EntrySummary[];
  nextCursor: string | null;
}

export interface EntryPeriod {
  year: number;
  month: number;
}

export interface ListPeriodsResult {
  periods: EntryPeriod[];
}

export interface StoreStats {
  entryCount: number;
  /** Files that look like entries but cannot be read as one. See `HealthResponse`. */
  unreadableCount: number;
}

export interface AddAttachmentInput {
  /** A bare filename — "photo.jpg", never a path. Validated, not trusted. */
  filename: string;
  data: Buffer;
}

export interface AddAttachmentResult {
  /** Relative to the entry file itself — "2026-07-26-2255-abcde8/photo.jpg" —
   * exactly the fragment `format.md` §4 says belongs in a body link. Not
   * journal-root-relative like `StoredEntry.path`, because this is the one
   * value meant to be written straight into an entry's own markdown. */
  relativeLink: string;
}

export interface EntryStore {
  /** Write a new entry. The only way anything is ever written (`requirements.md` §4.4). */
  create(input: CreateEntryInput): Promise<StoredEntry>;

  /** Fetch one entry by id, or `null` if there is no such entry. */
  get(id: string): Promise<StoredEntry | null>;

  /**
   * Change an entry's body. `id`, `created` and `location` never move —
   * editing changes what was written, not when or where (`requirements.md`
   * §4.3). Throws `entry_not_found` if there is no such entry, or
   * `edit_conflict` if `input.contentHash` no longer matches what is on disk.
   */
  update(id: string, input: UpdateEntryInput): Promise<StoredEntry>;

  /**
   * The one narrow deletion `format.md` §5 allows: discard an entry, but only
   * if its body is whitespace-only. Declining to commit writing that was
   * started and then abandoned — never a general-purpose delete.
   *
   * A no-op, not an error, if the entry is already gone. Throws
   * `invalid_request` if the entry has real content — the store itself
   * enforces this, not just the caller, because nothing but the user may ever
   * remove actual writing.
   */
  discardIfBlank(id: string): Promise<void>;

  /**
   * Store a file alongside an entry, in a directory sharing the entry file's
   * own stem (`format.md` §4). Throws `entry_not_found` if there is no such
   * entry. Throws `invalid_request` for a filename that is not a bare name
   * (no path separators, no `..`) or that already exists — attachments are
   * written once and never modified (`requirements.md` §7.4), so a name
   * collision is refused rather than silently overwritten.
   */
  addAttachment(entryId: string, input: AddAttachmentInput): Promise<AddAttachmentResult>;

  /** One page of entries, newest first. */
  list(options: ListOptions): Promise<ListResult>;

  /** Every calendar month with at least one entry, newest first. */
  listPeriods(): Promise<ListPeriodsResult>;

  stats(): Promise<StoreStats>;
}
