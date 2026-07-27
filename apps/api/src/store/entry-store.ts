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

export interface StoredEntry extends Entry {
  /** Journal-root-relative, POSIX separators. Informational only — never a key. */
  path: string;
}

export interface ListOptions {
  cursor?: string;
  limit: number;
}

export interface ListResult {
  entries: EntrySummary[];
  nextCursor: string | null;
}

export interface StoreStats {
  entryCount: number;
  /** Files that look like entries but cannot be read as one. See `HealthResponse`. */
  unreadableCount: number;
}

export interface EntryStore {
  /** Write a new entry. The only way anything is ever written (`requirements.md` §4.4). */
  create(input: CreateEntryInput): Promise<StoredEntry>;

  /** Fetch one entry by id, or `null` if there is no such entry. */
  get(id: string): Promise<StoredEntry | null>;

  /** One page of entries, newest first. */
  list(options: ListOptions): Promise<ListResult>;

  stats(): Promise<StoreStats>;
}
