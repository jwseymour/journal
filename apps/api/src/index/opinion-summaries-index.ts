import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Layer 2 of the opinion model (`plan.md` M8, `requirements.md` §5.2) — a
 * cited, per-subject summary regenerated from every current statement on
 * that subject. A seventh table in the same shared `index.db`
 * (`requirements.md` §6.4). Never itself hand-edited (§9): a wrong part is
 * fixed by correcting or discarding the statement it cites and
 * re-running `reprocess`, which replaces every subject's summary from
 * scratch, same as everything else derived (§6.4).
 *
 * One row per part rather than one row per subject with a JSON blob of
 * parts — each part still needs its own `sourceStatementIds`, and a flat
 * table keeps that a plain column instead of nested JSON-in-JSON. Reads are
 * always "every part for this subject," so nothing here needs a join.
 */

export interface OpinionSummaryPartRecord {
  id: string;
  subject: string;
  partIndex: number;
  text: string;
  /** The statement ids this part draws from — checked against the real,
   * currently-known statements by `OpinionSummarizer` before ever reaching
   * this table. */
  sourceStatementIds: string[];
  /** The entries those statements link to, resolved and stored here at
   * generation time so a read never needs a join back to
   * `opinion_statements` (`requirements.md` §7.1 — resolved once, behind
   * the API, not on every request). */
  sourceEntryIds: string[];
  generatedAt: string;
}

/** Same shape as `MetricsReader` — the seam `http/app.ts` depends on. Read
 * only: nothing here is corrected directly, only regenerated wholesale. */
export interface OpinionSummariesReader {
  list(subject?: string): OpinionSummaryPartRecord[];
  subjects(): string[];
}

export class OpinionSummariesIndex implements OpinionSummariesReader {
  readonly #db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.#db = new Database(dbPath);
    this.#db.pragma('journal_mode = WAL');
    this.#migrate();
  }

  #migrate(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS opinion_summary_parts (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        part_index INTEGER NOT NULL,
        text TEXT NOT NULL,
        source_statement_ids TEXT NOT NULL,
        source_entry_ids TEXT NOT NULL,
        generated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS opinion_summary_parts_subject ON opinion_summary_parts (subject, part_index);
    `);
  }

  /** Replaces every part belonging to `subject` — always the full summary,
   * never a partial update, the same reasoning as
   * `MetricsIndex.replaceEntry`: a regenerated summary can change which
   * part is which without there being a cheap way to tell old parts from
   * new ones. */
  replaceSubject(subject: string, parts: Omit<OpinionSummaryPartRecord, 'subject'>[]): void {
    const insert = this.#db.transaction(() => {
      this.#db.prepare('DELETE FROM opinion_summary_parts WHERE subject = ?').run(subject);
      const stmt = this.#db.prepare(
        `INSERT INTO opinion_summary_parts
           (id, subject, part_index, text, source_statement_ids, source_entry_ids, generated_at)
         VALUES (@id, @subject, @partIndex, @text, @sourceStatementIds, @sourceEntryIds, @generatedAt)`,
      );
      for (const part of parts) {
        stmt.run({
          id: part.id,
          subject,
          partIndex: part.partIndex,
          text: part.text,
          sourceStatementIds: JSON.stringify(part.sourceStatementIds),
          sourceEntryIds: JSON.stringify(part.sourceEntryIds),
          generatedAt: part.generatedAt,
        });
      }
    });
    insert();
  }

  removeSubject(subject: string): void {
    this.#db.prepare('DELETE FROM opinion_summary_parts WHERE subject = ?').run(subject);
  }

  list(subject?: string): OpinionSummaryPartRecord[] {
    const rows = (
      subject
        ? this.#db
            .prepare('SELECT * FROM opinion_summary_parts WHERE subject = ? ORDER BY part_index ASC')
            .all(subject)
        : this.#db.prepare('SELECT * FROM opinion_summary_parts ORDER BY subject, part_index ASC').all()
    ) as RawRow[];
    return rows.map(fromRaw);
  }

  subjects(): string[] {
    const rows = this.#db
      .prepare('SELECT DISTINCT subject FROM opinion_summary_parts ORDER BY subject')
      .all() as { subject: string }[];
    return rows.map((r) => r.subject);
  }

  stats(): { subjectCount: number; partCount: number } {
    const partCount = (
      this.#db.prepare('SELECT COUNT(*) AS n FROM opinion_summary_parts').get() as { n: number }
    ).n;
    const subjectCount = this.subjects().length;
    return { subjectCount, partCount };
  }

  clear(): void {
    this.#db.exec('DELETE FROM opinion_summary_parts;');
  }

  close(): void {
    this.#db.close();
  }
}

interface RawRow {
  id: string;
  subject: string;
  part_index: number;
  text: string;
  source_statement_ids: string;
  source_entry_ids: string;
  generated_at: string;
}

function fromRaw(row: RawRow): OpinionSummaryPartRecord {
  return {
    id: row.id,
    subject: row.subject,
    partIndex: row.part_index,
    text: row.text,
    sourceStatementIds: JSON.parse(row.source_statement_ids) as string[],
    sourceEntryIds: JSON.parse(row.source_entry_ids) as string[],
    generatedAt: row.generated_at,
  };
}
