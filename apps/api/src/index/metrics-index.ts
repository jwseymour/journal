import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Extracted temporal metrics (`plan.md` M7) — a third derived table living
 * in the same database file as `SqliteIndex` and `SearchIndex`, for the same
 * reason both of those do: the whole derived layer stays one deletable
 * artefact (`requirements.md` §6.4).
 *
 * Every row links back to the entry it came from (`requirements.md` §3) and
 * nothing here is ever treated as a source of truth — deleting this file
 * loses nothing that re-running extraction over the journal cannot
 * reproduce.
 */

export interface TemporalMetricRecord {
  /** Its own identity — a ULID, so `DELETE /metrics/:id` (the correction
   * path `requirements.md` §6.2 requires) has something stable to name,
   * independent of the entry it was extracted from. */
  id: string;
  entryId: string;
  metric: string;
  /** RFC 3339, canonical — when the thing actually happened. */
  eventTime: string;
  eventEpochMs: number;
  /** Whether the entry itself stated a time, or this was defaulted to the
   * entry's own written time (`requirements.md` §6.3). */
  eventTimeExplicit: boolean;
  detail: string;
  /** When this record was extracted — informational, never used for
   * ordering (that is `eventEpochMs`'s job). */
  extractedAt: string;
}

export interface ListMetricsOptions {
  metric?: string;
  limit: number;
}

/**
 * The seam `http/app.ts` depends on — same shape as `Searcher`: the route
 * knows nothing about SQLite, only that a list comes back and a record can
 * be discarded by id (`requirements.md` §6.2). `MetricsIndex` is the one
 * real implementation, but a plain interface (rather than the class itself)
 * is what lets an HTTP test fake it, the same way `FakeSearcher` does for
 * `Searcher`.
 */
export interface MetricsReader {
  list(options: ListMetricsOptions): TemporalMetricRecord[];
  remove(id: string): void;
}

export class MetricsIndex implements MetricsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS temporal_metrics (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        metric TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        detail TEXT NOT NULL,
        extracted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS temporal_metrics_entry ON temporal_metrics (entry_id);
      CREATE INDEX IF NOT EXISTS temporal_metrics_order ON temporal_metrics (metric, event_epoch_ms DESC);
    `);
  }

  /**
   * Replaces every record belonging to `entryId` with `records` — always the
   * full set for that entry, never a partial update, the same reasoning as
   * `SearchIndex.replaceEntry`: an edit can change what an entry says
   * without there being a cheap way to tell old records from new ones.
   *
   * Takes fully-formed rows, `id` and `extractedAt` included — the same
   * division of labour as `SqliteIndex.upsert`: this class stores what it is
   * given, and generating an id or reading the clock is the caller's job,
   * not something to inject as a dependency here.
   */
  replaceEntry(entryId: string, records: Omit<TemporalMetricRecord, 'entryId'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM temporal_metrics WHERE entry_id = ?').run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO temporal_metrics
           (id, entry_id, metric, event_time, event_epoch_ms, event_time_explicit, detail, extracted_at)
         VALUES (@id, @entryId, @metric, @eventTime, @eventEpochMs, @eventTimeExplicit, @detail, @extractedAt)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          metric: record.metric,
          eventTime: record.eventTime,
          eventEpochMs: record.eventEpochMs,
          eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
          detail: record.detail,
          extractedAt: record.extractedAt,
        });
      }
    });
    insert();
  }

  removeEntry(entryId: string): void {
    this.#db.prepare('DELETE FROM temporal_metrics WHERE entry_id = ?').run(entryId);
  }

  /** Discard one wrong record (`requirements.md` §6.2 — mistakes must be
   * easy to fix). A no-op, not an error, if it is already gone — the same
   * tolerance `EntryStore.discardIfBlank` has. */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM temporal_metrics WHERE id = ?').run(id);
  }

  list(options: ListMetricsOptions): TemporalMetricRecord[] {
    const rows = (
      options.metric
        ? this.#db
            .prepare(
              `SELECT * FROM temporal_metrics WHERE metric = ?
               ORDER BY event_epoch_ms DESC LIMIT ?`,
            )
            .all(options.metric, options.limit)
        : this.#db
            .prepare('SELECT * FROM temporal_metrics ORDER BY event_epoch_ms DESC LIMIT ?')
            .all(options.limit)
    ) as RawRow[];
    return rows.map(fromRaw);
  }

  stats(): { metricCount: number } {
    const metricCount = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM temporal_metrics').get() as { n: number }
    ).n;
    return { metricCount };
  }

  /** Wipe every row — the first step of a reprocess-from-scratch
   * (`requirements.md` §6.4), mirroring `SqliteIndex.clear()`. */
  clear(): void {
    this.#db.exec('DELETE FROM temporal_metrics;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  entry_id: string;
  metric: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  detail: string;
  extracted_at: string;
}

function fromRaw(row: RawRow): TemporalMetricRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    metric: row.metric,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    detail: row.detail,
    extractedAt: row.extracted_at,
  };
}
