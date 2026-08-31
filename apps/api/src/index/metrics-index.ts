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
  /** Whether the user has reviewed, corrected, or edited this record
   * (`requirements.md` §2, §6.4, `plan.md` M10). Once `true`, a reprocess
   * never overwrites it — at most it proposes an update. `false` records
   * remain a pure, disposable function of the entry. */
  touched: boolean;
}

/** The editable subset of a metric record — everything except `id`,
 * `entryId`, and `touched` itself, which are identity/provenance, not
 * content (`plan.md` M10). */
export interface UpdateMetricInput {
  // `| undefined` throughout, not just `?:` — a Zod-parsed request body types
  // an absent optional field as `T | undefined`, which `exactOptionalPropertyTypes`
  // treats as distinct from the key being absent. Both mean the same thing to
  // `update()` below, which reads every field through `??`.
  detail?: string | undefined;
  fields?: Record<string, string | number | null> | undefined;
  eventTime?: string | undefined;
  eventTimeExplicit?: boolean | undefined;
}

/** An AI-proposed update to a record the user has already touched
 * (`plan.md` M10) — never applied automatically, only ever offered, exactly
 * like `MetricFieldSuggestion` but proposing a change to an existing record
 * rather than a new field. */
export interface MetricUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  detail: string;
  fields: Record<string, string | number | null>;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
  decidedAt: string | null;
}

export type ProposeMetricUpdateInput = Omit<MetricUpdateSuggestion, 'id' | 'status' | 'suggestedAt' | 'decidedAt'> & {
  id: string;
  now: string;
};

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
  /** One record by id, or `null` — the lookup `Publisher` needs to render a
   * public snapshot (`plan.md` M16). Unlike `list`, never paginated or
   * filtered: a publish action names exactly one record. */
  getById(id: string): TemporalMetricRecord | null;
  /** Every record for one metric, unbounded — what `/publish-queue`
   * (`plan.md` M16) checks against `VisibilityDefaultsIndex`. Same
   * unbounded-read shape as `OpinionStatementsIndex.bySubject`. */
  allByMetric(metric: string): TemporalMetricRecord[];
  remove(id: string): void;
  summarize(approvedNames: readonly string[], windowDays: number, now?: number): MetricSummary[];
  sumByField(
    metric: string,
    fieldKey: string,
    windowDays: number,
    filter?: { field: string; value: string },
    now?: number,
  ): MetricFieldSummary;
  /** Edits content and marks the record touched (`plan.md` M10). `null` if
   * `id` does not exist — unlike `remove`, a dropped edit is not a harmless
   * no-op, so the caller (`http/app.ts`) turns this into a 404. */
  update(id: string, input: UpdateMetricInput, now: string): TemporalMetricRecord | null;
  /** Marks a record touched with no content change — "I checked this, it's
   * correct" (`requirements.md` §2). Tolerant no-op if `id` is gone. */
  validate(id: string, now: string): void;
  /** Reverts a record to untouched/AI-owned (`requirements.md` §6.2 —
   * correctability applies to touching too). Tolerant no-op if `id` is gone. */
  untouch(id: string, now: string): void;
  listUpdateSuggestions(options?: { status?: MetricUpdateSuggestion['status'] }): MetricUpdateSuggestion[];
  /** Approving applies the suggestion's own fields via `update()`, staying
   * touched — approving is itself a review act. Rejecting leaves the touched
   * record exactly as it was. No-op if `id` is not a pending suggestion. */
  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void;
  /** Every current row for one entry, touched or not (`plan.md` M18) — see
   * the concrete class for why this differs from `touchedForEntry`. */
  liveForEntry(entryId: string): TemporalMetricRecord[];
  /** Commits an approved `'new'` pending item as a real record (`plan.md`
   * M18) — see the concrete class for the full reasoning. */
  insertApproved(record: TemporalMetricRecord): void;
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

      CREATE TABLE IF NOT EXISTS metric_update_suggestions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        detail TEXT NOT NULL,
        fields TEXT NOT NULL DEFAULT '{}',
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        suggested_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS metric_update_suggestions_status ON metric_update_suggestions (status);
    `);

    // `touched` (`plan.md` M10) — added after the table above already
    // shipped, so it cannot simply be part of the `CREATE TABLE`: existing
    // databases need it added in place, once, the same idempotent-migration
    // shape `SqliteIndex` already uses elsewhere.
    const columns = this.#db.prepare('PRAGMA table_info(temporal_metrics)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'touched')) {
      this.#db.exec('ALTER TABLE temporal_metrics ADD COLUMN touched INTEGER NOT NULL DEFAULT 0;');
    }
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

  /** The reprocess-safe sibling of `replaceEntry` (`plan.md` M10): deletes
   * and reinserts only the still-untouched rows for this entry, leaving any
   * touched row exactly as it is. Used by `Extractor.reprocessAll` instead
   * of `replaceEntry`; `replaceEntry` itself is unchanged, since a brand-new
   * entry never has existing rows either way. */
  replaceUntouchedForEntry(entryId: string, records: Omit<TemporalMetricRecord, 'entryId' | 'touched'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM temporal_metrics WHERE entry_id = ? AND touched = 0').run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO temporal_metrics
           (id, entry_id, metric, event_time, event_epoch_ms, event_time_explicit, detail, fields, extracted_at, touched)
         VALUES (@id, @entryId, @metric, @eventTime, @eventEpochMs, @eventTimeExplicit, @detail, @fields, @extractedAt, 0)`,
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

  /** Every currently touched row for one entry — what a reprocess pass
   * compares fresh extraction against before deciding whether to propose an
   * update (`plan.md` M10). */
  touchedForEntry(entryId: string): TemporalMetricRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM temporal_metrics WHERE entry_id = ? AND touched = 1')
      .all(entryId) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Every current row for one entry, touched or not — the live-diff
   * counterpart to `touchedForEntry` (`plan.md` M18). The live pending-item
   * processor compares fresh candidates against this, not just the touched
   * half of it: a record already approved through the popup but never
   * individually touched must not be re-proposed as a duplicate `'new'`
   * item the next time the entry is processed. */
  liveForEntry(entryId: string): TemporalMetricRecord[] {
    const rows = this.#db.prepare('SELECT * FROM temporal_metrics WHERE entry_id = ?').all(entryId) as RawRow[];
    return rows.map(fromRaw);
  }

  removeEntry(entryId: string): void {
    this.#db.prepare('DELETE FROM temporal_metrics WHERE entry_id = ?').run(entryId);
  }

  getById(id: string): TemporalMetricRecord | null {
    const row = this.#db.prepare('SELECT * FROM temporal_metrics WHERE id = ?').get(id) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  allByMetric(metric: string): TemporalMetricRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM temporal_metrics WHERE metric = ? ORDER BY event_epoch_ms DESC')
      .all(metric) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Discard one wrong record (`requirements.md` §6.2 — mistakes must be
   * easy to fix). A no-op, not an error, if it is already gone — the same
   * tolerance `EntryStore.discardIfBlank` has. */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM temporal_metrics WHERE id = ?').run(id);
  }

  /** Edits content and marks the record touched (`requirements.md` §2). Only
   * the fields present in `input` change; everything else is left as
   * stored. `null` if `id` does not exist. */
  // `now` is unused here — `extractedAt` is provenance of the original
  // extraction, not of this edit, and is left exactly as stored.
  update(id: string, input: UpdateMetricInput, _now: string): TemporalMetricRecord | null {
    const existing = this.#db.prepare('SELECT * FROM temporal_metrics WHERE id = ?').get(id) as RawRow | undefined;
    if (!existing) return null;

    const eventTimeExplicit = input.eventTimeExplicit ?? existing.event_time_explicit === 1;
    const next: RawRow = {
      ...existing,
      detail: input.detail ?? existing.detail,
      fields: input.fields ? JSON.stringify(input.fields) : existing.fields,
      event_time: input.eventTime ?? existing.event_time,
      event_epoch_ms: input.eventTime ? Date.parse(input.eventTime) : existing.event_epoch_ms,
      event_time_explicit: eventTimeExplicit ? 1 : 0,
      touched: 1,
    };
    this.#db
      .prepare(
        `UPDATE temporal_metrics
           SET detail = @detail, fields = @fields, event_time = @event_time,
               event_epoch_ms = @event_epoch_ms, event_time_explicit = @event_time_explicit, touched = 1
         WHERE id = @id`,
      )
      .run(next);
    return fromRaw(next);
  }

  /** Marks a record touched with no content change (`requirements.md` §2 —
   * "making sure it is all correct"). Tolerant no-op if `id` is gone. */
  validate(id: string, _now: string): void {
    this.#db.prepare('UPDATE temporal_metrics SET touched = 1 WHERE id = ?').run(id);
  }

  /** Reverts a record to untouched/AI-owned (`requirements.md` §6.2).
   * Tolerant no-op if `id` is gone. */
  untouch(id: string, _now: string): void {
    this.#db.prepare('UPDATE temporal_metrics SET touched = 0 WHERE id = ?').run(id);
  }

  /** Records that the fresh extraction for `entryId` would now produce
   * something different from a touched record — never applied automatically
   * (`plan.md` M10). A no-op if this exact record already has a pending
   * suggestion, the same double-check `MetricFieldsIndex.suggest` does. */
  proposeUpdate(input: ProposeMetricUpdateInput): void {
    const alreadyPending = this.#db
      .prepare("SELECT 1 FROM metric_update_suggestions WHERE record_id = ? AND status = 'pending'")
      .get(input.recordId);
    if (alreadyPending) return;

    this.#db
      .prepare(
        `INSERT INTO metric_update_suggestions
           (id, record_id, entry_id, detail, fields, event_time, event_epoch_ms, event_time_explicit, reason, status, suggested_at, decided_at)
         VALUES (@id, @recordId, @entryId, @detail, @fields, @eventTime, @eventEpochMs, @eventTimeExplicit, @reason, 'pending', @now, NULL)`,
      )
      .run({ ...input, fields: JSON.stringify(input.fields), eventTimeExplicit: input.eventTimeExplicit ? 1 : 0 });
  }

  listUpdateSuggestions(options: { status?: MetricUpdateSuggestion['status'] } = {}): MetricUpdateSuggestion[] {
    const rows = (
      options.status
        ? this.#db
            .prepare('SELECT * FROM metric_update_suggestions WHERE status = ? ORDER BY suggested_at DESC')
            .all(options.status)
        : this.#db.prepare('SELECT * FROM metric_update_suggestions ORDER BY suggested_at DESC').all()
    ) as RawSuggestionRow[];
    return rows.map(suggestionFromRaw);
  }

  /** Approving applies the suggestion's own fields via `update()`
   * (staying touched — approving is itself a review act); rejecting leaves
   * the touched record exactly as it was. No-op if `id` is not pending. */
  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void {
    const apply = this.#db.transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM metric_update_suggestions WHERE id = ? AND status = 'pending'")
        .get(id) as RawSuggestionRow | undefined;
      if (!row) return;

      this.#db
        .prepare('UPDATE metric_update_suggestions SET status = ?, decided_at = ? WHERE id = ?')
        .run(decision, now, id);

      if (decision === 'approved') {
        this.update(row.record_id, {
          detail: row.detail,
          fields: JSON.parse(row.fields) as Record<string, string | number | null>,
          eventTime: row.event_time,
          eventTimeExplicit: row.event_time_explicit === 1,
        }, now);
      }
    });
    apply();
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

  /** Commits an approved `'new'` pending item (`plan.md` M18,
   * `model/pending-item-applier.ts`) as a real, queryable record — at
   * whatever `touched` value it is given, which is always `false` for a
   * batch-approved item: approving in the popup means "this is now real,"
   * not "I individually verified this fact" (confirmed with the user at
   * M18's planning). Deliberately a distinct method from `restoreTouched`
   * below rather than a repurposing of it — that method's contract ("always
   * touched, only ever called from durable-mirror recovery") stays a
   * meaningful, undiluted invariant this way. */
  insertApproved(record: TemporalMetricRecord): void {
    this.#db
      .prepare(
        `INSERT INTO temporal_metrics
           (id, entry_id, metric, event_time, event_epoch_ms, event_time_explicit, detail, fields, extracted_at, touched)
         VALUES (@id, @entryId, @metric, @eventTime, @eventEpochMs, @eventTimeExplicit, @detail, @fields, @extractedAt, @touched)`,
      )
      .run({
        id: record.id,
        entryId: record.entryId,
        metric: record.metric,
        eventTime: record.eventTime,
        eventEpochMs: record.eventEpochMs,
        eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
        detail: record.detail,
        fields: JSON.stringify(record.fields),
        extractedAt: record.extractedAt,
        touched: record.touched ? 1 : 0,
      });
  }

  /** Restores one touched record read back from the durable off-index
   * mirror (`durable/touched-mirror.ts`) into a freshly rebuilt index — the
   * recovery path for `requirements.md` §6.4's guarantee that touched data
   * is never lost, proven the same way `EntryStore.rebuild()` proves it for
   * entries. Always writes `touched = 1`: nothing is ever mirrored there
   * unless it already was. `INSERT OR REPLACE` rather than a guarded insert
   * because `rebuild.ts` calls this against a table that is sometimes
   * genuinely empty and sometimes not (`npm run rebuild` never clears these
   * tables itself — see that file), so either outcome must be safe. */
  restoreTouched(record: TemporalMetricRecord): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO temporal_metrics
           (id, entry_id, metric, event_time, event_epoch_ms, event_time_explicit, detail, fields, extracted_at, touched)
         VALUES (@id, @entryId, @metric, @eventTime, @eventEpochMs, @eventTimeExplicit, @detail, @fields, @extractedAt, 1)`,
      )
      .run({
        id: record.id,
        entryId: record.entryId,
        metric: record.metric,
        eventTime: record.eventTime,
        eventEpochMs: record.eventEpochMs,
        eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
        detail: record.detail,
        fields: JSON.stringify(record.fields),
        extractedAt: record.extractedAt,
      });
  }

  /** Wipe every row, touched or not. Kept as the literal full-wipe primitive
   * it always was; `reprocessAll` no longer calls this directly — see
   * `clearUntouched` (`plan.md` M10). */
  clear(): void {
    this.#db.exec('DELETE FROM temporal_metrics;');
  }

  /** The reprocess-from-scratch entry point since M10: wipes only untouched
   * rows, so a from-scratch reprocess can never regenerate away a record the
   * user has reviewed or edited (`requirements.md` §6.4). */
  clearUntouched(): void {
    this.#db.exec('DELETE FROM temporal_metrics WHERE touched = 0;');
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
  touched: number;
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
    touched: row.touched === 1,
  };
}

interface RawSuggestionRow {
  id: string;
  record_id: string;
  entry_id: string;
  detail: string;
  fields: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  reason: string;
  status: MetricUpdateSuggestion['status'];
  suggested_at: string;
  decided_at: string | null;
}

function suggestionFromRaw(row: RawSuggestionRow): MetricUpdateSuggestion {
  return {
    id: row.id,
    recordId: row.record_id,
    entryId: row.entry_id,
    detail: row.detail,
    fields: JSON.parse(row.fields) as Record<string, string | number | null>,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    reason: row.reason,
    status: row.status,
    suggestedAt: row.suggested_at,
    decidedAt: row.decided_at,
  };
}

/** `YYYY-MM-DD`, UTC — a fixed, deterministic day boundary rather than the
 * server's local timezone, so a sparkline's day buckets never shift
 * depending on where this process happens to run. */
function toUtcDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}
