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
  /** User-defined structured values (`MetricFieldsIndex`), keyed by
   * `fieldKey`, `null` for anything the entry didn't state — never guessed.
   * `detail` stays alongside this, not replaced by it: the field set is a
   * user-curated subset of what could ever be said about a metric, and
   * `detail` is the catch-all for everything else. */
  fields: Record<string, string | number | null>;
  /** When this record was extracted — informational, never used for
   * ordering (that is `eventEpochMs`'s job). */
  extractedAt: string;
}

export interface ListMetricsOptions {
  metric?: string;
  limit: number;
}

/** One calendar day (UTC) within a summary window, and how many times a
 * metric occurred on it — the raw material for a sparkline
 * (`design.md` §5.3), computed here rather than in the frontend
 * (`requirements.md` §7.1: aggregation lives behind the API). */
export interface DayCount {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  count: number;
}

export interface MetricSummary {
  metric: string;
  /** Every occurrence ever recorded, not only within the window. */
  totalCount: number;
  /** Oldest first, one entry per day in the window, zero-filled — a
   * sparkline needs every day present, not only the days something happened. */
  days: DayCount[];
}

/** One calendar day (UTC) within a field's summary window, and the sum of
 * that field's numeric values recorded on it — the numeric analogue of
 * `DayCount` (`plan.md` M9). */
export interface DayValue {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  value: number;
}

export interface MetricFieldSummary {
  total: number;
  average: number;
  /** Records contributing a non-null value — the denominator `average` used. */
  count: number;
  /** Oldest first, one entry per day in the window, zero-filled. */
  days: DayValue[];
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
  summarize(approvedNames: readonly string[], windowDays: number, now?: number): MetricSummary[];
  sumByField(
    metric: string,
    fieldKey: string,
    windowDays: number,
    filter?: { field: string; value: string },
    now?: number,
  ): MetricFieldSummary;
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
        fields TEXT NOT NULL DEFAULT '{}',
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
           (id, entry_id, metric, event_time, event_epoch_ms, event_time_explicit, detail, fields, extracted_at)
         VALUES (@id, @entryId, @metric, @eventTime, @eventEpochMs, @eventTimeExplicit, @detail, @fields, @extractedAt)`,
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
          fields: JSON.stringify(record.fields),
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

  /**
   * The aggregation an analysis surface needs (`plan.md` M8, `design.md`
   * §5.3) — computed here, not in the frontend (`requirements.md` §7.1).
   * One `MetricSummary` per approved name, in the order given, so a metric
   * with zero occurrences still gets its own zero-filled tile rather than
   * silently disappearing.
   */
  summarize(approvedNames: readonly string[], windowDays: number, now: number = Date.now()): MetricSummary[] {
    const windowStart = now - windowDays * 24 * 60 * 60 * 1000;
    const totalStmt = this.#db.prepare('SELECT COUNT(*) AS n FROM temporal_metrics WHERE metric = ?');
    const windowStmt = this.#db.prepare(
      'SELECT event_epoch_ms FROM temporal_metrics WHERE metric = ? AND event_epoch_ms >= ?',
    );

    return approvedNames.map((metric) => {
      const totalCount = (totalStmt.get(metric) as { n: number }).n;
      const rows = windowStmt.all(metric, windowStart) as { event_epoch_ms: number }[];

      const counts = new Map<string, number>();
      for (const row of rows) {
        const day = toUtcDate(row.event_epoch_ms);
        counts.set(day, (counts.get(day) ?? 0) + 1);
      }

      const days: DayCount[] = [];
      for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
        const date = toUtcDate(now - offset * 24 * 60 * 60 * 1000);
        days.push({ date, count: counts.get(date) ?? 0 });
      }

      return { metric, totalCount, days };
    });
  }

  /**
   * The numeric analogue of `summarize()` — day-bucketed sums of one
   * structured field instead of day-bucketed occurrence counts, e.g. "how
   * much rowing have I done" (`plan.md` M9). SQLite's `json_extract` reads
   * the value straight out of the `fields` JSON column with no join and no
   * normalized side table, the same "reads are always every field for this
   * record" reasoning `OpinionSummariesIndex` already applies to its own
   * JSON columns.
   *
   * `filter`, when given, narrows to records where another field on the
   * same metric equals a value — what makes "distance, but only rowing"
   * possible without a bespoke query per combination.
   */
  sumByField(
    metric: string,
    fieldKey: string,
    windowDays: number,
    filter?: { field: string; value: string },
    now: number = Date.now(),
  ): MetricFieldSummary {
    const windowStart = now - windowDays * 24 * 60 * 60 * 1000;
    const path = `$.${fieldKey}`;
    const filterClause = filter ? 'AND json_extract(fields, ?) = ?' : '';
    const filterParams = filter ? [`$.${filter.field}`, filter.value] : [];

    const totals = this.#db
      .prepare(
        `SELECT SUM(json_extract(fields, ?)) AS total, COUNT(json_extract(fields, ?)) AS n
         FROM temporal_metrics WHERE metric = ? ${filterClause}`,
      )
      .get(path, path, metric, ...filterParams) as { total: number | null; n: number };

    const windowRows = this.#db
      .prepare(
        `SELECT event_epoch_ms AS epochMs, json_extract(fields, ?) AS value
         FROM temporal_metrics WHERE metric = ? AND event_epoch_ms >= ? ${filterClause}`,
      )
      .all(path, metric, windowStart, ...filterParams) as { epochMs: number; value: number | null }[];

    const sums = new Map<string, number>();
    for (const row of windowRows) {
      if (row.value === null) continue;
      const day = toUtcDate(row.epochMs);
      sums.set(day, (sums.get(day) ?? 0) + row.value);
    }

    const days: DayValue[] = [];
    for (let offset = windowDays - 1; offset >= 0; offset -= 1) {
      const date = toUtcDate(now - offset * 24 * 60 * 60 * 1000);
      days.push({ date, value: sums.get(date) ?? 0 });
    }

    const total = totals.total ?? 0;
    const count = totals.n;
    return { total, average: count > 0 ? total / count : 0, count, days };
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
  fields: string;
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
    fields: JSON.parse(row.fields) as Record<string, string | number | null>,
    extractedAt: row.extracted_at,
  };
}

/** `YYYY-MM-DD`, UTC — a fixed, deterministic day boundary rather than the
 * server's local timezone, so a sparkline's day buckets never shift
 * depending on where this process happens to run. */
function toUtcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}
