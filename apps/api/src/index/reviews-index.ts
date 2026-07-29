import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Extracted reviews (`plan.md` M8, `requirements.md` §5.2) — a table with
 * various fields, treated differently from simple metrics: every encounter
 * with the same title is its own record, never an edit to one existing
 * record, so a rewatch or a reread accumulates rather than overwrites.
 *
 * Same shape as `MetricsIndex`: a fourth table in the same shared
 * `index.db` (`requirements.md` §6.4), every row linking back to the entry
 * it came from, never a source of truth.
 */

export interface ReviewRecord {
  id: string;
  entryId: string;
  title: string;
  medium: string;
  rating: number | null;
  opinion: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  extractedAt: string;
}

export interface ListReviewsOptions {
  medium?: string;
  limit: number;
}

/** The aggregation an analysis surface needs (`plan.md` M8, `design.md`
 * §5.3), computed here rather than in the frontend (`requirements.md`
 * §7.1). `averageRating` is `null` when nothing in the medium has a rating —
 * never coerced to 0, which would read as "rated zero" rather than "no
 * ratings given." */
export interface ReviewMediumSummary {
  medium: string;
  count: number;
  averageRating: number | null;
}

/** Same shape as `MetricsReader` — the seam `http/app.ts` depends on. */
export interface ReviewsReader {
  list(options: ListReviewsOptions): ReviewRecord[];
  remove(id: string): void;
  summarize(approvedMedia: readonly string[]): ReviewMediumSummary[];
}

export class ReviewsIndex implements ReviewsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        title TEXT NOT NULL,
        medium TEXT NOT NULL,
        rating REAL,
        opinion TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        extracted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reviews_entry ON reviews (entry_id);
      CREATE INDEX IF NOT EXISTS reviews_order ON reviews (medium, event_epoch_ms DESC);
    `);
  }

  /** Always the full set for an entry — see `MetricsIndex.replaceEntry` for
   * why a partial update is never the right shape here. */
  replaceEntry(entryId: string, records: Omit<ReviewRecord, 'entryId'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM reviews WHERE entry_id = ?').run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO reviews
           (id, entry_id, title, medium, rating, opinion, event_time, event_epoch_ms, event_time_explicit, extracted_at)
         VALUES (@id, @entryId, @title, @medium, @rating, @opinion, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          title: record.title,
          medium: record.medium,
          rating: record.rating,
          opinion: record.opinion,
          eventTime: record.eventTime,
          eventEpochMs: record.eventEpochMs,
          eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
          extractedAt: record.extractedAt,
        });
      }
    });
    insert();
  }

  removeEntry(entryId: string): void {
    this.#db.prepare('DELETE FROM reviews WHERE entry_id = ?').run(entryId);
  }

  /** Discard one wrong record (`requirements.md` §6.2). */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
  }

  list(options: ListReviewsOptions): ReviewRecord[] {
    const rows = (
      options.medium
        ? this.#db
            .prepare('SELECT * FROM reviews WHERE medium = ? ORDER BY event_epoch_ms DESC LIMIT ?')
            .all(options.medium, options.limit)
        : this.#db.prepare('SELECT * FROM reviews ORDER BY event_epoch_ms DESC LIMIT ?').all(options.limit)
    ) as RawRow[];
    return rows.map(fromRaw);
  }

  /** One `ReviewMediumSummary` per approved medium, in the order given, so a
   * medium with zero reviews still gets its own row rather than silently
   * disappearing. */
  summarize(approvedMedia: readonly string[]): ReviewMediumSummary[] {
    const stmt = this.#db.prepare(
      'SELECT COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE medium = ?',
    );
    return approvedMedia.map((medium) => {
      const row = stmt.get(medium) as { n: number; avg: number | null };
      return { medium, count: row.n, averageRating: row.avg };
    });
  }

  stats(): { reviewCount: number } {
    const reviewCount = (this.#db.prepare('SELECT COUNT(*) AS n FROM reviews').get() as { n: number }).n;
    return { reviewCount };
  }

  clear(): void {
    this.#db.exec('DELETE FROM reviews;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  entry_id: string;
  title: string;
  medium: string;
  rating: number | null;
  opinion: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  extracted_at: string;
}

function fromRaw(row: RawRow): ReviewRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    title: row.title,
    medium: row.medium,
    rating: row.rating,
    opinion: row.opinion,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    extractedAt: row.extracted_at,
  };
}
