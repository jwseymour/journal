import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareDescending, isAfterCursor, type Cursor } from '../store/cursor.js';

/**
 * The persistent index for documents — a sibling table in the same shared
 * `index.db` `SqliteIndex` already opens, following the established pattern
 * every other structure type uses (`MetricsIndex`, `ReviewsIndex`, and so
 * on): one class per structure, each owning its own table and its own
 * `#migrate()`, rather than one generic index class parameterised over
 * shape. `SqliteIndex` itself is entry-shaped throughout and was never
 * written to be reused as-is.
 *
 * Everything here is a cache, exactly as `SqliteIndex` is for entries: a
 * disposable projection of what the markdown files already say. `get`/
 * `update` in `FsDocumentStore`/`S3DocumentStore` still read the file fresh
 * every time — this index only ever answers "where is document X" and
 * "what belongs on a list page."
 */

export interface DocumentIndexRow {
  id: string;
  /** Absolute filesystem path (fs backend) or object key (S3 backend) — see
   * `SqliteIndex.IndexRow.absPath`'s identical dual role. */
  absPath: string;
  relPath: string;
  title: string;
  createdEpochMs: number;
  /** Canonical RFC 3339. */
  created: string;
  updatedEpochMs: number;
  updated: string;
  excerpt: string;
  contentHash: string;
  /** `requirements.md` §9.3 — mirrors the document's own frontmatter field. */
  public: boolean;
}

export interface DocumentIndexStats {
  documentCount: number;
  unreadableCount: number;
}

export interface DocumentIndexListResult {
  rows: DocumentIndexRow[];
  hasMore: boolean;
}

export class DocumentsIndex {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        abs_path TEXT NOT NULL UNIQUE,
        rel_path TEXT NOT NULL,
        title TEXT NOT NULL,
        created_epoch_ms INTEGER NOT NULL,
        created TEXT NOT NULL,
        updated_epoch_ms INTEGER NOT NULL,
        updated TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS documents_order ON documents (updated_epoch_ms DESC, id DESC);

      CREATE TABLE IF NOT EXISTS documents_unreadable (
        abs_path TEXT PRIMARY KEY
      );
    `);

    // `public` (`requirements.md` §9.3) — added after the table above
    // already shipped, so existing databases need it added in place, once,
    // the same idempotent-migration shape `MetricsIndex` uses for `touched`.
    const columns = this.#db.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'public')) {
      this.#db.exec('ALTER TABLE documents ADD COLUMN public INTEGER NOT NULL DEFAULT 0;');
    }
  }

  /** Every path currently indexed, readable or not — for diffing against a fresh scan. */
  knownPaths(): Set<string> {
    const readable = this.#db.prepare('SELECT abs_path FROM documents').all() as { abs_path: string }[];
    const unreadable = this.#db.prepare('SELECT abs_path FROM documents_unreadable').all() as {
      abs_path: string;
    }[];
    return new Set([...readable.map((r) => r.abs_path), ...unreadable.map((r) => r.abs_path)]);
  }

  getById(id: string): DocumentIndexRow | null {
    const row = this.#db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  /** Insert or update a row, upserting on `abs_path` — the same identity `SqliteIndex.upsert` keys on. */
  upsert(row: DocumentIndexRow): void {
    this.#db
      .prepare(
        `INSERT INTO documents (id, abs_path, rel_path, title, created_epoch_ms, created, updated_epoch_ms, updated, excerpt, content_hash, public)
         VALUES (@id, @absPath, @relPath, @title, @createdEpochMs, @created, @updatedEpochMs, @updated, @excerpt, @contentHash, @public)
         ON CONFLICT(abs_path) DO UPDATE SET
           id = excluded.id, rel_path = excluded.rel_path, title = excluded.title,
           created_epoch_ms = excluded.created_epoch_ms, created = excluded.created,
           updated_epoch_ms = excluded.updated_epoch_ms, updated = excluded.updated,
           excerpt = excluded.excerpt, content_hash = excluded.content_hash, public = excluded.public`,
      )
      .run({
        id: row.id,
        absPath: row.absPath,
        relPath: row.relPath,
        title: row.title,
        createdEpochMs: row.createdEpochMs,
        created: row.created,
        updatedEpochMs: row.updatedEpochMs,
        updated: row.updated,
        excerpt: row.excerpt,
        contentHash: row.contentHash,
        public: row.public ? 1 : 0,
      });
    this.#db.prepare('DELETE FROM documents_unreadable WHERE abs_path = ?').run(row.absPath);
  }

  markUnreadable(absPath: string): void {
    this.#db.prepare('DELETE FROM documents WHERE abs_path = ?').run(absPath);
    this.#db.prepare('INSERT OR IGNORE INTO documents_unreadable (abs_path) VALUES (?)').run(absPath);
  }

  remove(absPath: string): void {
    this.#db.prepare('DELETE FROM documents WHERE abs_path = ?').run(absPath);
    this.#db.prepare('DELETE FROM documents_unreadable WHERE abs_path = ?').run(absPath);
  }

  /**
   * One page, newest-*updated*-first — see `DocumentPage`'s doc comment in
   * `@journal/contract` for why this differs from the entry list's ordering.
   * `Cursor`'s `epochMs` is read as `updatedEpochMs` here; the type is
   * reused unchanged, only its meaning shifts with the ordering.
   */
  list(cursor: Cursor | null, limit: number): DocumentIndexListResult {
    const rows = (
      cursor
        ? this.#db
            .prepare(
              `SELECT * FROM documents
               WHERE (updated_epoch_ms < @epochMs OR (updated_epoch_ms = @epochMs AND id < @id))
               ORDER BY updated_epoch_ms DESC, id DESC
               LIMIT @limit`,
            )
            .all({ epochMs: cursor.epochMs, id: cursor.id, limit: limit + 1 })
        : this.#db
            .prepare(`SELECT * FROM documents ORDER BY updated_epoch_ms DESC, id DESC LIMIT @limit`)
            .all({ limit: limit + 1 })
    ) as RawRow[];

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(fromRaw);

    // Defence in depth, same reasoning as `SqliteIndex.list`: the SQL WHERE
    // clause already matches `isAfterCursor`, but re-checking with the same
    // shared function is what guarantees the two can never quietly drift.
    if (cursor) {
      for (const row of page) {
        if (!isAfterCursor({ epochMs: row.updatedEpochMs, id: row.id }, cursor)) {
          throw new Error('DocumentsIndex.list produced a row that does not belong after its cursor.');
        }
      }
    }
    for (let i = 1; i < page.length; i++) {
      const prev = { epochMs: page[i - 1]!.updatedEpochMs, id: page[i - 1]!.id };
      const curr = { epochMs: page[i]!.updatedEpochMs, id: page[i]!.id };
      if (compareDescending(prev, curr) <= 0) continue;
      throw new Error('DocumentsIndex.list returned rows out of order.');
    }

    return { rows: page, hasMore };
  }

  stats(): DocumentIndexStats {
    const documentCount = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }
    ).n;
    const unreadableCount = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM documents_unreadable').get() as { n: number }
    ).n;
    return { documentCount, unreadableCount };
  }

  /** Wipe every row — the first step of a document-store rebuild. */
  clear(): void {
    this.#db.exec('DELETE FROM documents; DELETE FROM documents_unreadable;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  abs_path: string;
  rel_path: string;
  title: string;
  created_epoch_ms: number;
  created: string;
  updated_epoch_ms: number;
  updated: string;
  excerpt: string;
  content_hash: string;
  public: number;
}

function fromRaw(row: RawRow): DocumentIndexRow {
  return {
    id: row.id,
    absPath: row.abs_path,
    relPath: row.rel_path,
    title: row.title,
    createdEpochMs: row.created_epoch_ms,
    created: row.created,
    updatedEpochMs: row.updated_epoch_ms,
    updated: row.updated,
    excerpt: row.excerpt,
    contentHash: row.content_hash,
    public: row.public !== 0,
  };
}
