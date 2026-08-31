import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareDescending, isAfterCursor, type Cursor } from '../store/cursor.js';

/**
 * The persistent index for media — a sibling table in the same shared
 * `index.db` `SqliteIndex` already opens, following the established pattern
 * every other structure type uses (`DocumentsIndex`, `ReviewsIndex`, and so
 * on).
 *
 * A cache, exactly as `DocumentsIndex` is for documents: a disposable
 * projection of what the stored files (and their metadata sidecars) already
 * say, rebuildable from `media/` alone (`FsMediaStore`/`S3MediaStore`'s
 * `rebuild()`). Unlike `DocumentsIndex`, `get`/`list` here never re-read the
 * underlying object on every call — a media item is written once and never
 * modified (`requirements.md` §4.6's stance on attachments, applied to the
 * whole library), so there is no "edited outside the app" case for a single
 * known row to catch. Only a full rebuild scan can discover an object added
 * or removed out of band.
 */

export interface MediaIndexRow {
  id: string;
  /** Absolute filesystem path (fs backend) or object key (S3 backend) — see
   * `DocumentIndexRow.absPath`'s identical dual role. */
  absPath: string;
  relPath: string;
  kind: 'image' | 'video';
  contentType: string;
  byteSize: number;
  originalFilename: string;
  width: number | null;
  height: number | null;
  capturedAt: string | null;
  /** `capturedAt`'s first 10 characters (`YYYY-MM-DD`), or `null` when
   * `capturedAt` is — indexed for `listByCapturedDate`. Always recomputed
   * from `capturedAt`, never set independently of it. */
  capturedDate: string | null;
  uploadedAt: string;
  uploadedEpochMs: number;
}

export interface MediaIndexStats {
  mediaCount: number;
  /** Objects that look like a media item but cannot be paired with a
   * readable sidecar. See `HealthResponse`'s equivalent for entries. */
  unreadableCount: number;
}

export interface MediaIndexListResult {
  rows: MediaIndexRow[];
  hasMore: boolean;
}

export class MediaIndex {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS media (
        id TEXT PRIMARY KEY,
        abs_path TEXT NOT NULL UNIQUE,
        rel_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        content_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        original_filename TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        captured_at TEXT,
        captured_date TEXT,
        uploaded_at TEXT NOT NULL,
        uploaded_epoch_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS media_order ON media (uploaded_epoch_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS media_captured_date ON media (captured_date);

      CREATE TABLE IF NOT EXISTS media_unreadable (
        abs_path TEXT PRIMARY KEY
      );
    `);
  }

  /** Every path currently indexed, readable or not — for diffing against a fresh scan. */
  knownPaths(): Set<string> {
    const readable = this.#db.prepare('SELECT abs_path FROM media').all() as { abs_path: string }[];
    const unreadable = this.#db.prepare('SELECT abs_path FROM media_unreadable').all() as {
      abs_path: string;
    }[];
    return new Set([...readable.map((r) => r.abs_path), ...unreadable.map((r) => r.abs_path)]);
  }

  getById(id: string): MediaIndexRow | null {
    const row = this.#db.prepare('SELECT * FROM media WHERE id = ?').get(id) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  /** Insert or update a row, upserting on `abs_path` — the same identity
   * `DocumentsIndex.upsert` keys on. */
  upsert(row: MediaIndexRow): void {
    this.#db
      .prepare(
        `INSERT INTO media (id, abs_path, rel_path, kind, content_type, byte_size, original_filename, width, height, captured_at, captured_date, uploaded_at, uploaded_epoch_ms)
         VALUES (@id, @absPath, @relPath, @kind, @contentType, @byteSize, @originalFilename, @width, @height, @capturedAt, @capturedDate, @uploadedAt, @uploadedEpochMs)
         ON CONFLICT(abs_path) DO UPDATE SET
           id = excluded.id, rel_path = excluded.rel_path, kind = excluded.kind,
           content_type = excluded.content_type, byte_size = excluded.byte_size,
           original_filename = excluded.original_filename, width = excluded.width, height = excluded.height,
           captured_at = excluded.captured_at, captured_date = excluded.captured_date,
           uploaded_at = excluded.uploaded_at, uploaded_epoch_ms = excluded.uploaded_epoch_ms`,
      )
      .run({
        id: row.id,
        absPath: row.absPath,
        relPath: row.relPath,
        kind: row.kind,
        contentType: row.contentType,
        byteSize: row.byteSize,
        originalFilename: row.originalFilename,
        width: row.width,
        height: row.height,
        capturedAt: row.capturedAt,
        capturedDate: row.capturedDate,
        uploadedAt: row.uploadedAt,
        uploadedEpochMs: row.uploadedEpochMs,
      });
    this.#db.prepare('DELETE FROM media_unreadable WHERE abs_path = ?').run(row.absPath);
  }

  /** A binary object found with no readable sidecar — recorded so a rescan
   * does not keep re-fetching it, and so damage is visible in `stats()`
   * rather than silent (`FsMediaStore`/`S3MediaStore`'s `#scan()`). */
  markUnreadable(absPath: string): void {
    this.#db.prepare('DELETE FROM media WHERE abs_path = ?').run(absPath);
    this.#db.prepare('INSERT OR IGNORE INTO media_unreadable (abs_path) VALUES (?)').run(absPath);
  }

  remove(absPath: string): void {
    this.#db.prepare('DELETE FROM media WHERE abs_path = ?').run(absPath);
    this.#db.prepare('DELETE FROM media_unreadable WHERE abs_path = ?').run(absPath);
  }

  /** One page, newest-*uploaded*-first — a library is browsed in upload
   * batches, and `capturedAt` is frequently absent, so it cannot anchor the
   * default ordering the way it anchors `listByCapturedDate`. */
  list(cursor: Cursor | null, limit: number): MediaIndexListResult {
    const rows = (
      cursor
        ? this.#db
            .prepare(
              `SELECT * FROM media
               WHERE (uploaded_epoch_ms < @epochMs OR (uploaded_epoch_ms = @epochMs AND id < @id))
               ORDER BY uploaded_epoch_ms DESC, id DESC
               LIMIT @limit`,
            )
            .all({ epochMs: cursor.epochMs, id: cursor.id, limit: limit + 1 })
        : this.#db
            .prepare(`SELECT * FROM media ORDER BY uploaded_epoch_ms DESC, id DESC LIMIT @limit`)
            .all({ limit: limit + 1 })
    ) as RawRow[];

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(fromRaw);

    // Defence in depth, same reasoning as `DocumentsIndex.list`.
    if (cursor) {
      for (const row of page) {
        if (!isAfterCursor({ epochMs: row.uploadedEpochMs, id: row.id }, cursor)) {
          throw new Error('MediaIndex.list produced a row that does not belong after its cursor.');
        }
      }
    }
    for (let i = 1; i < page.length; i++) {
      const prev = { epochMs: page[i - 1]!.uploadedEpochMs, id: page[i - 1]!.id };
      const curr = { epochMs: page[i]!.uploadedEpochMs, id: page[i]!.id };
      if (compareDescending(prev, curr) <= 0) continue;
      throw new Error('MediaIndex.list returned rows out of order.');
    }

    return { rows: page, hasMore };
  }

  /** Every item whose `capturedDate` is `date` (`YYYY-MM-DD`), earliest
   * time-of-day first — the query behind `GET /entries/:id/media`. A pure
   * lookup against already-cached rows; nothing here calls a model or makes
   * a judgement call the way an extraction candidate would. */
  listByCapturedDate(date: string): MediaIndexRow[] {
    const rows = this.#db
      .prepare('SELECT * FROM media WHERE captured_date = ? ORDER BY captured_at ASC, id ASC')
      .all(date) as RawRow[];
    return rows.map(fromRaw);
  }

  stats(): MediaIndexStats {
    const mediaCount = (this.#db.prepare('SELECT COUNT(*) AS n FROM media').get() as { n: number }).n;
    const unreadableCount = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM media_unreadable').get() as { n: number }
    ).n;
    return { mediaCount, unreadableCount };
  }

  /** Wipe every row — the first step of a media-store rebuild. */
  clear(): void {
    this.#db.exec('DELETE FROM media; DELETE FROM media_unreadable;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  abs_path: string;
  rel_path: string;
  kind: string;
  content_type: string;
  byte_size: number;
  original_filename: string;
  width: number | null;
  height: number | null;
  captured_at: string | null;
  captured_date: string | null;
  uploaded_at: string;
  uploaded_epoch_ms: number;
}

function fromRaw(row: RawRow): MediaIndexRow {
  return {
    id: row.id,
    absPath: row.abs_path,
    relPath: row.rel_path,
    kind: row.kind as 'image' | 'video',
    contentType: row.content_type,
    byteSize: row.byte_size,
    originalFilename: row.original_filename,
    width: row.width,
    height: row.height,
    capturedAt: row.captured_at,
    capturedDate: row.captured_date,
    uploadedAt: row.uploaded_at,
    uploadedEpochMs: row.uploaded_epoch_ms,
  };
}
