import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { toFtsMatchQuery } from './search-index.js';

/**
 * A second, much smaller search index, scoped to public content only
 * (`plan.md` M17, `requirements.md` §10/§11) — a deliberately separate
 * table set from `SearchIndex`'s `chunks`/`chunks_fts`/`chunks_vec`, in the
 * same shared `index.db` file `apps/public-api` already opens read-only
 * for `PublishedIndex` (`plan.md` M15). There is no vector column here:
 * `apps/public-api` is meant to stay minimal (`plan.md` M14), and adding
 * hybrid search would mean shipping an embedding model into a process that
 * currently has none. BM25 text search is enough for "find the public
 * thing that mentions this word" — the private side keeps the fuller
 * "search by meaning" experience (`requirements.md` §8).
 *
 * Populated at the moment `Publisher` mirrors something to `public/`, not
 * by a separate crawl (`plan.md` M17) — it only ever contains what was
 * deliberately published, so there is no separate leak-prevention check
 * needed anywhere that reads from it. That property is structural, not a
 * runtime check someone could get wrong.
 */

export type PublicSearchSourceType = 'entry' | 'document';

export interface PublicSearchHit {
  sourceType: PublicSearchSourceType;
  sourceId: string;
  chunkIndex: number;
  text: string;
}

export class PublicSearchIndex {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS public_chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS public_chunks_source ON public_chunks (source_type, source_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS public_chunks_fts USING fts5(text);
    `);
  }

  /** Replaces every chunk belonging to `(sourceType, sourceId)` — the full
   * set, never a partial update, same reasoning as `SearchIndex.replaceSource`. */
  replaceSource(sourceType: PublicSearchSourceType, sourceId: string, chunks: string[]): void {
    const insert = this.#db.transaction(() => {
      this.#deleteSource(sourceType, sourceId);
      const insertChunk = this.#db.prepare(
        'INSERT INTO public_chunks (source_type, source_id, chunk_index, text) VALUES (?, ?, ?, ?)',
      );
      const insertFts = this.#db.prepare('INSERT INTO public_chunks_fts (rowid, text) VALUES (?, ?)');
      chunks.forEach((text, chunkIndex) => {
        const { lastInsertRowid } = insertChunk.run(sourceType, sourceId, chunkIndex, text);
        insertFts.run(lastInsertRowid, text);
      });
    });
    insert();
  }

  removeSource(sourceType: PublicSearchSourceType, sourceId: string): void {
    this.#db.transaction(() => this.#deleteSource(sourceType, sourceId))();
  }

  #deleteSource(sourceType: PublicSearchSourceType, sourceId: string): void {
    const ids = (
      this.#db
        .prepare('SELECT id FROM public_chunks WHERE source_type = ? AND source_id = ?')
        .all(sourceType, sourceId) as { id: number }[]
    ).map((row) => row.id);
    if (ids.length === 0) return;
    const deleteFts = this.#db.prepare('DELETE FROM public_chunks_fts WHERE rowid = ?');
    for (const id of ids) deleteFts.run(id);
    this.#db.prepare('DELETE FROM public_chunks WHERE source_type = ? AND source_id = ?').run(sourceType, sourceId);
  }

  /** BM25 text search, best match first. A safe no-op on a query with no
   * usable terms. */
  searchText(query: string, limit: number): PublicSearchHit[] {
    const matchQuery = toFtsMatchQuery(query);
    if (matchQuery === null) return [];
    return this.#db
      .prepare(
        `SELECT c.source_type AS sourceType, c.source_id AS sourceId, c.chunk_index AS chunkIndex, c.text AS text
         FROM public_chunks_fts
         JOIN public_chunks c ON c.id = public_chunks_fts.rowid
         WHERE public_chunks_fts MATCH ?
         ORDER BY bm25(public_chunks_fts)
         LIMIT ?`,
      )
      .all(matchQuery, limit) as PublicSearchHit[];
  }

  stats(): { chunkCount: number } {
    const chunkCount = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM public_chunks').get() as { n: number }
    ).n;
    return { chunkCount };
  }

  clear(): void {
    this.#db.exec('DELETE FROM public_chunks; DELETE FROM public_chunks_fts;');
  }

  close(): void {
    this.#db.close();
  }
}
