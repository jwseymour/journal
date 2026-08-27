import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as sqliteVec from 'sqlite-vec';

/**
 * The search index (`plan.md` M6, generalised to documents in M17):
 * paragraph-level chunks, an FTS5 table for BM25 text search, and a
 * `sqlite-vec` table for vector kNN — all three living in the same database
 * file as `SqliteIndex`, so the whole derived layer stays one deletable
 * artefact (`requirements.md` §6.4).
 *
 * A second connection to the same file rather than a shared one: both
 * classes are synchronous (better-sqlite3 has no async API), so there is no
 * interleaving to coordinate, and keeping them separate connections means
 * this file does not need to know anything about `SqliteIndex`'s schema, or
 * vice versa.
 *
 * Like `SqliteIndex`, this is purely a cache. `chunks.text` duplicates a
 * fragment of the source body — cheap, and what makes removal a plain
 * `DELETE` rather than a three-way sync between an external-content FTS5
 * table and its source of truth. Deleting this file loses nothing that
 * `rebuild --from-scratch` cannot regenerate from the journal files.
 *
 * `source_type` distinguishes an entry's chunks from a document's
 * (`plan.md` M17) — the physical column is still named `entry_id` (an
 * `ALTER TABLE ADD COLUMN` only ever adds; renaming an existing column
 * carries more migration risk than this earns), but every row is now keyed
 * by `(source_type, entry_id)`, never `entry_id` alone, so a document and
 * an entry can never collide even though ids are drawn from the same ULID
 * space.
 */

export type SearchSourceType = 'entry' | 'document';

export interface SearchIndexHit {
  sourceType: SearchSourceType;
  sourceId: string;
  chunkIndex: number;
  text: string;
}

export class SearchIndex {
  readonly #db: Database.Database;
  readonly #dimensions: number;

  constructor(dbPath: string, dimensions: number) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    sqliteVec.load(this.#db);
    this.#db.pragma('journal_mode = WAL');
    this.#dimensions = dimensions;
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chunks_entry ON chunks (entry_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text);
    `);
    // vec0's dimension is fixed at CREATE TIME and cannot be parameterised
    // with a bound placeholder — it must be interpolated into the DDL. Safe
    // here because `dimensions` is a number from this process's own config,
    // never a caller-supplied string.
    this.#db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        embedding float[${this.#dimensions}]
      );
    `);

    // `source_type` (`plan.md` M17) — added after `chunks` already shipped
    // entry-only, so an existing database needs it added in place, once,
    // the same idempotent-migration shape every other index in this
    // directory uses for a new column. Every row written before this ran
    // is an entry's, so the default is exactly right, not a guess.
    const columns = this.#db.prepare('PRAGMA table_info(chunks)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'source_type')) {
      this.#db.exec("ALTER TABLE chunks ADD COLUMN source_type TEXT NOT NULL DEFAULT 'entry';");
    }
    this.#db.exec('CREATE INDEX IF NOT EXISTS chunks_source ON chunks (source_type, entry_id);');
  }

  /**
   * Replaces every chunk belonging to `(sourceType, sourceId)` with
   * `chunks`/`embeddings` — always the full set, never a partial update,
   * because an edit can change which paragraph is which without changing
   * how many there are, and there is no cheap way to tell that apart from
   * the outside.
   */
  replaceSource(
    sourceType: SearchSourceType,
    sourceId: string,
    chunks: string[],
    embeddings: Float32Array[],
  ): void {
    if (chunks.length !== embeddings.length) {
      throw new Error('SearchIndex.replaceSource: chunks and embeddings must be the same length.');
    }
    const insert = this.#db.transaction(() => {
      this.#deleteSource(sourceType, sourceId);
      const insertChunk = this.#db.prepare(
        'INSERT INTO chunks (entry_id, chunk_index, text, source_type) VALUES (?, ?, ?, ?)',
      );
      const insertFts = this.#db.prepare('INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)');
      const insertVec = this.#db.prepare('INSERT INTO chunks_vec (rowid, embedding) VALUES (?, ?)');
      chunks.forEach((text, chunkIndex) => {
        const { lastInsertRowid } = insertChunk.run(sourceId, chunkIndex, text, sourceType);
        insertFts.run(lastInsertRowid, text);
        insertVec.run(BigInt(lastInsertRowid), toVectorBuffer(embeddings[chunkIndex]!));
      });
    });
    insert();
  }

  removeSource(sourceType: SearchSourceType, sourceId: string): void {
    this.#db.transaction(() => this.#deleteSource(sourceType, sourceId))();
  }

  /** Convenience wrapper kept for every existing entry call site
   * (`SearchingEntryStore`, `SearchIndexer.indexEntry`/`rebuildAll`) —
   * exactly `replaceSource('entry', ...)`. */
  replaceEntry(entryId: string, chunks: string[], embeddings: Float32Array[]): void {
    this.replaceSource('entry', entryId, chunks, embeddings);
  }

  /** Convenience wrapper — exactly `removeSource('entry', ...)`. */
  removeEntry(entryId: string): void {
    this.removeSource('entry', entryId);
  }

  #deleteSource(sourceType: SearchSourceType, sourceId: string): void {
    const ids = (
      this.#db
        .prepare('SELECT id FROM chunks WHERE source_type = ? AND entry_id = ?')
        .all(sourceType, sourceId) as { id: number }[]
    ).map((row) => row.id);
    if (ids.length === 0) return;
    const deleteFts = this.#db.prepare('DELETE FROM chunks_fts WHERE rowid = ?');
    const deleteVec = this.#db.prepare('DELETE FROM chunks_vec WHERE rowid = ?');
    for (const id of ids) {
      deleteFts.run(id);
      deleteVec.run(BigInt(id));
    }
    this.#db.prepare('DELETE FROM chunks WHERE source_type = ? AND entry_id = ?').run(sourceType, sourceId);
  }

  /** BM25 text search, best match first. A safe no-op on a query with no
   * usable terms — never a syntax error surfaced from whatever the user typed. */
  searchText(query: string, limit: number): SearchIndexHit[] {
    const matchQuery = toFtsMatchQuery(query);
    if (matchQuery === null) return [];
    const rows = this.#db
      .prepare(
        `SELECT c.source_type AS sourceType, c.entry_id AS sourceId, c.chunk_index AS chunkIndex, c.text AS text
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY bm25(chunks_fts)
         LIMIT ?`,
      )
      .all(matchQuery, limit) as SearchIndexHit[];
    return rows;
  }

  /** Vector kNN, nearest first. */
  searchVector(embedding: Float32Array, limit: number): SearchIndexHit[] {
    const rows = this.#db
      .prepare(
        `SELECT c.source_type AS sourceType, c.entry_id AS sourceId, c.chunk_index AS chunkIndex, c.text AS text
         FROM chunks_vec v
         JOIN chunks c ON c.id = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`,
      )
      .all(toVectorBuffer(embedding), limit) as SearchIndexHit[];
    return rows;
  }

  stats(): { chunkCount: number } {
    const chunkCount = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
    ).n;
    return { chunkCount };
  }

  /** Wipe every row. The first step of a search-index rebuild, mirroring
   * `SqliteIndex.clear()`. */
  clear(): void {
    this.#db.exec('DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM chunks_vec;');
  }

  close(): void {
    this.#db.close();
  }
}

function toVectorBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * FTS5's query syntax treats `"`, `*`, `:`, `-` and parentheses specially —
 * meaningful in a deliberate query, but a syntax error waiting to happen in
 * arbitrary user text ("what's on my mind (again)"). Tokenising by word and
 * quoting each one turns "search by meaning" input into a safe OR-of-terms
 * match without giving up FTS5's own tokenisation (stemming-free, but
 * case- and punctuation-insensitive within each quoted term).
 */
export function toFtsMatchQuery(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .map((term) => `"${term.replace(/"/g, '""')}"`);
  return terms.length > 0 ? terms.join(' OR ') : null;
}
