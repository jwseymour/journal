import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Open questions (`plan.md` M8c, `requirements.md` §5.2's spirit extended to
 * a new shape) — an eighth table in the same shared `index.db`
 * (`requirements.md` §6.4). Unlike every earlier structure, `entry_id` here
 * means one specific thing — the entry that *raised* the question — and a
 * row's `resolved_entry_id`/`resolution` may be filled in later by a
 * different entry entirely, in place, without disturbing which entry raised
 * it.
 *
 * That is why this file has no `replaceEntry`: replacing "everything tied
 * to this entry" would be ambiguous here in a way it never is for reviews,
 * lists, or opinions. `replaceRaised` only ever touches rows this entry
 * raised; `resolve` only ever touches the resolution fields of a row raised
 * by someone else.
 */

export type QuestionStatus = 'open' | 'resolved';

export interface QuestionRecord {
  id: string;
  /** The entry that raised this question — never changes once written. */
  entryId: string;
  question: string;
  eventTime: string;
  eventEpochMs: number;
  eventTimeExplicit: boolean;
  extractedAt: string;
  status: QuestionStatus;
  /** The entry that resolved it, or `null` while still open. */
  resolvedEntryId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
}

export interface ListQuestionsOptions {
  status?: QuestionStatus;
  limit: number;
}

export interface QuestionsSummary {
  openCount: number;
  resolvedCount: number;
}

/** Same shape as `MetricsReader` — the seam `http/app.ts` depends on. */
export interface QuestionsReader {
  list(options: ListQuestionsOptions): QuestionRecord[];
  remove(id: string): void;
  reopen(id: string): void;
  summarize(): QuestionsSummary;
}

export class QuestionsIndex implements QuestionsReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
        entry_id TEXT NOT NULL,
        question TEXT NOT NULL,
        event_time TEXT NOT NULL,
        event_epoch_ms INTEGER NOT NULL,
        event_time_explicit INTEGER NOT NULL,
        extracted_at TEXT NOT NULL,
        status TEXT NOT NULL,
        resolved_entry_id TEXT,
        resolution TEXT,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS questions_entry ON questions (entry_id);
      CREATE INDEX IF NOT EXISTS questions_status ON questions (status, event_epoch_ms DESC);
    `);
  }

  /** Replaces only the still-*open* questions raised by this entry. A
   * question this entry raised that has since been resolved by a later
   * entry is left alone rather than deleted-and-reinserted-fresh: it is
   * settled history now, and `entry_id` still meaning "raised by" must not
   * become a way for the raiser to accidentally undo someone else's
   * resolution of it. */
  replaceRaised(entryId: string, records: Omit<QuestionRecord, 'entryId'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM questions WHERE entry_id = ? AND status = 'open'").run(entryId);
      const stmt = this.#db.prepare(
        `INSERT INTO questions
           (id, entry_id, question, event_time, event_epoch_ms, event_time_explicit, extracted_at, status, resolved_entry_id, resolution, resolved_at)
         VALUES (@id, @entryId, @question, @eventTime, @eventEpochMs, @eventTimeExplicit, @extractedAt, @status, @resolvedEntryId, @resolution, @resolvedAt)`,
      );
      for (const record of records) {
        stmt.run({
          id: record.id,
          entryId,
          question: record.question,
          eventTime: record.eventTime,
          eventEpochMs: record.eventEpochMs,
          eventTimeExplicit: record.eventTimeExplicit ? 1 : 0,
          extractedAt: record.extractedAt,
          status: record.status,
          resolvedEntryId: record.resolvedEntryId,
          resolution: record.resolution,
          resolvedAt: record.resolvedAt,
        });
      }
    });
    insert();
  }

  /** Marks an open question resolved by a later entry — an update in place,
   * not a replace: the row still belongs, by `entry_id`, to whichever entry
   * originally raised it. A no-op if `id` is not currently open. */
  resolve(id: string, resolution: { resolvedEntryId: string; resolution: string; resolvedAt: string }): void {
    this.#db
      .prepare(
        `UPDATE questions
           SET status = 'resolved', resolved_entry_id = @resolvedEntryId, resolution = @resolution, resolved_at = @resolvedAt
         WHERE id = @id AND status = 'open'`,
      )
      .run({ id, ...resolution });
  }

  /** Reverts a resolution without discarding the question itself — for when
   * the *match* was wrong, not the original question (`requirements.md`
   * §6.2). */
  reopen(id: string): void {
    this.#db
      .prepare(
        `UPDATE questions SET status = 'open', resolved_entry_id = NULL, resolution = NULL, resolved_at = NULL WHERE id = ?`,
      )
      .run(id);
  }

  /** An entry disappearing removes whatever it raised, and reopens whatever
   * it had resolved — a resolution cannot outlive the entry that made it any
   * more than a review outlives the entry that wrote it. */
  removeEntry(entryId: string): void {
    const apply = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM questions WHERE entry_id = ?').run(entryId);
      this.#db
        .prepare(
          `UPDATE questions SET status = 'open', resolved_entry_id = NULL, resolution = NULL, resolved_at = NULL WHERE resolved_entry_id = ?`,
        )
        .run(entryId);
    });
    apply();
  }

  /** Discard one wrong record entirely (`requirements.md` §6.2). */
  remove(id: string): void {
    this.#db.prepare('DELETE FROM questions WHERE id = ?').run(id);
  }

  list(options: ListQuestionsOptions): QuestionRecord[] {
    const rows = (
      options.status
        ? this.#db
            .prepare('SELECT * FROM questions WHERE status = ? ORDER BY event_epoch_ms DESC LIMIT ?')
            .all(options.status, options.limit)
        : this.#db.prepare('SELECT * FROM questions ORDER BY event_epoch_ms DESC LIMIT ?').all(options.limit)
    ) as RawRow[];
    return rows.map(fromRaw);
  }

  /** Every currently open question, oldest first — what a new entry's
   * resolution check is matched against. Unbounded, same reasoning as
   * `OpinionStatementsIndex.bySubject`: the extractor needs the true
   * complete open set, not a page of it. */
  listOpen(): QuestionRecord[] {
    const rows = this.#db
      .prepare("SELECT * FROM questions WHERE status = 'open' ORDER BY event_epoch_ms ASC")
      .all() as RawRow[];
    return rows.map(fromRaw);
  }

  summarize(): QuestionsSummary {
    const openCount = (
      this.#db.prepare("SELECT COUNT(*) AS n FROM questions WHERE status = 'open'").get() as { n: number }
    ).n;
    const resolvedCount = (
      this.#db.prepare("SELECT COUNT(*) AS n FROM questions WHERE status = 'resolved'").get() as { n: number }
    ).n;
    return { openCount, resolvedCount };
  }

  stats(): { questionCount: number; openCount: number; resolvedCount: number } {
    const questionCount = (this.#db.prepare('SELECT COUNT(*) AS n FROM questions').get() as { n: number }).n;
    const { openCount, resolvedCount } = this.summarize();
    return { questionCount, openCount, resolvedCount };
  }

  clear(): void {
    this.#db.exec('DELETE FROM questions;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  entry_id: string;
  question: string;
  event_time: string;
  event_epoch_ms: number;
  event_time_explicit: number;
  extracted_at: string;
  status: QuestionStatus;
  resolved_entry_id: string | null;
  resolution: string | null;
  resolved_at: string | null;
}

function fromRaw(row: RawRow): QuestionRecord {
  return {
    id: row.id,
    entryId: row.entry_id,
    question: row.question,
    eventTime: row.event_time,
    eventEpochMs: row.event_epoch_ms,
    eventTimeExplicit: row.event_time_explicit === 1,
    extractedAt: row.extracted_at,
    status: row.status,
    resolvedEntryId: row.resolved_entry_id,
    resolution: row.resolution,
    resolvedAt: row.resolved_at,
  };
}
