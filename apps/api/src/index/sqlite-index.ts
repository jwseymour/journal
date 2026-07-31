import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Coordinates } from '@journal/contract';
import { compareDescending, isAfterCursor, type Cursor } from '../store/cursor.js';

/**
 * The persistent index (`plan.md` M5).
 *
 * Everything here is a cache: a faithful, disposable projection of what the
 * markdown files already say, kept only so `list`/`get`/`stats` do not have
 * to re-read and re-parse the whole journal on every call. **It is never
 * consulted as a source of truth for an entry's content** — `get()` in
 * `fs-entry-store.ts` still reads the file fresh every time, exactly as
 * before M5. This file only ever answers "where is entry X" and "what
 * belongs on a list page," never "what does entry X say."
 *
 * `rebuild()` deletes every row and re-derives them all from a fresh set of
 * parsed files — the whole point of a cache, proven rather than assumed
 * (`requirements.md` §6.4). Nothing here can be a permanent record of
 * anything: delete the file this wraps and the application loses nothing
 * that a fresh scan of the journal directory cannot reproduce.
 */

export interface IndexRow {
  id: string;
  /** Absolute filesystem path — the join key against a fresh directory walk. */
  absPath: string;
  /** Journal-root-relative, POSIX separators — what the API returns. */
  relPath: string;
  epochMs: number;
  /** Canonical RFC 3339, exactly as `Entry.created` should read. */
  created: string;
  location?: Coordinates;
  excerpt: string;
  /** The fingerprint this row was built from — how a rescan decides whether
   * a known file needs re-parsing (`plan.md` M5: "content hash, never mtime" —
   * mtime does not survive `cp -r` or `git checkout`, this project's own
   * backup and restore story). */
  contentHash: string;
}

export interface IndexStats {
  entryCount: number;
  unreadableCount: number;
}

export interface IndexListResult {
  rows: IndexRow[];
  hasMore: boolean;
}

export interface IndexPeriod {
  year: number;
  month: number;
}

export class SqliteIndex {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        abs_path TEXT NOT NULL UNIQUE,
        rel_path TEXT NOT NULL,
        epoch_ms INTEGER NOT NULL,
        created TEXT NOT NULL,
        lat REAL,
        lon REAL,
        excerpt TEXT NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_order ON entries (epoch_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS entries_period ON entries (substr(created, 1, 7));

      CREATE TABLE IF NOT EXISTS unreadable (
        abs_path TEXT PRIMARY KEY
      );
    `);
  }

  /** Every path currently indexed, readable or not — for diffing against a
   * fresh directory walk to find what has appeared or vanished. */
  knownPaths(): Set<string> {
    const readable = this.#db.prepare('SELECT abs_path FROM entries').all() as { abs_path: string }[];
    const unreadable = this.#db.prepare('SELECT abs_path FROM unreadable').all() as { abs_path: string }[];
    return new Set([...readable.map((r) => r.abs_path), ...unreadable.map((r) => r.abs_path)]);
  }

  getByPath(absPath: string): IndexRow | null {
    const row = this.#db.prepare('SELECT * FROM entries WHERE abs_path = ?').get(absPath) as
      | RawRow
      | undefined;
    return row ? fromRaw(row) : null;
  }

  getById(id: string): IndexRow | null {
    const row = this.#db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  isUnreadable(absPath: string): boolean {
    return this.#db.prepare('SELECT 1 FROM unreadable WHERE abs_path = ?').get(absPath) !== undefined;
  }

  /**
   * Insert or update a row. `absPath` is the identity this upserts on — an
   * edit never changes a file's path, so this correctly overwrites the same
   * row in place rather than ever duplicating it.
   */
  upsert(row: IndexRow): void {
    this.#db
      .prepare(
        `INSERT INTO entries (id, abs_path, rel_path, epoch_ms, created, lat, lon, excerpt, content_hash)
         VALUES (@id, @absPath, @relPath, @epochMs, @created, @lat, @lon, @excerpt, @contentHash)
         ON CONFLICT(abs_path) DO UPDATE SET
           id = excluded.id, rel_path = excluded.rel_path, epoch_ms = excluded.epoch_ms,
           created = excluded.created, lat = excluded.lat, lon = excluded.lon,
           excerpt = excluded.excerpt, content_hash = excluded.content_hash`,
      )
      .run({
        id: row.id,
        absPath: row.absPath,
        relPath: row.relPath,
        epochMs: row.epochMs,
        created: row.created,
        lat: row.location?.lat ?? null,
        lon: row.location?.lon ?? null,
        excerpt: row.excerpt,
        contentHash: row.contentHash,
      });
    this.#db.prepare('DELETE FROM unreadable WHERE abs_path = ?').run(row.absPath);
  }

  markUnreadable(absPath: string): void {
    this.#db.prepare('DELETE FROM entries WHERE abs_path = ?').run(absPath);
    this.#db.prepare('INSERT OR IGNORE INTO unreadable (abs_path) VALUES (?)').run(absPath);
  }

  /** A path that has vanished from disk — readable or not, it is gone either way. */
  remove(absPath: string): void {
    this.#db.prepare('DELETE FROM entries WHERE abs_path = ?').run(absPath);
    this.#db.prepare('DELETE FROM unreadable WHERE abs_path = ?').run(absPath);
  }

  /**
   * One page, newest first — the same keyset ordering `store/cursor.ts`
   * defines, expressed as SQL instead of an array scan. `limit + 1` rows are
   * fetched so "is there another page" is answered without a second query.
   *
   * `period`, if given, restricts the page to one calendar month (local to
   * the entry, per `created` — the same `YYYY-MM` grouping the on-disk
   * `journal/YYYY/MM/` layout already uses).
   */
  list(cursor: Cursor | null, limit: number, period?: IndexPeriod): IndexListResult {
    const yearMonth = period ? `${String(period.year).padStart(4, '0')}-${String(period.month).padStart(2, '0')}` : null;

    const rows = (
      cursor
        ? this.#db
            .prepare(
              `SELECT * FROM entries
               WHERE (epoch_ms < @epochMs OR (epoch_ms = @epochMs AND id < @id))
                 AND (@yearMonth IS NULL OR substr(created, 1, 7) = @yearMonth)
               ORDER BY epoch_ms DESC, id DESC
               LIMIT @limit`,
            )
            .all({ epochMs: cursor.epochMs, id: cursor.id, yearMonth, limit: limit + 1 })
        : this.#db
            .prepare(
              `SELECT * FROM entries
               WHERE @yearMonth IS NULL OR substr(created, 1, 7) = @yearMonth
               ORDER BY epoch_ms DESC, id DESC
               LIMIT @limit`,
            )
            .all({ yearMonth, limit: limit + 1 })
    ) as RawRow[];

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(fromRaw);

    // Defence in depth: the SQL WHERE clause already matches
    // `isAfterCursor`'s definition, but re-checking with the same shared
    // function is what guarantees the two can never quietly drift apart.
    if (cursor) {
      for (const row of page) {
        if (!isAfterCursor(row, cursor)) {
          throw new Error('SqliteIndex.list produced a row that does not belong after its cursor.');
        }
      }
    }
    // `Array.sort`-style semantics: negative means the first argument sorts
    // before the second. A correctly descending-ordered page therefore has
    // `compareDescending(earlier, later) <= 0` at every adjacent pair.
    for (let i = 1; i < page.length; i++) {
      if (compareDescending(page[i - 1]!, page[i]!) <= 0) continue;
      throw new Error('SqliteIndex.list returned rows out of order.');
    }

    return { rows: page, hasMore };
  }

  /** Every distinct year+month that has at least one entry, newest first. */
  listPeriods(): IndexPeriod[] {
    const rows = this.#db
      .prepare(
        `SELECT DISTINCT CAST(substr(created, 1, 4) AS INTEGER) AS year,
                CAST(substr(created, 6, 2) AS INTEGER) AS month
         FROM entries
         ORDER BY year DESC, month DESC`,
      )
      .all() as IndexPeriod[];
    return rows;
  }

  stats(): IndexStats {
    const entryCount = (this.#db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n;
    const unreadableCount = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM unreadable').get() as { n: number }
    ).n;
    return { entryCount, unreadableCount };
  }

  /** Wipe every row. The first step of `rebuild --from-scratch`
   * (`requirements.md` §6.4) — everything after this is a fresh derivation. */
  clear(): void {
    this.#db.exec('DELETE FROM entries; DELETE FROM unreadable;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  abs_path: string;
  rel_path: string;
  epoch_ms: number;
  created: string;
  lat: number | null;
  lon: number | null;
  excerpt: string;
  content_hash: string;
}

function fromRaw(row: RawRow): IndexRow {
  return {
    id: row.id,
    absPath: row.abs_path,
    relPath: row.rel_path,
    epochMs: row.epoch_ms,
    created: row.created,
    ...(row.lat !== null && row.lon !== null ? { location: { lat: row.lat, lon: row.lon } } : {}),
    excerpt: row.excerpt,
    contentHash: row.content_hash,
  };
}
