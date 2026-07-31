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
}

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
  remove(id: string): void;
  summarize(approvedTypes: readonly string[]): ListTypeSummary[];
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
    `);
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

  removeEntry(entryId: string): void {
    this.#db.prepare('DELETE FROM list_items WHERE entry_id = ?').run(entryId);
  }

  /** Discard one wrong record (`requirements.md` §6.2). */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM list_items WHERE id = ?').run(id);
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

  stats(): { itemCount: number } {
    const itemCount = (this.#db.prepare('SELECT COUNT(*) AS n FROM list_items').get() as { n: number }).n;
    return { itemCount };
  }

  clear(): void {
    this.#db.exec('DELETE FROM list_items;');
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
  };
}
