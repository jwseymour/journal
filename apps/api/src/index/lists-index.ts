import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Extracted atomic list items (`plan.md` M8, `requirements.md` §5.2) — a
 * fifth table in the same shared `index.db` (`requirements.md` §6.4).
 * "Atomic" here means the record IS the thing, not a summary of it — for a
 * quote, `text` is its exact words.
 */

export interface ListItemRecord {
  id: string;
  entryId: string;
  listType: string;
  text: string;
  context: string;
  /** 1–5, or `null` if nothing in the entry signalled particular
   * significance — never inferred from topic alone. This is the only
   * importance-related value ever stored; any decay against it is computed
   * fresh at read time (`rankByImportance` below), never persisted. */
  importance: number | null;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  extractedAt: string;
  /** Whether the user has reviewed, corrected, or edited this record
   * (`requirements.md` §2, §6.4, `plan.md` M10). */
  touched: boolean;
}

/** The editable subset — everything except `id`, `entryId`, `listType` (an
 * approved category, not free content), and `touched` itself. */
export interface UpdateListItemInput {
  // See `UpdateMetricInput`'s comment for why `| undefined` is explicit.
  text?: string | undefined;
  context?: string | undefined;
  importance?: number | null | undefined;
  eventTime?: string | undefined;
  eventTimeExplicit?: boolean | undefined;
}

export interface ListItemUpdateSuggestion {
  id: string;
  recordId: string;
  entryId: string;
  text: string;
  context: string;
  importance: number | null;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  suggestedAt: string;
  decidedAt: string | null;
}

export type ProposeListItemUpdateInput = Omit<
  ListItemUpdateSuggestion,
  'id' | 'status' | 'suggestedAt' | 'decidedAt'
> & { id: string; now: string };

export interface ListItemsOptions {
  listType?: string;
  limit: number;
  /** `'recent'` (default) is a plain reverse-chronological read. `'importance'`
   * ranks by `rankByImportance` instead — still just a read-time sort, never
   * anything written back to the row. */
  orderBy?: 'recent' | 'importance';
  /** Only used by `orderBy: 'importance'` — the instant "now" is measured
   * from, so ranking is deterministic in tests. Defaults to `Date.now()`. */
  now?: number;
}

/**
 * A fixed, read-time-only formula combining a list item's static
 * `importance` with its age — no decay rate is ever stored per item, so
 * there is nothing beyond the one static value for anything to "interact
 * with" in the derived layer.
 *
 * A one-year half-life: an item rated 5 outranks a brand-new item rated 1
 * for roughly two years before recency overtakes it. `importance ?? 1`
 * treats an unrated item as the lowest rung rather than excluding it, so it
 * still appears, ranked among its peers by recency alone.
 */
const IMPORTANCE_HALF_LIFE_DAYS = 365;

export function rankByImportance(importance: number | null, eventEpochMs: number, now: number): number {
  const ageDays = Math.max(0, (now - eventEpochMs) / 86_400_000);
  return (importance ?? 1) * 2 ** (-ageDays / IMPORTANCE_HALF_LIFE_DAYS);
}

/** The aggregation an analysis surface needs (`plan.md` M8, `design.md`
 * §5.3), computed here rather than in the frontend (`requirements.md`
 * §7.1). */
export interface ListTypeSummary {
  listType: string;
  count: number;
}

/** Same shape as `MetricsReader`/`ReviewsReader` — the seam `http/app.ts`
 * depends on. */
export interface ListItemsReader {
  list(options: ListItemsOptions): ListItemRecord[];
  /** One record by id, or `null` — see `MetricsReader.getById` (`plan.md` M16). */
  getById(id: string): ListItemRecord | null;
  /** Every record for one list type, unbounded — see `MetricsReader.allByMetric` (`plan.md` M16). */
  allByListType(listType: string): ListItemRecord[];
  remove(id: string): void;
  summarize(approvedTypes: readonly string[]): ListTypeSummary[];
  update(id: string, input: UpdateListItemInput, now: string): ListItemRecord | null;
  validate(id: string, now: string): void;
  untouch(id: string, now: string): void;
  listUpdateSuggestions(options?: { status?: ListItemUpdateSuggestion['status'] }): ListItemUpdateSuggestion[];
  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void;
  /** Every current row for one entry, touched or not (`plan.md` M18) — see
   * `MetricsReader.liveForEntry` for the full reasoning. */
  liveForEntry(entryId: string): ListItemRecord[];
  /** Commits an approved `'new'` pending item (`plan.md` M18) — see
   * `MetricsReader.insertApproved` for the full reasoning. */
  insertApproved(record: ListItemRecord): void;
}

export class ListsIndex implements ListItemsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS list_items (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        list_type TEXT NOT NULL,
        text TEXT NOT NULL,
        context TEXT NOT NULL,
        importance REAL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        extracted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS list_items_entry ON list_items (entry_id);
      CREATE INDEX IF NOT EXISTS list_items_order ON list_items (list_type, event_epoch_ms DESC);

      CREATE TABLE IF NOT EXISTS list_item_update_suggestions (
        id TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        text TEXT NOT NULL,
        context TEXT NOT NULL,
        importance REAL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        suggested_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS list_item_update_suggestions_status ON list_item_update_suggestions (status);
    `);

    const columns = this.#db.prepare('PRAGMA table_info(list_items)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'touched')) {
      this.#db.exec('ALTER TABLE list_items ADD COLUMN touched INTEGER NOT NULL DEFAULT 0;');
    }
  }

  replaceEntry(entryId: string, records: Omit<ListItemRecord, 'entryId'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM list_items WHERE entry_id = ?').run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO list_items
           (id, entry_id, list_type, text, context, importance, event_time, event_epoch_ms, event_time_explicit, extracted_at)
         VALUES (@id, @entryId, @listType, @text, @context, @importance, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          listType: record.listType,
          text: record.text,
          context: record.context,
          importance: record.importance,
          eventTime: record.eventTime,
          eventEpochMs: record.eventEpochMs,
          eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
          extractedAt: record.extractedAt,
        });
      }
    });
    insert();
  }

  /** The reprocess-safe sibling of `replaceEntry` (`plan.md` M10). */
  replaceUntouchedForEntry(entryId: string, records: Omit<ListItemRecord, 'entryId' | 'touched'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM list_items WHERE entry_id = ? AND touched = 0').run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO list_items
           (id, entry_id, list_type, text, context, importance, event_time, event_epoch_ms, event_time_explicit, extracted_at, touched)
         VALUES (@id, @entryId, @listType, @text, @context, @importance, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, 0)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          listType: record.listType,
          text: record.text,
          context: record.context,
          importance: record.importance,
          eventTime: record.eventTime,
          eventEpochMs: record.eventEpochMs,
          eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
          extractedAt: record.extractedAt,
        });
      }
    });
    insert();
  }

  touchedForEntry(entryId: string): ListItemRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM list_items WHERE entry_id = ? AND touched = 1')
      .all(entryId) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Every current row for one entry, touched or not (`plan.md` M18) — see
   * `MetricsIndex.liveForEntry` for the full reasoning. */
  liveForEntry(entryId: string): ListItemRecord[] {
    const rows = this.#db.prepare('SELECT * FROM list_items WHERE entry_id = ?').all(entryId) as RawRow[];
    return rows.map(fromRaw);
  }

  removeEntry(entryId: string): void {
    this.#db.prepare('DELETE FROM list_items WHERE entry_id = ?').run(entryId);
  }

  getById(id: string): ListItemRecord | null {
    const row = this.#db.prepare('SELECT * FROM list_items WHERE id = ?').get(id) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  allByListType(listType: string): ListItemRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM list_items WHERE list_type = ? ORDER BY event_epoch_ms DESC')
      .all(listType) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Discard one wrong record (`requirements.md` §6.2). */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM list_items WHERE id = ?').run(id);
  }

  update(id: string, input: UpdateListItemInput, _now: string): ListItemRecord | null {
    const existing = this.#db.prepare('SELECT * FROM list_items WHERE id = ?').get(id) as RawRow | undefined;
    if (!existing) return null;

    const eventTimeExplicit = input.eventTimeExplicit ?? existing.event_time_explicit === 1;
    const next: RawRow = {
      ...existing,
      text: input.text ?? existing.text,
      context: input.context ?? existing.context,
      importance: input.importance === undefined ? existing.importance : input.importance,
      event_time: input.eventTime ?? existing.event_time,
      event_epoch_ms: input.eventTime ? Date.parse(input.eventTime) : existing.event_epoch_ms,
      event_time_explicit: eventTimeExplicit ? 1 : 0,
      touched: 1,
    };
    this.#db
      .prepare(
        `UPDATE list_items
           SET text = @text, context = @context, importance = @importance,
               event_time = @event_time, event_epoch_ms = @event_epoch_ms,
               event_time_explicit = @event_time_explicit, touched = 1
         WHERE id = @id`,
      )
      .run(next);
    return fromRaw(next);
  }

  validate(id: string, _now: string): void {
    this.#db.prepare('UPDATE list_items SET touched = 1 WHERE id = ?').run(id);
  }

  untouch(id: string, _now: string): void {
    this.#db.prepare('UPDATE list_items SET touched = 0 WHERE id = ?').run(id);
  }

  proposeUpdate(input: ProposeListItemUpdateInput): void {
    const alreadyPending = this.#db
      .prepare("SELECT 1 FROM list_item_update_suggestions WHERE record_id = ? AND status = 'pending'")
      .get(input.recordId);
    if (alreadyPending) return;

    this.#db
      .prepare(
        `INSERT INTO list_item_update_suggestions
           (id, record_id, entry_id, text, context, importance, event_time, event_epoch_ms, event_time_explicit, reason, status, suggested_at, decided_at)
         VALUES (@id, @recordId, @entryId, @text, @context, @importance, @eventTime, @eventEpochMs, @eventTimeExplicit, @reason, 'pending', @now, NULL)`,
      )
      .run({ ...input, eventTimeExplicit: input.eventTimeExplicit ? 1 : 0 });
  }

  listUpdateSuggestions(options: { status?: ListItemUpdateSuggestion['status'] } = {}): ListItemUpdateSuggestion[] {
    const rows = (
      options.status
        ? this.#db
            .prepare('SELECT * FROM list_item_update_suggestions WHERE status = ? ORDER BY suggested_at DESC')
            .all(options.status)
        : this.#db.prepare('SELECT * FROM list_item_update_suggestions ORDER BY suggested_at DESC').all()
    ) as RawSuggestionRow[];
    return rows.map(suggestionFromRaw);
  }

  decideUpdate(id: string, decision: 'approved' | 'rejected', now: string): void {
    const apply = this.#db.transaction(() => {
      const row = this.#db
        .prepare("SELECT * FROM list_item_update_suggestions WHERE id = ? AND status = 'pending'")
        .get(id) as RawSuggestionRow | undefined;
      if (!row) return;

      this.#db
        .prepare('UPDATE list_item_update_suggestions SET status = ?, decided_at = ? WHERE id = ?')
        .run(decision, now, id);

      if (decision === 'approved') {
        this.update(row.record_id, {
          text: row.text,
          context: row.context,
          importance: row.importance,
          eventTime: row.event_time,
          eventTimeExplicit: row.event_time_explicit === 1,
        }, now);
      }
    });
    apply();
  }

  list(options: ListItemsOptions): ListItemRecord[] {
    if (options.orderBy === 'importance') {
      const rows = (
        options.listType
          ? this.#db.prepare('SELECT * FROM list_items WHERE list_type = ?').all(options.listType)
          : this.#db.prepare('SELECT * FROM list_items').all()
      ) as RawRow[];
      const now = options.now ?? Date.now();
      return rows
        .map(fromRaw)
        .map((record) => ({ record, score: rankByImportance(record.importance, record.eventEpochMs, now) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, options.limit)
        .map(({ record }) => record);
    }

    const rows = (
      options.listType
        ? this.#db
            .prepare('SELECT * FROM list_items WHERE list_type = ? ORDER BY event_epoch_ms DESC LIMIT ?')
            .all(options.listType, options.limit)
        : this.#db.prepare('SELECT * FROM list_items ORDER BY event_epoch_ms DESC LIMIT ?').all(options.limit)
    ) as RawRow[];
    return rows.map(fromRaw);
  }

  /** One `ListTypeSummary` per approved type, in the order given, so a type
   * with zero items still gets its own row. */
  summarize(approvedTypes: readonly string[]): ListTypeSummary[] {
    const stmt = this.#db.prepare('SELECT COUNT(*) AS n FROM list_items WHERE list_type = ?');
    return approvedTypes.map((listType) => ({ listType, count: (stmt.get(listType) as { n: number }).n }));
  }

  /** Commits an approved `'new'` pending item (`plan.md` M18) — see
   * `MetricsIndex.insertApproved` for the full reasoning; identical shape
   * here. */
  insertApproved(record: ListItemRecord): void {
    this.#db
      .prepare(
        `INSERT INTO list_items
           (id, entry_id, list_type, text, context, importance, event_time, event_epoch_ms, event_time_explicit, extracted_at, touched)
         VALUES (@id, @entryId, @listType, @text, @context, @importance, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, @touched)`,
      )
      .run({
        id: record.id,
        entryId: record.entryId,
        listType: record.listType,
        text: record.text,
        context: record.context,
        importance: record.importance,
        eventTime: record.eventTime,
        eventEpochMs: record.eventEpochMs,
        eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
        extractedAt: record.extractedAt,
        touched: record.touched ? 1 : 0,
      });
  }

  /** Restores one touched record from the durable off-index mirror
   * (`durable/touched-mirror.ts`) — see `MetricsIndex.restoreTouched` for
   * the full reasoning; identical shape here. */
  restoreTouched(record: ListItemRecord): void {
    this.#db
      .prepare(
        `INSERT OR REPLACE INTO list_items
           (id, entry_id, list_type, text, context, importance, event_time, event_epoch_ms, event_time_explicit, extracted_at, touched)
         VALUES (@id, @entryId, @listType, @text, @context, @importance, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, 1)`,
      )
      .run({
        id: record.id,
        entryId: record.entryId,
        listType: record.listType,
        text: record.text,
        context: record.context,
        importance: record.importance,
        eventTime: record.eventTime,
        eventEpochMs: record.eventEpochMs,
        eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
        extractedAt: record.extractedAt,
      });
  }

  stats(): { itemCount: number } {
    const itemCount = (this.#db.prepare('SELECT COUNT(*) AS n FROM list_items').get() as { n: number }).n;
    return { itemCount };
  }

  clear(): void {
    this.#db.exec('DELETE FROM list_items;');
  }

  /** Reprocess-from-scratch entry point since M10 — wipes only untouched
   * rows (`requirements.md` §6.4). */
  clearUntouched(): void {
    this.#db.exec('DELETE FROM list_items WHERE touched = 0;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  entry_id: string;
  list_type: string;
  text: string;
  context: string;
  importance: number | null;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  extracted_at: string;
  touched: number;
}

function fromRaw(row: RawRow): ListItemRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    listType: row.list_type,
    text: row.text,
    context: row.context,
    importance: row.importance,
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
  text: string;
  context: string;
  importance: number | null;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  reason: string;
  status: ListItemUpdateSuggestion['status'];
  suggested_at: string;
  decided_at: string | null;
}

function suggestionFromRaw(row: RawSuggestionRow): ListItemUpdateSuggestion {
  return {
    id: row.id,
    recordId: row.record_id,
    entryId: row.entry_id,
    text: row.text,
    context: row.context,
    importance: row.importance,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    reason: row.reason,
    status: row.status,
    suggestedAt: row.suggested_at,
    decidedAt: row.decided_at,
  };
}
