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
  progress: number | null;
  opinion: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  extractedAt: string;
  /** Whether the user has reviewed, corrected, or edited this record
   * (`requirements.md` §2, §6.4, `plan.md` M10). */
  touched: boolean;
}

export interface ListReviewsOptions {
  medium?: string;
  limit: number;
}

/** The editable subset — everything except `id`, `entryId`, `medium` (an
 * approved category, not free content), and `touched` itself (`plan.md`
 * M10). */
export interface UpdateReviewInput {
  // See `UpdateMetricInput`'s comment for why `| undefined` is explicit.
  title?: string | undefined;
  rating?: number | null | undefined;
  progress?: number | null | undefined;
  opinion?: string | undefined;
  eventTime?: string | undefined;
  eventTimeExplicit?: boolean | undefined;
}

export interface ReviewUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  title: string;
  rating: number | null;
  progress: number | null;
  opinion: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
  decidedAt: string | null;
}

export type ProposeReviewUpdateInput = Omit<ReviewUpdateSuggestion, 'id' | 'status' | 'suggestedAt' | 'decidedAt'> & {
  id: string;
  now: string;
};

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
  /** One record by id, or `null` — see `MetricsReader.getById` (`plan.md` M16). */
  getById(id: string): ReviewRecord | null;
  /** Every record for one medium, unbounded — see `MetricsReader.allByMetric` (`plan.md` M16). */
  allByMedium(medium: string): ReviewRecord[];
  remove(id: string): void;
  summarize(approvedMedia: readonly string[]): ReviewMediumSummary[];
  update(id: string, input: UpdateReviewInput, now: string): ReviewRecord | null;
  validate(id: string, now: string): void;
  untouch(id: string, now: string): void;
  listUpdateSuggestions(options?: { status?: ReviewUpdateSuggestion['status'] }): ReviewUpdateSuggestion[];
  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void;
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
        progress REAL,
        opinion TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        extracted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reviews_entry ON reviews (entry_id);
      CREATE INDEX IF NOT EXISTS reviews_order ON reviews (medium, event_epoch_ms DESC);

      CREATE TABLE IF NOT EXISTS review_update_suggestions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        title TEXT NOT NULL,
        rating REAL,
        progress REAL,
        opinion TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        suggested_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS review_update_suggestions_status ON review_update_suggestions (status);
    `);

    const columns = this.#db.prepare('PRAGMA table_info(reviews)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'touched')) {
      this.#db.exec('ALTER TABLE reviews ADD COLUMN touched INTEGER NOT NULL DEFAULT 0;');
    }
  }

  /** Always the full set for an entry — see `MetricsIndex.replaceEntry` for
   * why a partial update is never the right shape here. */
  replaceEntry(entryId: string, records: Omit<ReviewRecord, 'entryId'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM reviews WHERE entry_id = ?').run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO reviews
           (id, entry_id, title, medium, rating, progress, opinion, event_time, event_epoch_ms, event_time_explicit, extracted_at)
         VALUES (@id, @entryId, @title, @medium, @rating, @progress, @opinion, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          title: record.title,
          medium: record.medium,
          rating: record.rating,
          progress: record.progress,
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

  /** The reprocess-safe sibling of `replaceEntry` (`plan.md` M10) — only
   * touched=0 rows for this entry are replaced. */
  replaceUntouchedForEntry(entryId: string, records: Omit<ReviewRecord, 'entryId' | 'touched'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM reviews WHERE entry_id = ? AND touched = 0').run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO reviews
           (id, entry_id, title, medium, rating, progress, opinion, event_time, event_epoch_ms, event_time_explicit, extracted_at, touched)
         VALUES (@id, @entryId, @title, @medium, @rating, @progress, @opinion, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, 0)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          title: record.title,
          medium: record.medium,
          rating: record.rating,
          progress: record.progress,
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

  touchedForEntry(entryId: string): ReviewRecord[] {
    const rows = this.#db.prepare('SELECT * FROM reviews WHERE entry_id = ? AND touched = 1').all(entryId) as RawRow[];
    return rows.map(fromRaw);
  }

  removeEntry(entryId: string): void {
    this.#db.prepare('DELETE FROM reviews WHERE entry_id = ?').run(entryId);
  }

  getById(id: string): ReviewRecord | null {
    const row = this.#db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  allByMedium(medium: string): ReviewRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM reviews WHERE medium = ? ORDER BY event_epoch_ms DESC')
      .all(medium) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Discard one wrong record (`requirements.md` §6.2). */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
  }

  update(id: string, input: UpdateReviewInput, _now: string): ReviewRecord | null {
    const existing = this.#db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as RawRow | undefined;
    if (!existing) return null;

    const eventTimeExplicit = input.eventTimeExplicit ?? existing.event_time_explicit === 1;
    const next: RawRow = {
      ...existing,
      title: input.title ?? existing.title,
      rating: input.rating === undefined ? existing.rating : input.rating,
      progress: input.progress === undefined ? existing.progress : input.progress,
      opinion: input.opinion ?? existing.opinion,
      event_time: input.eventTime ?? existing.event_time,
      event_epoch_ms: input.eventTime ? Date.parse(input.eventTime) : existing.event_epoch_ms,
      event_time_explicit: eventTimeExplicit ? 1 : 0,
      touched: 1,
    };
    this.#db
      .prepare(
        `UPDATE reviews
           SET title = @title, rating = @rating, progress = @progress, opinion = @opinion,
               event_time = @event_time, event_epoch_ms = @event_epoch_ms,
               event_time_explicit = @event_time_explicit, touched = 1
         WHERE id = @id`,
      )
      .run(next);
    return fromRaw(next);
  }

  validate(id: string, _now: string): void {
    this.#db.prepare('UPDATE reviews SET touched = 1 WHERE id = ?').run(id);
  }

  untouch(id: string, _now: string): void {
    this.#db.prepare('UPDATE reviews SET touched = 0 WHERE id = ?').run(id);
  }

  proposeUpdate(input: ProposeReviewUpdateInput): void {
    const alreadyPending = this.#db
      .prepare("SELECT 1 FROM review_update_suggestions WHERE record_id = ? AND status = 'pending'")
      .get(input.recordId);
    if (alreadyPending) return;

    this.#db
      .prepare(
        `INSERT INTO review_update_suggestions
           (id, record_id, entry_id, title, rating, progress, opinion, event_time, event_epoch_ms, event_time_explicit, reason, status, suggested_at, decided_at)
         VALUES (@id, @recordId, @entryId, @title, @rating, @progress, @opinion, @eventTime, @eventEpochMs, @eventTimeExplicit, @reason, 'pending', @now, NULL)`,
      )
      .run({ ...input, eventTimeExplicit: input.eventTimeExplicit ? 1 : 0 });
  }

  listUpdateSuggestions(options: { status?: ReviewUpdateSuggestion['status'] } = {}): ReviewUpdateSuggestion[] {
    const rows = (
      options.status
        ? this.#db
            .prepare('SELECT * FROM review_update_suggestions WHERE status = ? ORDER BY suggested_at DESC')
            .all(options.status)
        : this.#db.prepare('SELECT * FROM review_update_suggestions ORDER BY suggested_at DESC').all()
    ) as RawSuggestionRow[];
    return rows.map(suggestionFromRaw);
  }

  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void {
    const apply = this.#db.transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM review_update_suggestions WHERE id = ? AND status = 'pending'")
        .get(id) as RawSuggestionRow | undefined;
      if (!row) return;

      this.#db
        .prepare('UPDATE review_update_suggestions SET status = ?, decided_at = ? WHERE id = ?')
        .run(decision, now, id);

      if (decision === 'approved') {
        this.update(row.record_id, {
          title: row.title,
          rating: row.rating,
          progress: row.progress,
          opinion: row.opinion,
          eventTime: row.event_time,
          eventTimeExplicit: row.event_time_explicit === 1,
        }, now);
      }
    });
    apply();
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

  /** Reprocess-from-scratch entry point since M10 (`requirements.md` §6.4) —
   * wipes only untouched rows. */
  clearUntouched(): void {
    this.#db.exec('DELETE FROM reviews WHERE touched = 0;');
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
  progress: number | null;
  opinion: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  extracted_at: string;
  touched: number;
}

function fromRaw(row: RawRow): ReviewRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    title: row.title,
    medium: row.medium,
    rating: row.rating,
    progress: row.progress,
    opinion: row.opinion,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    extractedAt: row.extracted_at,
    touched: row.touched === 1,
  };
}

interface RawSuggestionRow {
  id: string;
  record_id: string;
  entry_id: string;
  title: string;
  rating: number | null;
  progress: number | null;
  opinion: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  reason: string;
  status: ReviewUpdateSuggestion['status'];
  suggested_at: string;
  decided_at: string | null;
}

function suggestionFromRaw(row: RawSuggestionRow): ReviewUpdateSuggestion {
  return {
    id: row.id,
    recordId: row.record_id,
    entryId: row.entry_id,
    title: row.title,
    rating: row.rating,
    progress: row.progress,
    opinion: row.opinion,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    reason: row.reason,
    status: row.status,
    suggestedAt: row.suggested_at,
    decidedAt: row.decided_at,
  };
}
