import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Layer 1 of the opinion model (`plan.md` M8, `requirements.md` §5.2) — one
 * statement per entry per subject, the same shape as `MetricsIndex`: a
 * sixth table in the same shared `index.db` (`requirements.md` §6.4), every
 * row linking back to the entry it came from, corrected by discarding, never
 * hand-edited (§9).
 *
 * `OpinionSummarizer` reads this table (via `bySubject`) to build the
 * regenerated, cited per-subject summary (layer 2) — nothing here is
 * itself a summary.
 */

export interface OpinionStatementRecord {
  id: string;
  entryId: string;
  subject: string;
  statement: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  extractedAt: string;
}

export interface ListOpinionStatementsOptions {
  subject?: string;
  limit: number;
}

/** Same shape as `MetricsReader` — the seam `http/app.ts` depends on. */
export interface OpinionStatementsReader {
  list(options: ListOpinionStatementsOptions): OpinionStatementRecord[];
  remove(id: string): void;
}

export class OpinionStatementsIndex implements OpinionStatementsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS opinion_statements (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        statement TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        extracted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS opinion_statements_entry ON opinion_statements (entry_id);
      CREATE INDEX IF NOT EXISTS opinion_statements_subject ON opinion_statements (subject, event_epoch_ms);
    `);
  }

  /** Always the full set for an entry — see `MetricsIndex.replaceEntry` for
   * why a partial update is never the right shape here. */
  replaceEntry(entryId: string, records: Omit<OpinionStatementRecord, 'entryId'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM opinion_statements WHERE entry_id = ?').run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO opinion_statements
           (id, entry_id, subject, statement, event_time, event_epoch_ms, event_time_explicit, extracted_at)
         VALUES (@id, @entryId, @subject, @statement, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          subject: record.subject,
          statement: record.statement,
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
    this.#db.prepare('DELETE FROM opinion_statements WHERE entry_id = ?').run(entryId);
  }

  /** Discard one wrong statement (`requirements.md` §6.2). Any summary part
   * citing it is left stale until the next `reprocess` regenerates
   * summaries — a summary is a derived view, never itself hand-corrected. */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM opinion_statements WHERE id = ?').run(id);
  }

  list(options: ListOpinionStatementsOptions): OpinionStatementRecord[] {
    const rows = (
      options.subject
        ? this.#db
            .prepare('SELECT * FROM opinion_statements WHERE subject = ? ORDER BY event_epoch_ms DESC LIMIT ?')
            .all(options.subject, options.limit)
        : this.#db
            .prepare('SELECT * FROM opinion_statements ORDER BY event_epoch_ms DESC LIMIT ?')
            .all(options.limit)
    ) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Every current statement for one subject, oldest first — what the
   * summariser reads to build a cited summary. Unbounded (not paginated):
   * the summariser needs the true complete set, not a page of it. */
  bySubject(subject: string): OpinionStatementRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM opinion_statements WHERE subject = ? ORDER BY event_epoch_ms ASC')
      .all(subject) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Every subject with at least one statement — what `reprocess` iterates
   * to know which summaries need regenerating. */
  subjectsWithStatements(): string[] {
    const rows = this.#db
      .prepare('SELECT DISTINCT subject FROM opinion_statements ORDER BY subject')
      .all() as { subject: string }[];
    return rows.map((r) => r.subject);
  }

  stats(): { statementCount: number } {
    const statementCount = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM opinion_statements').get() as { n: number }
    ).n;
    return { statementCount };
  }

  clear(): void {
    this.#db.exec('DELETE FROM opinion_statements;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  entry_id: string;
  subject: string;
  statement: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  extracted_at: string;
}

function fromRaw(row: RawRow): OpinionStatementRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    subject: row.subject,
    statement: row.statement,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    extractedAt: row.extracted_at,
  };
}
