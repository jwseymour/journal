import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * "Has this entry been processed, and is it still current" (`plan.md` M18)
 * — a ninth small table in the same shared `index.db`, kept deliberately
 * separate from `SqliteIndex` even though both are keyed by entry id.
 * `SqliteIndex`'s own doc comment is explicit that everything there is a
 * pure, disposable re-derivation of a fresh directory walk, wiped and
 * rebuilt wholesale by `rebuild()` — this table is not that: whether an
 * entry has been processed is a fact about a review action taken, not
 * something a re-parse of the markdown file could ever reproduce. Losing
 * this table (e.g. `rm index.db`) is harmless in the way losing touched
 * records is not — every row resets to "never processed," a safe, honest
 * state, never silent data loss — but it is still a materially different
 * kind of fact from anything `SqliteIndex` tracks, so it gets its own file
 * rather than a bolted-on column, the same "one file, one concern" shape
 * `VisibilityDefaultsIndex`/`PublishedIndex`/`CategoriesIndex` already use.
 */

export interface EntryProcessingStatusRow {
  entryId: string;
  lastProcessedContentHash: string;
  lastProcessedAt: string;
}

export interface EntryProcessingStatusReader {
  get(entryId: string): EntryProcessingStatusRow | null;
  /** Upsert — called once a live Process run completes (`plan.md` M18),
   * regardless of how many pending items it produced or how many of a
   * prior run's items are still undecided. "Processed" means "a run
   * happened," not "everything it proposed was approved." */
  recordProcessed(entryId: string, contentHash: string, now: string): void;
  removeEntry(entryId: string): void;
}

export class EntryProcessingStatusIndex implements EntryProcessingStatusReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS entry_processing_status (
        entry_id TEXT PRIMARY KEY,
        last_processed_content_hash TEXT NOT NULL,
        last_processed_at TEXT NOT NULL
      );
    `);
  }

  get(entryId: string): EntryProcessingStatusRow | null {
    const row = this.#db.prepare('SELECT * FROM entry_processing_status WHERE entry_id = ?').get(entryId) as RawRow | undefined;
    return row ? fromRaw(row) : null;
  }

  recordProcessed(entryId: string, contentHash: string, now: string): void {
    this.#db
      .prepare(
        `INSERT INTO entry_processing_status (entry_id, last_processed_content_hash, last_processed_at)
         VALUES (@entryId, @contentHash, @now)
         ON CONFLICT (entry_id) DO UPDATE SET last_processed_content_hash = @contentHash, last_processed_at = @now`,
      )
      .run({ entryId, contentHash, now });
  }

  removeEntry(entryId: string): void {
    this.#db.prepare('DELETE FROM entry_processing_status WHERE entry_id = ?').run(entryId);
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  entry_id: string;
  last_processed_content_hash: string;
  last_processed_at: string;
}

function fromRaw(row: RawRow): EntryProcessingStatusRow {
  return {
    entryId: row.entry_id,
    lastProcessedContentHash: row.last_processed_content_hash,
    lastProcessedAt: row.last_processed_at,
  };
}
