import Database from 'better-sqlite3';

/**
 * Read-only access to the `public_chunks`/`public_chunks_fts` tables
 * `apps/api/src/index/public-search-index.ts` owns, creates, and migrates
 * (`plan.md` M17) — the search twin of `PublishedIndexReader`. This
 * service never creates, migrates, or writes to that database; it is
 * opened the same way `PublishedIndexReader` is, against the same shared
 * `index.db` file.
 *
 * Deliberately does not import anything from `apps/api` — this package has
 * no dependency on it — so the schema this file's SQL agrees with is
 * duplicated by hand, the same choice `index-reader.ts` already made.
 *
 * BM25 text only, no vector search: `apps/public-api` stays minimal
 * (`plan.md` M14) and has no embedding model of its own. The private side
 * keeps the fuller "search by meaning" experience (`requirements.md` §8).
 */

export type PublicSearchSourceType = 'entry' | 'document';

export interface PublicSearchHit {
  sourceType: PublicSearchSourceType;
  sourceId: string;
  text: string;
}

interface RawHit {
  source_type: string;
  source_id: string;
  text: string;
}

/** A generous ceiling, not a tuned one — see `index-reader.ts`'s identical
 * reasoning for `MAX_ITEMS`. */
const MAX_LIMIT = 50;

export class PublicSearchReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  /** BM25 text search, best match first. A safe empty result on a query
   * with no usable terms — never a syntax error surfaced from whatever a
   * visitor typed. */
  search(query: string, limit: number): PublicSearchHit[] {
    const matchQuery = toFtsMatchQuery(query);
    if (matchQuery === null) return [];
    const rows = this.#db
      .prepare(
        `SELECT c.source_type AS source_type, c.source_id AS source_id, c.text AS text
         FROM public_chunks_fts
         JOIN public_chunks c ON c.id = public_chunks_fts.rowid
         WHERE public_chunks_fts MATCH ?
         ORDER BY bm25(public_chunks_fts)
         LIMIT ?`,
      )
      .all(matchQuery, Math.min(limit, MAX_LIMIT)) as RawHit[];
    return rows.map((row) => ({
      sourceType: row.source_type as PublicSearchSourceType,
      sourceId: row.source_id,
      text: row.text,
    }));
  }

  close(): void {
    this.#db.close();
  }
}

/** Identical sanitisation to `apps/api/src/index/search-index.ts`'s
 * `toFtsMatchQuery` — duplicated rather than imported, for the same reason
 * the schema above is: this package has no dependency on `apps/api`. */
function toFtsMatchQuery(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replace(/"/g, '""')}"`);
  return terms.length > 0 ? terms.join(' OR ') : null;
}
